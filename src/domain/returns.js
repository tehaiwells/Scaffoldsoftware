// @ts-check
// Back & counted, with a resolution for every missing piece (ADR 0010, audit #4 and H3). Mixed into Simulation.prototype.
//   returnCount       the yard counts a return that came back with "count later" (pieces truck -> yard, per product)
//   returnResolve     every piece a trip did not bring back gets exactly one outcome: STILL_ON_SITE (back on the site's record, hire
//                     continues), LOST (gone; a charge line at the replacement value), DAMAGED (to the yard's quarantine container,
//                     which nothing ever picks from), OUR_LOSS (written off; the owner approves)
//   quarantineResolve damaged pieces later: REPAIRED (back to serviceable stock), SCRAPPED, or CHARGED (scrapped and charged)
//   siteFinish        one question when a site ends: "sent N · back M · K missing: charge, write off or still looking?"
//   productValue      the owner's replacement value per product (one, or a bulk list: the catalogue's CSV column)
// Charge lines are the append-only table charge_lines (migration 009): part 4's statements pick them up by site and period.
// The clock only flags (clockReturns): RETURN_SHORT when a return is not counted or not resolved by the end of its day.
import { randomUUID } from 'node:crypto';
import { requireRule, integer } from './geometry.js';
import { AppError } from '../service.js';
import { cached } from '../database.js';
import { requireLive } from './mode.js';
import { addDays } from './schedule.js';
import { DAY_END } from './plantime.js';
/** Office commands here (operations.manage; OUR_LOSS, WRITE_OFF and productValue need company.manage inside). @type {string[]} */
export const RETURN_OPS = ['returnResolve', 'quarantineResolve', 'siteFinish'];
export const OUTCOMES = ['STILL_ON_SITE', 'LOST', 'DAMAGED', 'OUR_LOSS'];
export const OUTCOME_WORDS = {
  STILL_ON_SITE: 'Still on site',
  LOST: 'Lost, charged',
  DAMAGED: 'Damaged, in quarantine',
  OUR_LOSS: 'Our loss, written off',
};
export const QUARANTINE_OUTCOMES = ['REPAIRED', 'SCRAPPED', 'CHARGED'];
export const FINISH_OUTCOMES = ['CHARGE', 'WRITE_OFF', 'STILL_LOOKING'];
/** @type {(ms:number)=>string} */
const iso = (ms) => new Date(ms).toISOString();
/** @type {(n:number,one:string,many?:string)=>string} */
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
/** @type {(v:unknown,name:string,max?:number)=>string|null} */
const optText = (v, name, max = 200) => {
  if (v === undefined || v === null) return null;
  requireRule(typeof v === 'string', name + ' must be text.');
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  requireRule(s.length <= max, name + ' can be at most ' + max + ' characters.');
  return s;
};
const add = (/** @type {Map<string,number>} */ m, /** @type {string} */ k, /** @type {number} */ n) =>
  m.set(k, (m.get(k) ?? 0) + n);
const NOT_RETIRED = "coalesce(json_extract(data,'$.retired'),0)=0";
const INSERT_CHARGE =
  'INSERT INTO charge_lines(id,company_id,site_id,customer_id,product_id,quantity,unit_value,amount,reason,source,occurred_at,recorded_at,actor,approved_by,command_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';

/** @type {Record<string,any> & ThisType<any>} */
export const returnsMethods = {
  // ---------- values ----------
  // The owner's replacement value per product, cents ex GST (company.manage). One product, or values: [{product, replacementValue}] in bulk.
  productValue(/** @type {any} */ input) {
    this.auth.require(this.user, 'company.manage');
    const list = Array.isArray(input?.values) ? input.values : [input ?? {}];
    requireRule(list.length > 0 && list.length <= 500, 'Give a product and its replacement value.');
    const done = [];
    for (const v of list) {
      const p = this.repo.get(v?.product, 'product');
      const value =
        v.replacementValue === null || v.replacementValue === undefined || v.replacementValue === ''
          ? null
          : integer(v.replacementValue, 'Replacement value (cents)', 0, 100000000);
      const settings = this.repo.all('productSettings').find((/** @type {any} */ s) => s.product === p.id);
      if (settings) this.repo.save({ ...settings, replacementValue: value });
      else
        this.repo.add('productSettings', {
          product: p.id,
          unitWeight: null,
          packQuantity: null,
          spannerSize: null,
          replacementValue: value,
          figures: false,
          reason: 'Replacement value',
          status: 'COMPANY CONFIGURED',
          actor: this.user.id,
        });
      this.repo.event(this.user.id, 'PRODUCT_OVERRIDE', {
        product: p.id,
        reason: 'Replacement value: ' + (value === null ? 'none' : '$' + (value / 100).toFixed(2) + ' a piece'),
        key: this.key,
      });
      done.push({ product: p.id, name: p.name, replacementValue: value });
    }
    return { values: done, message: plural(done.length, 'value') + ' saved.' };
  },
  /** @param {string} productId */
  replacementValueOf(productId) {
    try {
      return this.effective(productId).replacementValue ?? null;
    } catch {
      return null;
    }
  },
  // The value a charge line uses: the product's replacement value (the owner's, in the Materials catalogue), or a value typed on the line,
  // which is the owner's call too (company.manage) and is recorded with them as the approver. Never silent, never anyone else's number.
  /** @param {string} productId @param {any} typed */
  chargeValue(productId, typed) {
    if (this.chargeTyped(typed)) {
      requireRule(
        this.auth.permissions(this.user).includes('company.manage'),
        'Only the owner can type a value here. Ask them to set a replacement value in the Materials catalogue.',
      );
      return integer(typed, 'Value (cents)', 0, 100000000);
    }
    const v = this.replacementValueOf(productId);
    requireRule(
      v !== null,
      this.planName(productId, 'That part') +
        ' has no replacement value yet. Set one in the Materials catalogue (the owner), or the owner types a value on this line.',
    );
    return v;
  },
  /** @param {any} typed */
  chargeTyped(typed) {
    return typed !== undefined && typed !== null && typed !== '';
  },
  // ---------- charge lines ----------
  /** @param {{site:string,product:string,quantity:number,unitValue:number,reason:'LOST'|'DAMAGED'|'SITE_FINISH',source?:string|null,occurredAt?:string|null,approvedBy?:string|null}} c */
  chargeLine(c) {
    const id = randomUUID(),
      now = iso(this.planNow());
    let customer = null;
    try {
      customer = this.repo.get(c.site, 'site').customer ?? null; // the site's customer (ADR 0011); older lines resolve through the site
    } catch {}
    cached(this.db, INSERT_CHARGE).run(
      id,
      this.repo.company,
      c.site,
      customer,
      c.product,
      c.quantity,
      c.unitValue,
      c.quantity * c.unitValue,
      c.reason,
      c.source ?? null,
      c.occurredAt ?? now,
      now,
      this.user.id,
      c.approvedBy ?? null,
      this.key ?? randomUUID(),
    );
    return this.chargeLineView(cached(this.db, 'SELECT * FROM charge_lines WHERE id=?').get(id));
  },
  /** @param {any} r */
  chargeLineView(r) {
    return {
      id: r.id,
      site: r.site_id,
      siteName: this.planSiteName(r.site_id),
      customer: r.customer_id ?? null,
      customerName: r.customer_id ? this.customerName?.(r.customer_id) : null,
      product: r.product_id,
      name: this.planName(r.product_id, 'Material'),
      quantity: r.quantity,
      unitValue: r.unit_value,
      amount: r.amount,
      reason: r.reason,
      source: r.source ?? null,
      occurredAt: r.occurred_at,
      recordedAt: r.recorded_at,
      actor: r.actor,
      approvedBy: r.approved_by ?? null,
    };
  },
  // Charge lines of a site (or all), oldest first: what part 4's statements will pick up.
  /** @param {string|null} [siteId] */
  chargeLines(siteId = null) {
    return cached(
      this.db,
      'SELECT * FROM charge_lines WHERE company_id=? AND (? IS NULL OR site_id=?) ORDER BY sequence',
    )
      .all(this.repo.company, siteId, siteId)
      .map((/** @type {any} */ r) => this.chargeLineView(r));
  },
  // ---------- quarantine ----------
  // The yard's one quarantine container: damaged pieces wait here for repair, scrap or a charge. QUARANTINED, so no order, pick or
  // top-up ever takes from it (trips.js tripStockAt takes serviceable containers only). Keeps which site each lot came from.
  /** @param {string} yardId */
  quarantineContainer(yardId) {
    const found = this.tripRows(
      'container',
      NOT_RETIRED + " AND json_extract(data,'$.location')=? AND json_extract(data,'$.quarantine')=1",
      yardId,
    )[0];
    if (found) return found;
    const draft = {
      name: 'Quarantine',
      type: 'BUNDLE',
      model: 'Damaged pieces, waiting for repair, scrap or a charge',
      length: 2000,
      width: 1000,
      height: 500,
      envelopeLength: 2000,
      envelopeWidth: 1000,
      tare: 0,
      capacity: null,
      location: yardId,
      rotation: 0,
      support: null,
      condition: 'QUARANTINED',
      mode: 'LIVE',
      quarantine: true,
      lots: [],
    };
    return this.repo.add('container', { ...draft, ...this.tripSpot(draft, yardId) });
  },
  // ---------- counting a return that came back with "count later" ----------
  returnCount(/** @type {any} */ input) {
    requireLive(this);
    const trip = this.repo.get(input?.trip, 'trip'),
      tp = this.tripPlan(trip),
      now = this.planNow();
    requireRule(trip.state === 'RETURNED', 'This trip is not back at the yard yet.');
    requireRule(trip.countPending, 'This trip was counted when it came back.');
    requireRule(tp?.truck, 'This trip has no truck.');
    const onTruck = this.tripOnTruck(trip),
      want = this.tripInputLines(input, onTruck);
    for (const [p, q] of want)
      requireRule(
        q <= (onTruck.get(p) ?? 0),
        'Only ' + (onTruck.get(p) ?? 0) + ' ' + this.planName(p, 'of that') + ' came back on the truck for this trip.',
      );
    const picks = this.returnPicks(trip, tp.truck, want);
    const prov = this.repo.provenance;
    this.repo.provenance = {
      ...(prov ?? { kind: 'PERSON', onBehalfOf: null, origin: 'command:returnCount' }),
      occurredAt: iso(now),
    };
    try {
      this.tripMove(picks, tp.truck, trip.yard, 'RETURNED', trip);
    } finally {
      this.repo.provenance = prov;
    }
    const fresh = this.repo.get(trip.id, 'trip');
    this.tripSpread(fresh, want, 'returned');
    const left = this.tripOnTruck(fresh);
    fresh.countPending = false;
    fresh.count = {
      at: iso(now),
      by: this.user.id,
      byName: this.user.name ?? 'Someone',
      kind: this.user.crew ? 'PERSON' : 'OFFICE',
      lines: [...want].map(([product, quantity]) => ({ product, quantity })),
    };
    fresh.notBack = [...left].map(([product, quantity]) => ({ product, quantity }));
    const counted = [...want.values()].reduce((s, n) => s + n, 0),
      short = [...left.values()].reduce((s, n) => s + n, 0);
    // the fact changed: a flag that said "not counted" now says what is missing (a new item on Needs you; a dismissal of the old one lapses)
    if (!fresh.notBack.length) fresh.flag = null;
    else if (fresh.flag?.code === 'RETURN_SHORT')
      fresh.flag = { code: 'RETURN_SHORT', words: this.returnShortWords(fresh), since: iso(now) };
    this.repo.save(fresh);
    return {
      trip: this.tripView(fresh, { crew: !!this.user.crew }),
      message:
        'Counted back: ' +
        plural(counted, 'piece') +
        (short ? ' · ' + plural(short, 'piece') + ' not back. Say what happened to them.' : '. All there.'),
    };
  },
  /** The clock's words for a return still short. @param {any} t */
  returnShortWords(t) {
    const n = (t.notBack ?? []).reduce((/** @type {number} */ s, /** @type {any} */ l) => s + l.quantity, 0);
    return plural(n, 'piece') + ' not back from ' + this.planSiteName(t.site) + ': say what happened to them';
  },
  // The containers on the truck for this trip that hold pieces of each product, largest first (a whole container goes as it is).
  /** @param {any} trip @param {string} truckId @param {Map<string,number>} want */
  returnPicks(trip, truckId, want) {
    const picks = [];
    for (const [p, q] of want) {
      let left = q;
      const holders = this.tripRows(
        'container',
        NOT_RETIRED + " AND json_extract(data,'$.location')=? AND json_extract(data,'$.trip')=?",
        truckId,
        trip.id,
      )
        .map((/** @type {any} */ c) => ({ c, have: this.repo.quantity(c.id, p) }))
        .filter((/** @type {any} */ x) => x.have > 0)
        .sort(
          (/** @type {any} */ a, /** @type {any} */ b) =>
            b.have - a.have || String(a.c.name).localeCompare(String(b.c.name)),
        );
      for (const x of holders) {
        if (!left) break;
        const n = Math.min(left, x.have);
        picks.push({ container: x.c.id, product: p, quantity: n });
        left -= n;
      }
    }
    return picks;
  },
  // ---------- every missing piece gets one outcome ----------
  // lines: [{product, quantity, outcome, reason?, unitValue?}]. STILL_ON_SITE lines first: hire's transit record is per container, and once
  // a loss settles it nothing later can reopen the same lots. OUR_LOSS needs an approver (company.manage: the owner).
  returnResolve(/** @type {any} */ input) {
    requireLive(this);
    const trip = this.repo.get(input?.trip, 'trip'),
      tp = this.tripPlan(trip),
      now = this.planNow();
    requireRule(trip.state === 'RETURNED', 'This trip is not back at the yard yet.');
    requireRule(!trip.countPending, 'Count it first.');
    requireRule(tp?.truck, 'This trip has no truck.');
    requireRule(
      Array.isArray(input.lines) && input.lines.length > 0 && input.lines.length <= 120,
      'Say what happened to each missing piece.',
    );
    const notBack = new Map((trip.notBack ?? []).map((/** @type {any} */ l) => [l.product, l.quantity]));
    requireRule(notBack.size, 'Nothing is missing from this trip.');
    const lines = input.lines.map((/** @type {any} */ l) => {
      requireRule(
        l && typeof l.product === 'string' && notBack.has(l.product),
        'Pick a material that is missing from this trip.',
      );
      requireRule(OUTCOMES.includes(l.outcome), 'Choose still on site, lost, damaged or our loss.');
      return {
        product: l.product,
        quantity: integer(l.quantity, 'Amount', 1, 1000000),
        outcome: l.outcome,
        reason: optText(l.reason, 'A reason'),
        unitValue: l.unitValue,
      };
    });
    const asked = new Map();
    for (const l of lines) add(asked, l.product, l.quantity);
    for (const [p, q] of asked)
      requireRule(
        q <= (notBack.get(p) ?? 0),
        'Only ' +
          (notBack.get(p) ?? 0) +
          ' ' +
          this.planName(p, 'of that') +
          ' are missing from this trip; ' +
          q +
          ' were given an outcome.',
      );
    if (lines.some((l) => l.outcome === 'OUR_LOSS')) this.auth.require(this.user, 'company.manage');
    lines.sort((a, b) => Number(a.outcome !== 'STILL_ON_SITE') - Number(b.outcome !== 'STILL_ON_SITE'));
    const words = [];
    for (const l of lines) words.push(this.returnResolveLine(trip, tp, l, now));
    const fresh = this.repo.get(trip.id, 'trip'),
      left = this.tripOnTruck(fresh);
    fresh.notBack = [...left].map(([product, quantity]) => ({ product, quantity }));
    if (!fresh.notBack.length) fresh.flag = null;
    else if (fresh.flag?.code === 'RETURN_SHORT')
      fresh.flag = { code: 'RETURN_SHORT', words: this.returnShortWords(fresh), since: iso(now) };
    this.repo.save(fresh);
    const rest = [...left.values()].reduce((s, n) => s + n, 0);
    return {
      trip: this.tripView(fresh),
      message:
        words.join(' ') +
        (rest ? ' ' + plural(rest, 'piece') + ' still to sort out.' : ' Every piece is accounted for.'),
    };
  },
  // One line's outcome, taken from the containers of this trip still on the truck.
  /** @param {any} trip @param {any} tp @param {{product:string,quantity:number,outcome:string,reason:string|null,unitValue?:any}} l @param {number} now */
  returnResolveLine(trip, tp, l, now) {
    const picks = this.returnPicks(trip, tp.truck, new Map([[l.product, l.quantity]]));
    const got = picks.reduce((s, p) => s + p.quantity, 0);
    requireRule(got === l.quantity, 'Those pieces are not on the truck record any more. Refresh and try again.');
    const name = this.planName(l.product, 'that part'),
      siteName = this.planSiteName(trip.site);
    let unitValue = null,
      approvedBy = null;
    if (l.outcome === 'LOST') {
      unitValue = this.chargeValue(l.product, l.unitValue);
      if (this.chargeTyped(l.unitValue)) approvedBy = this.user.id; // the owner typed it (chargeValue checked)
    }
    if (l.outcome === 'OUR_LOSS') approvedBy = this.user.id;
    const reasonWords = l.reason ? ' · ' + l.reason : '';
    for (const p of picks) {
      const holder = this.repo.get(p.container, 'container');
      this.repo.balance(holder.id, p.product, -p.quantity);
      if (l.outcome === 'STILL_ON_SITE') {
        const pile = this.returnSitePile(trip.site, trip);
        this.repo.balance(pile.id, p.product, p.quantity);
        // a send that was delivered after all: on hire from the day it was delivered, not from today
        const prov = this.repo.provenance,
          deliveredAt = trip.direction === 'OUT' ? (trip.steps?.DELIVERED?.at ?? null) : null;
        if (deliveredAt)
          this.repo.provenance = { ...(prov ?? { kind: 'PERSON', onBehalfOf: null }), occurredAt: deliveredAt };
        try {
          this.repo.event(this.user.id, 'STILL_ON_SITE', {
            container: holder.id,
            product: p.product,
            quantity: p.quantity,
            source: tp.truck,
            destination: trip.site,
            reason: 'Still at ' + siteName + ' · ' + this.tripLabel(trip) + reasonWords,
            key: this.key,
          });
        } finally {
          if (deliveredAt) this.repo.provenance = prov;
        }
      } else if (l.outcome === 'LOST') {
        this.repo.event(this.user.id, 'LOST', {
          container: holder.id,
          product: p.product,
          quantity: p.quantity,
          source: tp.truck,
          destination: null,
          reason: 'Lost · ' + this.tripLabel(trip) + ' from ' + siteName + reasonWords,
          key: this.key,
        });
      } else if (l.outcome === 'DAMAGED') {
        const q = this.quarantineContainer(trip.yard);
        this.repo.balance(q.id, p.product, p.quantity);
        const fresh = this.repo.get(q.id, 'container');
        fresh.lots = [
          ...(fresh.lots ?? []),
          { product: p.product, quantity: p.quantity, site: trip.site, trip: trip.id, at: iso(now) },
        ];
        this.repo.save(fresh);
        this.repo.event(this.user.id, 'DAMAGED', {
          container: holder.id,
          product: p.product,
          quantity: p.quantity,
          source: tp.truck,
          destination: trip.yard,
          reason: 'Damaged, to quarantine · ' + this.tripLabel(trip) + ' from ' + siteName + reasonWords,
          key: this.key,
        });
      } else {
        this.repo.event(this.user.id, 'WRITTEN_OFF', {
          container: holder.id,
          product: p.product,
          quantity: p.quantity,
          source: tp.truck,
          destination: null,
          reason: 'Our loss, written off · ' + this.tripLabel(trip) + ' from ' + siteName + reasonWords,
          key: this.key,
        });
      }
      this.returnRetireEmpty(holder.id);
    }
    let charge = null;
    if (l.outcome === 'LOST')
      charge = this.chargeLine({
        site: trip.site,
        product: l.product,
        quantity: l.quantity,
        unitValue: /** @type {number} */ (unitValue),
        reason: 'LOST',
        source: trip.id,
        occurredAt: iso(now),
        approvedBy,
      });
    const t = this.repo.get(trip.id, 'trip');
    t.resolutions = [
      ...(t.resolutions ?? []),
      {
        product: l.product,
        quantity: l.quantity,
        outcome: l.outcome,
        reason: l.reason,
        at: iso(now),
        by: this.user.id,
        byName: this.user.name ?? 'Someone',
        approvedBy,
        charge: charge?.id ?? null,
        unitValue,
      },
    ];
    this.repo.save(t);
    if (l.outcome === 'STILL_ON_SITE' && trip.direction === 'BACK')
      for (const id of trip.orders) {
        const o = this.repo.get(id, 'order');
        const line = o.lines.find((/** @type {any} */ x) => x.product === l.product);
        if (line && line.collected >= l.quantity) {
          line.collected -= l.quantity; // they were never collected: the record says so now
          this.repo.save(o);
          break;
        }
      }
    if (l.outcome === 'STILL_ON_SITE' && trip.direction === 'OUT')
      for (const id of trip.orders) {
        const o = this.repo.get(id, 'order');
        const line = o.lines.find((/** @type {any} */ x) => x.product === l.product);
        if (line && line.loaded - line.delivered >= l.quantity) {
          line.delivered += l.quantity; // delivered after all: the record says so now
          if (o.status === 'SHORT' && o.lines.every((/** @type {any} */ x) => x.delivered >= x.requested))
            o.status = 'DELIVERED';
          this.repo.save(o);
          break;
        }
      }
    return (
      l.quantity +
      ' × ' +
      name +
      ': ' +
      (l.outcome === 'STILL_ON_SITE'
        ? 'still at ' + siteName + ', hire continues.'
        : l.outcome === 'LOST'
          ? 'lost, charged at $' + /** @type {number} */ ((unitValue * l.quantity) / 100).toFixed(2) + '.'
          : l.outcome === 'DAMAGED'
            ? 'damaged, in quarantine.'
            : 'our loss, written off.')
    );
  },
  // The site's loose pile (the first bundle there marked pile), or a new one.
  /** @param {string} siteId @param {any} trip */
  returnSitePile(siteId, trip) {
    const pile = this.tripRows(
      'container',
      NOT_RETIRED + " AND json_extract(data,'$.location')=? AND json_extract(data,'$.pile')=1",
      siteId,
    )[0];
    if (pile) return pile;
    const b = this.tripBundle(siteId, trip);
    b.pile = true;
    this.repo.save(b);
    return b;
  },
  // A bundle emptied by a resolution is nowhere any more (a stillage stays on the truck record until it is set down).
  /** @param {string} containerId */
  returnRetireEmpty(containerId) {
    const c = this.repo.get(containerId, 'container');
    if (!c.bundle || c.quarantine || this.repo.lines(c.id).length) return;
    Object.assign(c, {
      retired: true,
      retiredAt: iso(this.planNow()),
      retiredWhy: 'Emptied',
      pile: false,
      lastLocation: c.location,
      location: null,
    });
    this.repo.save(c);
  },
  // ---------- damaged pieces later: repair, scrap or charge ----------
  quarantineResolve(/** @type {any} */ input) {
    requireLive(this);
    requireRule(input && typeof input === 'object', 'Choose the pieces.');
    const yard = this.tripYard(),
      q = this.quarantineContainer(yard.id),
      product = this.effective(input.product),
      quantity = integer(input.quantity, 'Amount', 1, 1000000),
      outcome = input.outcome,
      reason = optText(input.reason, 'A reason'),
      now = this.planNow();
    requireRule(QUARANTINE_OUTCOMES.includes(outcome), 'Choose repaired, scrapped or charged.');
    const have = this.repo.quantity(q.id, product.id);
    requireRule(quantity <= have, 'Only ' + have + ' ' + product.name + ' in quarantine.');
    // which site's pieces (oldest lots first), for a charge
    const fresh = this.repo.get(q.id, 'container');
    let left = quantity;
    const from = new Map();
    fresh.lots = (fresh.lots ?? []).flatMap((/** @type {any} */ lot) => {
      if (lot.product !== product.id || left <= 0) return [lot];
      const n = Math.min(lot.quantity, left);
      left -= n;
      add(from, lot.site, n);
      return lot.quantity > n ? [{ ...lot, quantity: lot.quantity - n }] : [];
    });
    this.repo.save(fresh);
    this.repo.balance(q.id, product.id, -quantity);
    const charges = [];
    if (outcome === 'REPAIRED') {
      const pile = this.returnYardPile(yard.id);
      this.repo.balance(pile.id, product.id, quantity);
      this.repo.event(this.user.id, 'REPAIRED', {
        container: q.id,
        product: product.id,
        quantity,
        source: yard.id,
        destination: yard.id,
        reason: 'Repaired, back in stock' + (reason ? ' · ' + reason : ''),
        key: this.key,
      });
    } else {
      this.repo.event(this.user.id, 'SCRAPPED', {
        container: q.id,
        product: product.id,
        quantity,
        source: yard.id,
        destination: null,
        reason: (outcome === 'CHARGED' ? 'Scrapped and charged' : 'Scrapped') + (reason ? ' · ' + reason : ''),
        key: this.key,
      });
      if (outcome === 'CHARGED') {
        const unitValue = this.chargeValue(product.id, input.unitValue),
          approvedBy = this.chargeTyped(input.unitValue) ? this.user.id : null;
        // each lot is charged to the site it came back from (the records say which); a site named on the tap must be one of them
        requireRule(from.size, 'These pieces have no site on record. Scrap them instead.');
        requireRule(
          !input.site || from.has(input.site),
          'Those pieces did not come from ' +
            this.planSiteName(input.site) +
            '. They are charged to the site they came back from.',
        );
        for (const [site, n] of from) {
          this.repo.get(site, 'site');
          charges.push(
            this.chargeLine({
              site,
              product: product.id,
              quantity: n,
              unitValue,
              reason: 'DAMAGED',
              source: q.id,
              occurredAt: iso(now),
              approvedBy,
            }),
          );
        }
      }
    }
    return {
      outcome,
      product: product.id,
      quantity,
      charges,
      message:
        quantity +
        ' × ' +
        product.name +
        (outcome === 'REPAIRED'
          ? ' repaired and back in stock.'
          : outcome === 'SCRAPPED'
            ? ' scrapped.'
            : ' scrapped and charged.'),
    };
  },
  /** @param {string} yardId */
  returnYardPile(yardId) {
    const pile = this.tripRows(
      'container',
      NOT_RETIRED + " AND json_extract(data,'$.location')=? AND json_extract(data,'$.pile')=1",
      yardId,
    )[0];
    if (pile) return pile;
    const b = this.tripBundle(yardId, { id: null });
    b.pile = true;
    b.trip = null;
    this.repo.save(b);
    return b;
  },
  /** The pieces a trip's confirmed step recorded ([] when the step is not confirmed). @param {any} t @param {string} step @returns {{product:string,quantity:number}[]} */
  tripStepLines(t, step) {
    const id = t.steps?.[step]?.id;
    if (!id) return [];
    return JSON.parse(
      cached(this.db, 'SELECT lines FROM trip_confirmation WHERE company_id=? AND id=?').get(this.repo.company, id)
        ?.lines ?? '[]',
    );
  },
  // ---------- the site's account: sent, back, on site, moved on, charged, written off, missing ----------
  /** @param {string} siteId */
  siteAccount(siteId) {
    const sum = (/** @type {any[]} */ rows) =>
      rows.reduce(
        (s, r) => s + JSON.parse(r.lines).reduce((/** @type {number} */ k, /** @type {any} */ l) => k + l.quantity, 0),
        0,
      );
    const conf = (/** @type {string} */ step) =>
      cached(this.db, 'SELECT lines FROM trip_confirmation WHERE company_id=? AND site_id=? AND step=?').all(
        this.repo.company,
        siteId,
        step,
      );
    let sent = sum(conf('DELIVERED'));
    // collected from here: a bring-back's pieces, and a move's (its Collected row is at the first site, ADR 0012)
    const collected = sum(conf('COLLECTED'));
    // a move from this site (ADR 0012): what landed at the other site has moved on; what came back to the yard instead is back
    const moves = this.tripRows(
      'trip',
      "json_extract(data,'$.fromSite')=? AND json_extract(data,'$.direction')='MOVE'",
      siteId,
    );
    let moved = 0;
    const movedTo = new Map();
    for (const t of moves) {
      let n = 0;
      for (const l of this.tripStepLines(t, 'DELIVERED')) n += l.quantity;
      if (n) {
        moved += n;
        const name = this.planSiteName(t.site);
        movedTo.set(name, (movedTo.get(name) ?? 0) + n);
      }
    }
    const trips = [
      ...this.tripRows(
        'trip',
        "json_extract(data,'$.site')=? AND json_extract(data,'$.direction')='BACK' AND json_extract(data,'$.state')='RETURNED'",
        siteId,
      ),
      ...moves.filter((t) => t.state === 'RETURNED'),
    ];
    let back = 0,
      unresolved = 0,
      writtenOff = 0,
      damaged = 0;
    const unresolvedTrips = [];
    // a send that came back short and was resolved: those pieces count as sent to the site (delivered after all, lost on the way to it,
    // damaged or written off), so the account stays whole; what is still unresolved on a send is the trip's, not the site's
    for (const t of this.tripRows(
      'trip',
      "json_extract(data,'$.site')=? AND json_extract(data,'$.direction')='OUT' AND json_extract(data,'$.state')='RETURNED' AND json_array_length(coalesce(json_extract(data,'$.resolutions'),'[]'))>0",
      siteId,
    ))
      for (const r of t.resolutions ?? []) {
        sent += r.quantity;
        if (r.outcome === 'DAMAGED') damaged += r.quantity;
        if (r.outcome === 'OUR_LOSS') writtenOff += r.quantity;
      }
    for (const t of trips) {
      for (const l of this.tripStepLines(t, 'RETURNED')) back += l.quantity;
      for (const l of t.count?.lines ?? []) back += l.quantity;
      for (const r of t.resolutions ?? []) {
        if (r.outcome === 'DAMAGED') damaged += r.quantity;
        if (r.outcome === 'OUR_LOSS') writtenOff += r.quantity;
      }
      const nb = (t.notBack ?? []).reduce((/** @type {number} */ s, /** @type {any} */ l) => s + l.quantity, 0);
      if (t.countPending) unresolvedTrips.push({ trip: t.id, label: this.tripLabel(t), pending: true, pieces: nb });
      else if (nb) {
        unresolved += nb;
        unresolvedTrips.push({ trip: t.id, label: this.tripLabel(t), pending: false, pieces: nb });
      }
    }
    let onSite = 0;
    for (const c of this.tripContainersAt(siteId)) for (const l of this.repo.lines(c.id)) onSite += l.quantity;
    // gear already on hire when the yard went live (opening lots, ADR 0011): on the record, never sent by a truck
    const opening = cached(
      this.db,
      "SELECT COALESCE(SUM(quantity),0) n FROM ledger WHERE company_id=? AND event='OPENING_BALANCE' AND destination=? AND actor_kind='IMPORT'",
    ).get(this.repo.company, siteId).n;
    const charged = cached(
      this.db,
      "SELECT COALESCE(SUM(quantity),0) n FROM charge_lines WHERE company_id=? AND site_id=? AND reason IN ('LOST','SITE_FINISH')",
    ).get(this.repo.company, siteId).n;
    let site = null;
    try {
      site = this.repo.get(siteId, 'site');
    } catch {}
    writtenOff += site?.finish?.writtenOffSite ?? 0; // the site's own record at finish (trip shortfalls are counted above, once)
    // K in the question: what the site never brought back and nobody has settled (on its record, or missing from a trip). The integrity
    // number: sent - back - on site - charged - written off, 0 at every closed site.
    const missing = onSite + unresolved,
      unaccounted = sent + opening - (back + damaged) - moved - onSite - charged - writtenOff,
      active = site?.status === 'ACTIVE';
    const tail =
      (moved ? ' · ' + moved + ' moved to ' + [...movedTo.keys()].join(', ') : '') +
      (charged ? ' · ' + charged + ' charged' : '') +
      (writtenOff ? ' · ' + writtenOff + ' written off' : '');
    return {
      site: siteId,
      siteName: site?.name ?? 'The site',
      sent,
      opening,
      collected,
      moved,
      back: back + damaged,
      counted: back,
      damaged,
      onSite,
      charged,
      writtenOff,
      unresolved,
      unresolvedTrips,
      missing,
      unaccounted,
      words:
        (opening ? 'on hire at go-live ' + opening + ' · ' : '') +
        'sent ' +
        sent +
        ' · back ' +
        (back + damaged) +
        ' · ' +
        missing +
        ' missing',
      // the same numbers as an active site's card says them: gear on site is on hire, not missing, until the site finishes
      summary: active
        ? (opening ? 'on hire at go-live ' + opening + ' · ' : '') +
          'sent ' +
          sent +
          ' · back ' +
          (back + damaged) +
          (onSite ? ' · ' + onSite + ' on site (hire running)' : '') +
          (unresolved ? ' · ' + unresolved + ' not back, not sorted' : '') +
          tail
        : 'sent ' + sent + ' · back ' + (back + damaged) + tail,
      active,
      looking: site?.looking ?? null,
      finish: site?.finish ?? null,
    };
  },
  // ---------- one site-finish question ----------
  // "sent N · back M · K missing: charge, write off or still looking?" CHARGE and WRITE_OFF settle every missing piece (the site's record and
  // any unresolved trip from it) and close the site; STILL_LOOKING keeps it open and on Needs you.
  siteFinish(/** @type {any} */ input) {
    requireLive(this);
    const site = this.repo.get(input?.site, 'site'),
      outcome = input.outcome,
      reason = optText(input.reason, 'A reason'),
      now = this.planNow();
    requireRule(site.status === 'ACTIVE', site.name + ' is already finished.');
    requireRule(FINISH_OUTCOMES.includes(outcome), 'Choose charge, write off or still looking.');
    const busy = this.tripSiteBusy(site.id);
    if (busy) throw new AppError(409, busy);
    const before = this.siteAccount(site.id);
    requireRule(!before.unresolvedTrips.some((t) => t.pending), 'Count the returns from ' + site.name + ' first.');
    if (outcome === 'STILL_LOOKING') {
      requireRule(before.missing > 0, 'Nothing is missing from ' + site.name + '. Charge or write off closes it.');
      site.looking = { since: iso(now), by: this.user.id, missing: before.missing, reason };
      this.repo.save(site);
      this.notify(
        'Still looking',
        site.name + ': ' + before.words + '. It stays open until the pieces turn up or are charged.',
        site.id,
      );
      return {
        site: site.id,
        outcome,
        account: this.siteAccount(site.id),
        message: site.name + ' stays open: ' + before.words + '.',
      };
    }
    if (outcome === 'WRITE_OFF') this.auth.require(this.user, 'company.manage');
    const values = input.unitValues && typeof input.unitValues === 'object' ? input.unitValues : {};
    // unresolved trip shortfalls from this site: every piece lost (charged) or our loss (written off)
    let charged = 0,
      writtenOff = 0;
    for (const u of before.unresolvedTrips) {
      const t = this.repo.get(u.trip, 'trip');
      const lines = (t.notBack ?? []).map((/** @type {any} */ l) => ({
        product: l.product,
        quantity: l.quantity,
        outcome: outcome === 'CHARGE' ? 'LOST' : 'OUR_LOSS',
        reason: reason ?? 'Site finished',
        unitValue: values[l.product],
      }));
      if (lines.length) this.returnResolve({ trip: t.id, lines });
      for (const l of lines)
        if (outcome === 'CHARGE') charged += l.quantity;
        else writtenOff += l.quantity;
    }
    // what the site's record still holds: gone from it, charged or written off
    let writtenOffSite = 0;
    for (const c of this.tripContainersAt(site.id)) {
      for (const l of this.repo.lines(c.id)) {
        this.repo.balance(c.id, l.product_id, -l.quantity);
        if (outcome === 'CHARGE') {
          const unitValue = this.chargeValue(l.product_id, values[l.product_id]),
            approvedBy = this.chargeTyped(values[l.product_id]) ? this.user.id : null;
          this.repo.event(this.user.id, 'LOST', {
            container: c.id,
            product: l.product_id,
            quantity: l.quantity,
            source: site.id,
            destination: null,
            reason: 'Not returned at finish, charged · ' + site.name + (reason ? ' · ' + reason : ''),
            key: this.key,
          });
          this.chargeLine({
            site: site.id,
            product: l.product_id,
            quantity: l.quantity,
            unitValue,
            reason: 'SITE_FINISH',
            source: site.id,
            occurredAt: iso(now),
            approvedBy,
          });
          charged += l.quantity;
        } else {
          this.repo.event(this.user.id, 'WRITTEN_OFF', {
            container: c.id,
            product: l.product_id,
            quantity: l.quantity,
            source: site.id,
            destination: null,
            reason: 'Not returned at finish, written off · ' + site.name + (reason ? ' · ' + reason : ''),
            key: this.key,
          });
          writtenOff += l.quantity;
          writtenOffSite += l.quantity;
        }
      }
      const emptied = this.repo.get(c.id, 'container');
      Object.assign(emptied, {
        retired: true,
        retiredAt: iso(now),
        retiredWhy: 'Site finished: ' + (outcome === 'CHARGE' ? 'charged' : 'written off'),
        pile: false,
        lastLocation: site.id,
        location: null,
      });
      this.repo.save(emptied);
    }
    const s = this.repo.get(site.id, 'site');
    s.looking = null;
    s.finish = {
      at: iso(now),
      by: this.user.id,
      outcome,
      sent: before.sent,
      back: before.back,
      charged,
      writtenOff,
      writtenOffSite, // the site's own record; trip shortfalls are on their trips' resolutions
      reason,
      approvedBy: outcome === 'WRITE_OFF' ? this.user.id : null,
    };
    this.repo.save(s);
    this.sfArchive(this.repo.get(site.id, 'site'));
    this.planSiteGone?.(site.id, 'finished');
    const after = this.siteAccount(site.id);
    return {
      site: site.id,
      outcome,
      account: after,
      message:
        site.name +
        ' finished: ' +
        before.words +
        (charged ? ' · ' + plural(charged, 'piece') + ' charged' : '') +
        (writtenOff ? ' · ' + plural(writtenOff, 'piece') + ' written off' : '') +
        '.',
    };
  },
  // ---------- the business clock: flags only ----------
  // A return not counted, or with missing pieces nobody has resolved, by the end of its company day (5 pm; after 5 pm, the next day's end).
  /** @param {number} now */
  clockReturns(now) {
    const rows = this.tripRowsBy(
      'objects_trip_state',
      'trip',
      "json_extract(data,'$.state')='RETURNED' AND (json_extract(data,'$.countPending')=1 OR json_array_length(coalesce(json_extract(data,'$.notBack'),'[]'))>0)",
    );
    for (const t of rows) {
      if (t.flag?.code === 'RETURN_SHORT') continue;
      const at = Date.parse(t.steps?.RETURNED?.at ?? t.createdAt),
        day = this.clockDay(at);
      let due = this.clockAt(day, DAY_END);
      if (at >= due) due = this.clockAt(addDays(day, 1), DAY_END);
      if (now < due) continue;
      const words = t.countPending
        ? 'Not counted yet: ' + this.tripLabel(t) + ' came back ' + this.tripHm(at)
        : this.returnShortWords(t);
      t.flag = { code: 'RETURN_SHORT', words, since: iso(now) };
      this.repo.save(t);
      this.notify('Return short', this.tripLabel(t) + ': ' + words + '.', t.site);
    }
  },
};
