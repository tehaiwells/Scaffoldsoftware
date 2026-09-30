// @ts-check
// Record what really happened in a real yard (ADR 0009; audit #2, #3, thin #5, #22). Mixed into Simulation.prototype (this = the Simulation).
//   order  one site's request, OUT (send) or BACK (bring back), lines kept exactly as typed; exact pieces are held (reservations) at once
//   trip   one run of one truck and its driver (a Today truck booking) to one site, carrying orders of one direction
//   confirmations  packConfirmed (optional), tripLoaded (Loaded & left), tripDelivered (received by), tripCollected, tripReturned (Back at
//          yard): each one appends a trip_confirmation row and moves stock through the ledger, with who, when (occurred_at) and how
// Stock changes place only on a confirmation. A whole stillage moves as it is; part of one is split into a BUNDLE container first (SPLIT,
// no change of place). Nothing here runs in the Practice yard, and nothing here runs by itself: the business clock only flags (clockTrips).
import { randomUUID } from 'node:crypto';
import { requireRule, integer } from './geometry.js';
import { AppError } from '../service.js';
import { cached } from '../database.js';
import { bumpRevision } from '../repository.js';
import { lineList } from './game.js';
import { requireLive } from './mode.js';
import { zoneParts } from './zonetime.js';
import { dayLabel, addDays } from './schedule.js';
import { DAY_END, PLAN_TIMES, parseTime, timeWords } from './plantime.js';
/** @typedef {import('../repository.js').StoredObject} StoredObject */
/** @typedef {'PACKED'|'LOADED'|'DELIVERED'|'COLLECTED'|'RETURNED'} TripStep */
/** @typedef {{container:string,product:string,quantity:number}} Pick */

// Who may run what (simulation.js execute): orders need requests.create (a supervisor only for their own sites); booking and packing need
// operations.manage; the four confirmations need trips.confirm, and then the trip's own driver or the office (for the driver: ON_BEHALF).
export const ORDER_OPS = ['orderCreate', 'bringBackCreate', 'orderCancel'];
export const TRIP_OFFICE_OPS = ['tripBook', 'tripCancel', 'packConfirmed'];
export const TRIP_CONFIRM_OPS = ['tripLoaded', 'tripDelivered', 'tripCollected', 'tripReturned'];
/** @type {Record<string,TripStep>} */
export const STEP_OF = {
  packConfirmed: 'PACKED',
  tripLoaded: 'LOADED',
  tripDelivered: 'DELIVERED',
  tripCollected: 'COLLECTED',
  tripReturned: 'RETURNED',
};
export const STEP_WORDS = {
  PACKED: 'Packed',
  LOADED: 'Loaded & left',
  DELIVERED: 'Delivered',
  COLLECTED: 'Collected',
  RETURNED: 'Back at yard',
};
export const TRIP_STATE_WORDS = {
  BOOKED: 'Booked',
  PACKED: 'Packed',
  LOADED: 'Loaded, not delivered yet',
  DELIVERED: 'Delivered',
  DELIVERED_SHORT: 'Delivered short',
  COLLECTED: 'Collected, not back yet',
  RETURNED: 'Back at yard',
  CANCELLED: 'Cancelled',
};
// A send that came back without being delivered (the site refused it, or was shut): Back at yard straight from Loaded & left.
export const UNDELIVERED_WORDS = 'Came back, not delivered';
export const ORDER_STATE_WORDS = {
  OPEN: 'Waiting for a truck',
  BOOKED: 'On a truck booking',
  LOADED: 'Loaded, not delivered yet',
  DELIVERED: 'Delivered',
  SHORT: 'Delivered short',
  COLLECTED: 'Collected, not back yet',
  RETURNED: 'Back at yard',
  NOT_DELIVERED: UNDELIVERED_WORDS,
  CANCELLED: 'Cancelled',
};
// Trips still waiting for a confirmation (DELIVERED waits for nothing: Back at yard is optional then).
export const OPEN_TRIP = ['BOOKED', 'PACKED', 'LOADED', 'DELIVERED_SHORT', 'COLLECTED'];
const ORDER_OPEN = ['OPEN', 'BOOKED'];
export const BACKDATE_DAYS = 7,
  BACKDATE_FREE_MS = 15 * 60000,
  SKEW_MS = 2 * 60000,
  DEFAULT_MINUTES = 30,
  LATE_MS = 30 * 60000,
  REPLAY_MS = 15 * 60000,
  MEDIAN_OF = 5,
  LEARN_FROM = 3,
  MIN_DRIVE_MS = 5 * 60000;
const DAY = /^\d{4}-\d{2}-\d{2}$/,
  ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
/** @type {(ms:number)=>string} */
const iso = (ms) => new Date(ms).toISOString();
/** '07:30' -> '08:30' @type {(hm:string)=>string} */
const addHour = (hm) => {
  const [h, m] = hm.split(':').map(Number);
  return String(Math.min(23, h + 1)).padStart(2, '0') + ':' + String(m).padStart(2, '0');
};
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
/** @type {(xs:number[])=>number|null} */
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b),
    m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const add = (/** @type {Map<string,number>} */ m, /** @type {string} */ k, /** @type {number} */ n) =>
  m.set(k, (m.get(k) ?? 0) + n);
const RANK = { PACKED: 0, LOADED: 1, COLLECTED: 1, DELIVERED: 2, RETURNED: 3 };
// A trip's latest confirmed step: the latest time, and the later step when two share a time. [step, record] or null.
/** @param {any} t @returns {[string, any]|null} */
export const tripLast = (t) =>
  Object.entries(t.steps ?? {}).sort(
    (a, b) =>
      String(b[1].at).localeCompare(String(a[1].at)) ||
      (RANK[/** @type {TripStep} */ (b[0])] ?? 0) - (RANK[/** @type {TripStep} */ (a[0])] ?? 0),
  )[0] ?? null;
const OPEN_STATES = "json_extract(data,'$.state') IN ('BOOKED','PACKED','LOADED','DELIVERED_SHORT','COLLECTED')";
const NOT_RETIRED = "coalesce(json_extract(data,'$.retired'),0)=0";
const INSERT_CONFIRMATION =
  'INSERT INTO trip_confirmation(id,company_id,trip_id,site_id,step,lines,received_by,occurred_at,recorded_at,actor,actor_kind,on_behalf_of,origin,backdate_reason,command_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';

/** @type {Record<string,any> & ThisType<any>} */
export const tripMethods = {
  // ---------- places, products and free stock ----------
  /** @param {string} id */
  tripSite(id) {
    requireRule(typeof id === 'string' && id, 'Choose a site.');
    const s = this.repo.get(id, 'site');
    this.assertSite(s.id);
    requireRule(s.status === 'ACTIVE', 'Choose an active site.');
    return s;
  },
  tripYard() {
    const yard = this.planYard();
    requireRule(yard, 'Set up your yard first.');
    return yard;
  },
  // Records of one kind whose JSON matches a condition, oldest first, decoded as Repository.all does. A real yard keeps years of orders, trips,
  // holds and bundles: every command here reads only the rows it needs (the objects_company_kind index, then the condition).
  /** @param {string} kind @param {string} [where] @param {...any} args @returns {any[]} */
  tripRows(kind, where = '1=1', ...args) {
    return this.tripRowsBy(null, kind, where, ...args);
  },
  // The same, through a named index of migration 008 (SQLite does not choose an expression index for an IN list by itself).
  /** @param {string|null} index @param {string} kind @param {string} [where] @param {...any} args @returns {any[]} */
  tripRowsBy(index, kind, where = '1=1', ...args) {
    // the kind is written into the SQL (never a user's text: always a kind name from this file), so SQLite can use the partial indexes of
    // migration 008 (containers by place, trips by state, booking and truck, holds by order, orders by status)
    if (!/^[a-zA-Z]+$/.test(kind)) throw new Error('Unknown kind.');
    return cached(
      this.db,
      'SELECT id,kind,data,version FROM objects ' +
        (index && /^[a-z_]+$/.test(index) ? 'INDEXED BY ' + index + ' ' : '') +
        "WHERE company_id=? AND kind='" +
        kind +
        "' AND (" +
        where +
        ') ORDER BY rowid',
    )
      .all(this.repo.company, ...args)
      .map((/** @type {any} */ r) => this.repo.decode(r));
  },
  /** @param {string} kind */
  tripCount(kind) {
    return cached(this.db, 'SELECT COUNT(*) n FROM objects WHERE company_id=? AND kind=?').get(this.repo.company, kind)
      .n;
  },
  // Containers at a place, not retired.
  /** @param {string} place */
  tripContainersAt(place) {
    return this.tripRows('container', NOT_RETIRED + " AND json_extract(data,'$.location')=?", place);
  },
  // Active holds, by container and product (an order's hold, the simulation's task holds, Today's list holds).
  /** @returns {Map<string,number>} container|product -> pieces held */
  tripHeldMap() {
    const m = new Map();
    for (const r of this.tripRows('reservation', "json_extract(data,'$.active')=1"))
      add(m, r.container + '|' + r.product, r.quantity);
    return m;
  },
  // Containers at a place that can give stock: in service, not being counted.
  /** @param {string} place */
  tripStockAt(place) {
    const counts = this.tripRows('count', "json_extract(data,'$.state')='OPEN'");
    if (counts.some((/** @type {any} */ n) => n.scope === place)) return [];
    const locked = new Set(counts.map((/** @type {any} */ n) => n.scope));
    return this.tripContainersAt(place).filter(
      (/** @type {any} */ c) => c.condition === 'SERVICEABLE' && !locked.has(c.id),
    );
  },
  // Exact pieces of one product at a place, fewest splits first: a container holding exactly what is left, then whole containers (only this
  // product, nothing held) largest first while they fit, then the smallest one that covers the rest (split), then parts, largest first.
  // taken: pieces already chosen in this step (container|product), so they are never chosen twice. Returns the picks and how many are short.
  /** @param {string} place @param {string} product @param {number} want @param {Map<string,number>} [taken] */
  tripPick(place, product, want, taken = new Map()) {
    const held = this.tripHeldMap(),
      cands = [];
    for (const c of this.tripStockAt(place)) {
      const lines = this.repo.lines(c.id),
        have = lines.find((/** @type {any} */ l) => l.product_id === product)?.quantity ?? 0;
      if (!have) continue;
      const k = c.id + '|' + product,
        free = have - (held.get(k) ?? 0) - (taken.get(k) ?? 0);
      if (free <= 0) continue;
      const whole =
        lines.length === 1 &&
        free === have &&
        ![...held.keys()].some((x) => x.startsWith(c.id + '|')) &&
        ![...taken.keys()].some((x) => x.startsWith(c.id + '|'));
      cands.push({ c, free, whole });
    }
    const byName = (/** @type {any} */ a, /** @type {any} */ b) =>
      String(a.c.name).localeCompare(String(b.c.name), undefined, { numeric: true }) || a.c.id.localeCompare(b.c.id);
    /** @type {Pick[]} */
    const picks = [];
    let left = want;
    const take = (/** @type {any} */ x, /** @type {number} */ q) => {
      picks.push({ container: x.c.id, product, quantity: q });
      x.free -= q;
      left -= q;
    };
    const exact = cands.filter((x) => x.whole && x.free === left).sort(byName)[0];
    if (exact) take(exact, left);
    for (const x of cands.filter((x) => x.whole).sort((a, b) => b.free - a.free || byName(a, b)))
      if (left > 0 && x.free > 0 && x.free <= left) take(x, x.free);
    if (left > 0) {
      const cover = cands.filter((x) => x.free >= left).sort((a, b) => a.free - b.free || byName(a, b))[0];
      if (cover) take(cover, left);
    }
    for (const x of cands.filter((x) => x.free > 0).sort((a, b) => b.free - a.free || byName(a, b)))
      if (left > 0) take(x, Math.min(x.free, left));
    return { picks, short: left };
  },
  // Free pieces per product at a yard or site (the LIVE picker: GET /api/live-items), with the pack size as a hint.
  /** @param {string} loc */
  orderItems(loc) {
    requireLive(this);
    const place = this.repo.get(loc);
    requireRule(['yard', 'site'].includes(place.kind), 'Choose a yard or a site.');
    this.assertSite(place.id);
    const held = this.tripHeldMap(),
      free = new Map();
    for (const c of this.tripStockAt(place.id))
      for (const l of this.repo.lines(c.id))
        add(free, l.product_id, Math.max(0, l.quantity - (held.get(c.id + '|' + l.product_id) ?? 0)));
    const items = [];
    for (const [product, n] of free) {
      if (n <= 0) continue;
      let p = null;
      try {
        p = this.effective(product);
      } catch {}
      if (!p) continue;
      items.push({
        product,
        name: p.name,
        system: p.system ?? null,
        category: p.category ?? null,
        free: n,
        pack: p.packQuantity ?? null,
      });
    }
    items.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
    return { loc: place.id, kind: place.kind, name: place.name, items };
  },

  // ---------- orders ----------
  orderCreate(/** @type {any} */ input) {
    requireLive(this);
    return this.orderMake('OUT', input ?? {});
  },
  bringBackCreate(/** @type {any} */ input) {
    requireLive(this);
    return this.orderMake('BACK', input ?? {});
  },
  /** @param {'OUT'|'BACK'} direction @param {any} input @param {{source?:string,planItem?:string|null}} [extra] */
  orderMake(direction, input, extra = {}) {
    const site = this.tripSite(input.site),
      yard = this.tripYard(),
      cal = this.planNowCal(),
      lines = lineList(input.lines);
    requireRule(!site.finishing, site.name + ' is being removed. Tap Keep it first.');
    const neededOn =
      input.neededOn === undefined || input.neededOn === null || input.neededOn === ''
        ? cal.today
        : (requireRule(typeof input.neededOn === 'string' && DAY.test(input.neededOn), 'Choose a day.'),
          this.planDay(input.neededOn, cal));
    const time = input.time === undefined || input.time === null || input.time === '' ? null : parseTime(input.time);
    const source = extra.source ?? (['board', 'today', 'office'].includes(input.source) ? input.source : 'office');
    // sends are O-1, O-2, ...; bring-backs B-1, B-2, ... (each counted on its own)
    const now = this.planNow(),
      number =
        cached(
          this.db,
          "SELECT COUNT(*) n FROM objects WHERE company_id=? AND kind='order' AND json_extract(data,'$.direction')=?",
        ).get(this.repo.company, direction).n + 1;
    const order = this.repo.add('order', {
      number,
      direction,
      site: site.id,
      yard: yard.id,
      neededOn,
      time,
      status: 'OPEN',
      trip: null,
      planItem: extra.planItem ?? null,
      source,
      note: optText(input.note, 'A note'),
      lines: lines.map((l) => {
        const p = this.effective(l.product);
        requireRule(!p.retired, p.name + ' has been removed from the catalogue.');
        return {
          product: p.id,
          requested: l.quantity,
          loaded: 0,
          delivered: 0,
          collected: 0,
          returned: 0,
          pack: p.packQuantity ?? null,
        };
      }),
      createdAt: iso(now),
      createdBy: this.user.id,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
    });
    const short = this.orderHold(order);
    const view = this.orderView(this.repo.get(order.id, 'order')),
      from = direction === 'OUT' ? 'in the yard' : 'at ' + site.name;
    const words = view.lines.map((/** @type {any} */ l) => l.requested + ' × ' + l.name).join(', ');
    const heldWords = short.length
      ? short
          .map(
            (/** @type {any} */ s) =>
              'Only ' +
              s.held +
              ' of ' +
              s.requested +
              ' ' +
              s.name +
              ' free ' +
              from +
              ' now; the rest is picked when it is loaded.',
          )
          .join(' ')
      : 'Held exactly.';
    return {
      order: view,
      short,
      heldWords,
      message:
        (direction === 'OUT'
          ? 'Order ' + view.label + ' for ' + site.name + ': '
          : 'Bring back ' + view.label + ' from ' + site.name + ': ') +
        words +
        '. ' +
        heldWords,
    };
  },
  // Holds exact pieces for every line that is not fully held yet (yard stock for OUT, the site's for BACK). Returns the lines still short.
  /** @param {any} order */
  orderHold(order) {
    const place = order.direction === 'OUT' ? order.yard : order.site,
      short = [],
      had = this.orderHeld(order.id);
    for (const l of order.lines) {
      const need = l.requested - (had.get(l.product) ?? 0);
      if (need <= 0) continue;
      const { picks, short: s } = this.tripPick(place, l.product, need);
      for (const p of picks)
        this.repo.add('reservation', {
          container: p.container,
          product: p.product,
          quantity: p.quantity,
          task: null,
          order: order.id,
          active: true,
          createdAt: iso(this.planNow()),
        });
      if (s > 0)
        short.push({
          product: l.product,
          name: this.planName(l.product, 'that part'),
          requested: l.requested,
          held: l.requested - s,
        });
    }
    return short;
  },
  /** @param {string} orderId @returns {Map<string,number>} */
  orderHeld(orderId) {
    const m = new Map();
    for (const r of this.orderHolds(orderId)) add(m, r.product, r.quantity);
    return m;
  },
  // After stock went down in a real yard (a count found fewer, pieces removed, a stillage removed): no order holds more than is really there.
  // A hold beyond it is cut back (oldest orders keep theirs first) and the order holds the gap from other free stock, when there is some.
  orderHoldsFit() {
    const holds = this.tripRows(
      'reservation',
      "json_extract(data,'$.active')=1 AND json_extract(data,'$.order') IS NOT NULL",
    );
    /** @type {Map<string,any[]>} */
    const by = new Map();
    for (const r of holds) {
      const k = r.container + '|' + r.product;
      by.set(k, [...(by.get(k) ?? []), r]);
    }
    const redo = new Set();
    for (const [k, list] of by) {
      const [cid, pid] = k.split('|');
      let room = 0;
      try {
        const c = this.repo.get(cid, 'container');
        if (!c.retired) room = this.repo.quantity(cid, pid);
      } catch {}
      for (const r of list) {
        if (r.quantity <= room) {
          room -= r.quantity;
          continue;
        }
        if (room > 0) this.repo.save({ ...r, quantity: room });
        else this.repo.remove(r.id, 'reservation');
        room = 0;
        redo.add(r.order);
      }
    }
    for (const id of redo) {
      let o = null;
      try {
        o = this.repo.get(id, 'order');
      } catch {}
      if (o && ORDER_OPEN.includes(o.status)) this.orderHold(o);
    }
  },
  // A trip still open (booked, packed or out) on a truck, from its Today booking: the truck cannot be removed from under it.
  /** @param {string} truckId */
  tripOpenOnTruck(truckId) {
    if (!this.live()) return null;
    return this.tripOpenRows().find((/** @type {any} */ t) => (this.tripPlan(t)?.truck ?? t.truck) === truckId) ?? null;
  },
  // What still ties a site to a real yard's trips: an order waiting or on the way, or a trip not finished. Words, or null.
  /** @param {string} siteId */
  tripSiteBusy(siteId) {
    if (!this.live()) return null;
    const o = this.tripRowsBy(
      'objects_order_status',
      'order',
      "json_extract(data,'$.status') IN ('OPEN','BOOKED','LOADED','COLLECTED') AND json_extract(data,'$.site')=?",
      siteId,
    )[0];
    if (o)
      return (
        this.orderLabel(o) +
        ' for ' +
        this.planSiteName(siteId) +
        ' is ' +
        ORDER_STATE_WORDS[o.status].toLowerCase() +
        '. ' +
        (ORDER_OPEN.includes(o.status) ? 'Cancel it first.' : 'Confirm its trip first.')
      );
    const t = this.tripOpenRows().find((/** @type {any} */ x) => x.site === siteId);
    return t
      ? this.tripLabel(t) +
          ' to ' +
          this.planSiteName(siteId) +
          ' is ' +
          this.tripStateWords(t).toLowerCase() +
          '. Confirm it first.'
      : null;
  },
  /** @param {string} orderId */
  orderHolds(orderId) {
    return this.tripRows('reservation', "json_extract(data,'$.active')=1 AND json_extract(data,'$.order')=?", orderId);
  },
  // Lets an order's holds go. A hold is not a record of anything that happened (the order's lines and the trip's confirmations are), so a
  // used or released one is removed rather than kept switched off: there are only as many holds as orders waiting.
  /** @param {string} orderId */
  orderRelease(orderId) {
    for (const r of this.orderHolds(orderId)) this.repo.remove(r.id, 'reservation');
  },
  orderCancel(/** @type {any} */ input) {
    requireLive(this);
    const order = this.repo.get(input?.id, 'order');
    this.assertSite(order.site);
    requireRule(
      ORDER_OPEN.includes(order.status),
      order.status === 'CANCELLED'
        ? 'This order is already cancelled.'
        : 'It has already left (' +
            ORDER_STATE_WORDS[order.status].toLowerCase() +
            '). Confirm the rest of the trip instead.',
    );
    const reason = optText(input.reason, 'A reason'),
      now = this.planNow();
    this.orderRelease(order.id);
    if (order.trip) this.tripDropOrder(order.trip, order.id, 'Order ' + this.orderLabel(order) + ' was cancelled.');
    Object.assign(order, {
      status: 'CANCELLED',
      trip: null,
      cancelledAt: iso(now),
      cancelledBy: this.user.id,
      cancelReason: reason,
    });
    this.repo.save(order);
    if (order.planItem && !input.fromPlan) {
      let it = null;
      try {
        it = this.repo.get(order.planItem, 'planItem');
      } catch {}
      if (it && ['PLANNED', 'ACTIVE', 'MISSED'].includes(it.status))
        this.planEdit(it.id, (/** @type {any} */ x) => {
          x.status = 'CANCELLED';
          x.cancelledAt = iso(now);
          x.cancelledBy = this.user.id;
          x.problem = null;
          this.planLog(x, 'Cancelled with its order by ' + this.user.name + '.', now);
          this.planCloseMsgs(x, now);
        });
    }
    return {
      order: this.orderView(order),
      message: 'Cancelled ' + this.orderLabel(order) + '. Nothing is held for it now.',
    };
  },
  /** @param {any} o */
  orderLabel(o) {
    return (o.direction === 'BACK' ? 'B-' : 'O-') + o.number;
  },
  /** @param {any} o */
  orderView(o) {
    const held = this.orderHeld(o.id);
    let site = null;
    try {
      site = this.repo.get(o.site, 'site');
    } catch {}
    return {
      id: o.id,
      number: o.number,
      label: this.orderLabel(o),
      direction: o.direction,
      site: o.site,
      siteName: site?.name ?? 'The site',
      neededOn: o.neededOn,
      time: o.time,
      status: o.status,
      statusWords: ORDER_STATE_WORDS[o.status] ?? o.status,
      trip: o.trip,
      planItem: o.planItem ?? null,
      source: o.source,
      note: o.note ?? null,
      createdAt: o.createdAt,
      lines: o.lines.map((/** @type {any} */ l) => ({
        product: l.product,
        name: this.planName(l.product, 'Material'),
        requested: l.requested,
        held: held.get(l.product) ?? 0,
        loaded: l.loaded,
        delivered: l.delivered,
        collected: l.collected,
        returned: l.returned,
        pack: l.pack,
      })),
    };
  },

  // ---------- trips ----------
  // Books orders onto a truck: a Today truck booking (truckPlan), or a truck + driver + day, which makes the booking (the driver is asked).
  tripBook(/** @type {any} */ input) {
    requireLive(this);
    requireRule(input && typeof input === 'object', 'Choose the orders and a truck.');
    requireRule(
      Array.isArray(input.orders) && input.orders.length > 0 && input.orders.length <= 20,
      'Choose at least one order.',
    );
    const orders = [...new Set(input.orders)].map((id) => this.repo.get(id, 'order'));
    for (const o of orders)
      requireRule(o.status === 'OPEN', this.orderLabel(o) + ' is ' + ORDER_STATE_WORDS[o.status].toLowerCase() + '.');
    const site = this.tripSite(orders[0].site),
      direction = orders[0].direction;
    requireRule(
      orders.every((o) => o.site === site.id),
      'One site per trip. Book the other site on its own trip.',
    );
    requireRule(
      orders.every((o) => o.direction === direction),
      'A trip either sends or brings back. Book the other on its own trip.',
    );
    const now = this.planNow();
    let tp;
    if (input.truckPlan) {
      tp = this.repo.get(input.truckPlan, 'planItem');
      requireRule(tp.type === 'TRUCK' && tp.status !== 'CANCELLED', 'Choose a truck booked on Today.');
    } else {
      const truck = this.repo.get(input.truck, 'truck');
      requireRule(!truck.retired, truck.name + ' has been removed.');
      const cal = this.planNowCal(),
        day =
          input.day === undefined || input.day === null || input.day === ''
            ? (orders[0].neededOn ?? cal.today) < cal.today
              ? cal.today
              : (orders[0].neededOn ?? cal.today)
            : this.planDay(input.day, cal);
      tp = this.planDayItems(day, 'TRUCK').find(
        (/** @type {any} */ x) => x.truck === truck.id && x.status !== 'CANCELLED',
      );
      if (tp) {
        if (input.driver)
          requireRule(
            tp.driver === input.driver,
            truck.name +
              ' is booked with ' +
              this.planName(tp.driver, 'no driver') +
              ' that day. Change the driver on Today.',
          );
      } else {
        requireRule(typeof input.driver === 'string' && input.driver, 'Choose a driver.');
        const time =
          input.time === undefined || input.time === null || input.time === ''
            ? orders[0].time && (day !== cal.today || this.planAt(day, orders[0].time) > now)
              ? orders[0].time
              : this.tripNextTime(day)
            : input.time;
        tp = this.planTruck({ day, time, truck: truck.id, driver: input.driver }).item;
        tp = this.repo.get(tp.id, 'planItem');
      }
    }
    requireRule(!tp.hire && tp.truck, 'Book one of your own trucks for a trip. Hire trucks come later.');
    // the trip's time: as chosen; else the order's; else the booking's for its first trip, and an hour after the last one for the next
    const others = this.tripRowsBy(
      'objects_trip_plan',
      'trip',
      "json_extract(data,'$.truckPlan')=? AND json_extract(data,'$.state')<>'CANCELLED'",
      tp.id,
    );
    const latest = others
        .map((/** @type {any} */ t) => t.time ?? tp.time)
        .sort()
        .at(-1),
      after = latest ? (PLAN_TIMES.find((t) => t >= addHour(latest)) ?? PLAN_TIMES.at(-1)) : null;
    const number = this.tripCount('trip') + 1,
      time =
        input.time !== undefined && input.time !== null && input.time !== ''
          ? parseTime(input.time)
          : (orders.find((o) => o.time)?.time ?? after ?? tp.time);
    const trip = this.repo.add('trip', {
      number,
      direction,
      truckPlan: tp.id,
      truck: tp.truck,
      site: site.id,
      yard: orders[0].yard,
      orders: orders.map((o) => o.id),
      time,
      state: 'BOOKED',
      steps: {},
      notBack: [],
      flag: null,
      createdAt: iso(now),
      createdBy: this.user.id,
      cancelledAt: null,
      cancelReason: null,
    });
    for (const o of orders) {
      o.status = 'BOOKED';
      o.trip = trip.id;
      this.repo.save(o);
    }
    this.planEdit(tp.id, (/** @type {any} */ x) => {
      if (x.status === 'DONE') Object.assign(x, { status: 'ACTIVE', stage: 'READY', doneAt: null });
      this.planLog(
        x,
        this.tripLabel(trip) +
          ' to ' +
          site.name +
          ' booked (' +
          orders.map((o) => this.orderLabel(o)).join(', ') +
          ').',
        now,
      );
    });
    const view = this.tripView(this.repo.get(trip.id, 'trip'));
    return {
      trip: view,
      message:
        view.label +
        ': ' +
        view.truckName +
        ' with ' +
        view.driverName +
        (direction === 'BACK' ? ' from ' : ' to ') +
        site.name +
        ' on ' +
        dayLabel(view.day) +
        ' at ' +
        timeWords(view.time) +
        '.',
    };
  },
  // The booking time when none is given: 7:00, or today the next half hour still ahead (a truck is never booked for a time gone).
  /** @param {string} day */
  tripNextTime(day) {
    if (day !== this.planToday()) return undefined;
    const now = this.planNow();
    return PLAN_TIMES.find((t) => this.planAt(day, t) > now) ?? undefined;
  },
  tripCancel(/** @type {any} */ input) {
    requireLive(this);
    const trip = this.repo.get(input?.id, 'trip');
    requireRule(
      ['BOOKED', 'PACKED'].includes(trip.state),
      trip.state === 'CANCELLED'
        ? 'This trip is already cancelled.'
        : 'It has already left. Confirm the rest of it instead.',
    );
    const now = this.planNow(),
      reason = optText(input.reason, 'A reason');
    for (const id of trip.orders) {
      const o = this.repo.get(id, 'order');
      if (o.status === 'BOOKED') {
        o.status = 'OPEN';
        o.trip = null;
        this.repo.save(o);
      }
    }
    Object.assign(trip, { state: 'CANCELLED', cancelledAt: iso(now), cancelReason: reason, flag: null });
    this.repo.save(trip);
    this.planEdit(trip.truckPlan, (/** @type {any} */ x) =>
      this.planLog(x, this.tripLabel(trip) + ' cancelled by ' + this.user.name + '.', now),
    );
    this.tripPlanSync(trip.truckPlan, now);
    return {
      trip: this.tripView(trip),
      message: this.tripLabel(trip) + ' cancelled. Its orders wait for another truck.',
    };
  },
  // An order left a trip (cancelled): a trip left with no orders is cancelled too.
  /** @param {string} tripId @param {string} orderId @param {string} why */
  tripDropOrder(tripId, orderId, why) {
    const trip = this.repo.get(tripId, 'trip');
    trip.orders = trip.orders.filter((/** @type {string} */ id) => id !== orderId);
    if (!trip.orders.length && ['BOOKED', 'PACKED'].includes(trip.state)) {
      trip.state = 'CANCELLED';
      trip.cancelledAt = iso(this.planNow());
      trip.cancelReason = why;
    }
    this.repo.save(trip);
    this.tripPlanSync(trip.truckPlan, this.planNow());
  },
  /** @param {any} t */
  tripLabel(t) {
    return 'Trip ' + t.number;
  },
  /** @param {any} trip @returns {any} */
  tripPlan(trip) {
    try {
      return this.repo.get(trip.truckPlan, 'planItem');
    } catch {
      return null;
    }
  },
  // Per product: what the trip's orders asked for, what is held for them now, and what each step recorded.
  /** @param {any} trip */
  tripLines(trip) {
    /** @type {Map<string,any>} */
    const m = new Map();
    const line = (/** @type {string} */ p) => {
      let l = m.get(p);
      if (!l)
        m.set(
          p,
          (l = {
            product: p,
            name: this.planName(p, 'Material'),
            asked: 0,
            held: 0,
            loaded: 0,
            delivered: 0,
            collected: 0,
            returned: 0,
            pack: null,
          }),
        );
      return l;
    };
    for (const id of trip.orders) {
      let o = null;
      try {
        o = this.repo.get(id, 'order');
      } catch {}
      if (!o) continue;
      const held = this.orderHeld(o.id);
      for (const x of o.lines) {
        const l = line(x.product);
        l.asked += x.requested;
        l.held += held.get(x.product) ?? 0;
        l.loaded += x.loaded;
        l.delivered += x.delivered;
        l.collected += x.collected;
        l.returned += x.returned;
        l.pack = x.pack ?? l.pack;
      }
    }
    const onTruck = this.tripOnTruck(trip);
    return [...m.values()].map((l) => ({ ...l, onTruck: onTruck.get(l.product) ?? 0 }));
  },
  // Pieces of this trip on its truck now (the containers it loaded or collected that are still there).
  /** @param {any} trip @returns {Map<string,number>} */
  tripOnTruck(trip) {
    const m = new Map(),
      tp = this.tripPlan(trip);
    if (!tp?.truck) return m;
    for (const c of this.tripRows(
      'container',
      NOT_RETIRED + " AND json_extract(data,'$.location')=? AND json_extract(data,'$.trip')=?",
      tp.truck,
      trip.id,
    ))
      for (const l of this.repo.lines(c.id)) add(m, l.product_id, l.quantity);
    return m;
  },
  // What may be confirmed next on a trip.
  /** @param {any} trip @returns {string[]} */
  tripNext(trip) {
    if (trip.direction === 'OUT')
      return (
        {
          BOOKED: ['packConfirmed', 'tripLoaded'],
          PACKED: ['tripLoaded'],
          LOADED: ['tripDelivered', 'tripReturned'], // Back at yard from here: it came back, not delivered
          DELIVERED: trip.steps.RETURNED ? [] : ['tripReturned'],
          DELIVERED_SHORT: ['tripReturned'],
        }[trip.state] ?? []
      );
    return { BOOKED: ['tripCollected'], PACKED: ['tripCollected'], COLLECTED: ['tripReturned'] }[trip.state] ?? [];
  },
  /** @param {any} trip @param {{crew?:boolean}} [opts] */
  tripView(trip, { crew = false } = {}) {
    const tp = this.tripPlan(trip);
    let site = null,
      truck = null,
      driver = null;
    try {
      site = this.repo.get(trip.site, 'site');
    } catch {}
    try {
      truck = tp?.truck ? this.repo.get(tp.truck, 'truck') : null;
    } catch {}
    try {
      driver = tp?.driver ? this.repo.get(tp.driver, 'driver') : null;
    } catch {}
    const next = this.tripNext(trip).filter((a) => !crew || TRIP_CONFIRM_OPS.includes(a));
    return {
      id: trip.id,
      number: trip.number,
      label: this.tripLabel(trip),
      direction: trip.direction,
      state: trip.state,
      stateWords: this.tripStateWords(trip),
      flag: trip.flag ?? null,
      day: tp?.day ?? null,
      time: trip.time ?? tp?.time ?? null,
      truckPlan: trip.truckPlan,
      truck: tp?.truck ?? null,
      truckName: truck?.name ?? 'The truck',
      driver: tp?.driver ?? null,
      driverName: driver?.name ?? 'No driver',
      site: trip.site,
      siteName: site?.name ?? 'The site',
      address: site?.address ?? null,
      contact: site?.contact ?? null,
      phone: site?.phone ?? null,
      orders: trip.orders.map((/** @type {string} */ id) => {
        try {
          const o = this.repo.get(id, 'order');
          return { id, label: this.orderLabel(o), status: o.status };
        } catch {
          return { id, label: '?', status: null };
        }
      }),
      lines: this.tripLines(trip),
      steps: trip.steps,
      notBack: trip.notBack ?? [],
      undelivered: !!trip.undelivered,
      next,
    };
  },
  // "Loaded, not delivered yet"; "Not confirmed" once the clock has flagged it; "Back at yard, 3 not counted back" after a short count.
  /** @param {any} trip */
  tripStateWords(trip) {
    if (trip.flag?.code === 'UNCONFIRMED_TRIP') return 'Not confirmed';
    const notBack = (trip.notBack ?? []).reduce((/** @type {number} */ n, /** @type {any} */ l) => n + l.quantity, 0);
    if (trip.state === 'RETURNED' && trip.undelivered)
      return UNDELIVERED_WORDS + (notBack ? ', ' + plural(notBack, 'piece') + ' not counted back' : '');
    if (trip.state === 'RETURNED' && notBack) return 'Back at yard, ' + plural(notBack, 'piece') + ' not counted back';
    return TRIP_STATE_WORDS[trip.state];
  },
  // Today's trips and open orders for the office (GET /api/trips?day=): the truck page, Today and the docket.
  /** @param {{day?:string|null}} [query] */
  tripsView({ day = null } = {}) {
    requireLive(this);
    const cal = this.planNowCal(),
      d = day && DAY.test(day) ? day : cal.today;
    const ops = this.auth.permissions(this.user).includes('operations.manage'),
      sites = new Set(
        this.repo
          .all('site')
          .filter((/** @type {any} */ s) => ops || s.supervisor === this.user.id)
          .map((/** @type {any} */ s) => s.id),
      );
    // the day's trips, earlier ones still open, and one booked for a later day that already went on this day (booked for tomorrow, done today)
    const stepOn = (/** @type {any} */ t) =>
      Object.values(t.steps ?? {}).some((/** @type {any} */ x) => this.clockDay(Date.parse(x.at)) === d);
    const trips = cached(
      this.db,
      "SELECT t.id,t.kind,t.data,t.version,json_extract(p.data,'$.day') day FROM objects t JOIN objects p ON p.company_id=t.company_id AND p.id=json_extract(t.data,'$.truckPlan') WHERE t.company_id=? AND t.kind='trip' AND (json_extract(p.data,'$.day')=? OR (json_extract(t.data,'$.state') IN ('BOOKED','PACKED','LOADED','DELIVERED_SHORT','COLLECTED') AND json_extract(p.data,'$.day')<=?) OR (json_extract(p.data,'$.day')>? AND json_extract(p.data,'$.day')<=? AND json_extract(t.data,'$.state') NOT IN ('BOOKED','PACKED','CANCELLED'))) ORDER BY t.rowid",
    )
      .all(this.repo.company, d, d, d, addDays(d, 14))
      .map((/** @type {any} */ r) => [r.day, this.repo.decode(r)])
      .filter(([pd, t]) => sites.has(t.site) && (pd <= d || stepOn(t)))
      .map(([, t]) => this.tripView(t));
    trips.sort((a, b) => String(a.time).localeCompare(String(b.time)) || a.number - b.number);
    const orders = this.tripRowsBy(
      'objects_order_status',
      'order',
      "json_extract(data,'$.status') IN ('OPEN','BOOKED','LOADED','COLLECTED')",
    )
      .filter((/** @type {any} */ o) => sites.has(o.site))
      .map((/** @type {any} */ o) => this.orderView(o));
    // the earliest time a step can be dated now (the Office's "Earlier" starts no further back)
    // booked for a later day and not gone yet: a truck's page shows its next trips too
    const upcoming = cached(
      this.db,
      "SELECT t.id,t.kind,t.data,t.version FROM objects t JOIN objects p ON p.company_id=t.company_id AND p.id=json_extract(t.data,'$.truckPlan') WHERE t.company_id=? AND t.kind='trip' AND json_extract(t.data,'$.state') IN ('BOOKED','PACKED') AND json_extract(p.data,'$.day')>? ORDER BY json_extract(p.data,'$.day'),json_extract(t.data,'$.time') LIMIT 20",
    )
      .all(this.repo.company, d)
      .map((/** @type {any} */ r) => this.repo.decode(r))
      .filter((/** @type {any} */ t) => sites.has(t.site))
      .map((/** @type {any} */ t) => this.tripView(t));
    return {
      day: d,
      today: cal.today,
      now: this.tripHm(this.planNow()), // the company's clock, for the Office booking form
      dayOver: this.planNow() >= this.planAt(cal.today, DAY_END),
      openFrom: iso(this.tripOpenFrom(this.planNow())),
      trips,
      upcoming,
      orders,
    };
  },

  // ---------- confirmations ----------
  packConfirmed(/** @type {any} */ input) {
    return this.tripConfirm('packConfirmed', input);
  },
  tripLoaded(/** @type {any} */ input) {
    return this.tripConfirm('tripLoaded', input);
  },
  tripDelivered(/** @type {any} */ input) {
    return this.tripConfirm('tripDelivered', input);
  },
  tripCollected(/** @type {any} */ input) {
    return this.tripConfirm('tripCollected', input);
  },
  tripReturned(/** @type {any} */ input) {
    return this.tripConfirm('tripReturned', input);
  },
  // The driver this signed-in person is (a CREW sign-in), or null.
  /** @param {string} userId */
  crewDriverOf(userId) {
    if (this.user.crew?.driver && this.user.id === userId) return this.user.crew.driver;
    return (
      cached(this.db, 'SELECT driver_id FROM crew_links WHERE company_id=? AND user_id=? LIMIT 1').get(
        this.repo.company,
        userId,
      )?.driver_id ?? null
    );
  },
  // Who confirms: the trip's own driver (PERSON), or the office for them (ON_BEHALF). A driver never sees another driver's trip (404).
  /** @param {any} trip @param {any} tp */
  tripWho(trip, tp) {
    const ops = this.auth.permissions(this.user).includes('operations.manage'),
      me = this.crewDriverOf(this.user.id),
      mine = !!me && !!tp?.driver && me === tp.driver;
    if (this.user.crew || !ops) {
      if (!mine) throw new AppError(404, 'Record not found in your company.');
      return { kind: 'PERSON', onBehalfOf: null };
    }
    return mine
      ? { kind: 'PERSON', onBehalfOf: null }
      : { kind: 'ON_BEHALF', onBehalfOf: tp?.driver ? 'driver:' + tp.driver : null };
  },
  // The first moment a confirmation may be dated: 7 days back, never before the real yard started (part 4's statements close periods).
  /** @param {number} now */
  tripOpenFrom(now) {
    const started = Date.parse(
      cached(this.db, 'SELECT created_at FROM companies WHERE id=?').get(this.repo.company)?.created_at ?? iso(now),
    );
    return Math.max(started, now - BACKDATE_DAYS * 86400000);
  },
  /** @param {number} ms */
  tripHm(ms) {
    return zoneParts(ms, this.clockZone()).hm;
  },
  // When a step happened. Now, unless a time is sent:
  //  - a tap on the driver's own phone (atSource 'tap', queued while offline; only from a phone's device sign-in, never the office): the
  //    phone's clock at the tap, kept inside what is possible (never in the future, never before the trip was booked or its last step), so a
  //    phone whose clock is a little off never loses a tap. A tap sent more than 15 minutes later is kept with its own reason ("Tapped on the
  //    phone at 09:05, sent 15:00") and audited like any earlier time;
  //  - a time a person typed: never in the future, within the open period, never before the last step; more than 15 minutes back needs a
  //    reason, and so does a time when the same truck was, on record, out on another trip.
  // A collection is never dated to a moment when the site did not, on record, hold what was collected.
  /** @param {any} trip @param {TripStep} step @param {any} input @param {number} now @param {any} [tp] */
  tripWhen(trip, step, input, now, tp = null) {
    const prev = Object.entries(trip.steps ?? {})
      .map(([s, x]) => [s, Date.parse(/** @type {any} */ (x).at)])
      .sort((a, b) => Number(b[1]) - Number(a[1]))[0];
    const openFrom = this.tripOpenFrom(now);
    let ms = now,
      reason = null;
    if (input.at !== undefined && input.at !== null && input.at !== '') {
      requireRule(
        typeof input.at === 'string' && ISO.test(input.at) && !Number.isNaN(Date.parse(input.at)),
        'Choose a valid time.',
      );
      ms = Date.parse(input.at);
      if (input.atSource === 'tap' && this.user.crew) {
        const floor = Math.max(openFrom, Date.parse(trip.createdAt), prev ? Number(prev[1]) : 0);
        let at = Math.min(Math.max(ms, floor), now);
        if (step === 'COLLECTED' && this.tripSiteShort(trip, input, at, now)) at = now;
        const late = now - at > BACKDATE_FREE_MS;
        return {
          ms: at,
          at: iso(at),
          reason: late ? 'Tapped on the phone at ' + this.tripWhenWords(at, now) + ', sent ' + this.tripHm(now) : null,
        };
      }
      requireRule(ms <= now + SKEW_MS, 'That time is in the future.');
      requireRule(
        ms >= openFrom,
        'That is too far back. A time can go back ' +
          BACKDATE_DAYS +
          ' days at most, and not before ' +
          this.tripWhenWords(openFrom, now) +
          (openFrom > now - BACKDATE_DAYS * 86400000 ? ', when your real yard started.' : '.'),
      );
      ms = Math.min(ms, now);
      const busy = tp?.truck ? this.tripTruckBusyAt(tp.truck, trip.id, ms) : null;
      if (now - ms > BACKDATE_FREE_MS || busy) {
        reason = optText(input.reason, 'The reason', 200);
        requireRule(
          reason,
          busy
            ? busy + ' Check the time, or say why.'
            : 'Say why the time is earlier (for example: paper docket, keyed in later).',
        );
      }
    }
    if (prev)
      requireRule(
        ms >= Number(prev[1]),
        'That is before it was ' +
          STEP_WORDS[/** @type {TripStep} */ (prev[0])].toLowerCase() +
          ' (' +
          this.tripHm(Number(prev[1])) +
          ').',
      );
    if (step === 'COLLECTED' && ms < now) {
      const short = this.tripSiteShort(trip, input, ms, now);
      if (short) throw new AppError(409, short + ' Check the time.');
    }
    return { ms, at: iso(ms), reason };
  },
  // "09:05", or "Tue 13 Oct 09:05" when it is not today (company time).
  /** @param {number} ms @param {number} now */
  tripWhenWords(ms, now) {
    const a = zoneParts(ms, this.clockZone()),
      b = zoneParts(now, this.clockZone());
    return a.day === b.day ? a.hm : dayLabel(a.day) + ' ' + a.hm;
  },
  // Was the truck, on record, out on another trip at that moment (between its Loaded & left or Collected and its Delivered or Back at yard)?
  // Returns the words, or null.
  /** @param {string} truckId @param {string} tripId @param {number} ms */
  tripTruckBusyAt(truckId, tripId, ms) {
    const from = iso(ms - 2 * 86400000);
    for (const r of cached(
      this.db,
      "SELECT trip_id,step,occurred_at FROM trip_confirmation WHERE company_id=? AND occurred_at>=? AND step IN ('LOADED','DELIVERED','COLLECTED','RETURNED') ORDER BY occurred_at",
    )
      .all(this.repo.company, from)
      .reduce((/** @type {Map<string,any>} */ m, /** @type {any} */ r) => {
        if (r.trip_id === tripId) return m;
        const x = m.get(r.trip_id) ?? {};
        x[r.step] = Date.parse(r.occurred_at);
        return m.set(r.trip_id, x);
      }, new Map())) {
      const [id, x] = r,
        start = x.LOADED ?? x.COLLECTED,
        end = x.COLLECTED && x.LOADED === undefined ? x.RETURNED : (x.DELIVERED ?? x.RETURNED);
      if (start === undefined || !(ms > start) || (end !== undefined && !(ms < end))) continue;
      let t = null;
      try {
        t = this.repo.get(id, 'trip');
      } catch {}
      const tp2 = t ? this.tripPlan(t) : null;
      if (!t || (tp2?.truck ?? t.truck) !== truckId) continue;
      return (
        this.planName(truckId, 'The truck') +
        ' was on ' +
        this.tripLabel(t) +
        ' then (left ' +
        this.tripHm(start) +
        (end !== undefined ? ', ' + (x.DELIVERED ? 'delivered ' : 'back ') + this.tripHm(end) : ', not back yet') +
        ').'
      );
    }
    return null;
  },
  // A collection dated at `ms`: did the site, on record, hold what is collected from then until now? The site's pieces now, less what was
  // delivered there after `ms`, plus what was collected from there after `ms` (confirmations by when they happened), may never drop below it.
  // Returns the words when it did not, else null. Unrelated later deliveries never stop an earlier collection from being keyed in.
  /** @param {any} trip @param {any} input @param {number} ms @param {number} now */
  tripSiteShort(trip, input, ms, now) {
    if (!(ms < now)) return null;
    const lines = this.tripLines(trip),
      want = this.tripInputLines(input, new Map(lines.map((/** @type {any} */ l) => [l.product, l.asked])));
    if (!want.size) return null;
    const have = new Map();
    for (const c of this.tripContainersAt(trip.site))
      for (const l of this.repo.lines(c.id)) if (want.has(l.product_id)) add(have, l.product_id, l.quantity);
    const rows = cached(
      this.db,
      "SELECT step,lines,occurred_at FROM trip_confirmation WHERE company_id=? AND site_id=? AND step IN ('DELIVERED','COLLECTED') AND occurred_at>?",
    )
      .all(this.repo.company, trip.site, iso(ms))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
    for (const [p, q] of want) {
      let bal = have.get(p) ?? 0,
        low = bal;
      for (const r of rows) {
        const n = (JSON.parse(r.lines).find((/** @type {any} */ x) => x.product === p)?.quantity ?? 0) * 1;
        bal += r.step === 'DELIVERED' ? -n : n;
        low = Math.min(low, bal);
      }
      if (low < q)
        return (
          this.planSiteName(trip.site) +
          ' had only ' +
          Math.max(0, low) +
          ' × ' +
          this.planName(p, 'that part') +
          ' on record at ' +
          this.tripWhenWords(ms, now) +
          '.'
        );
    }
    return null;
  },
  // The confirmed lines: per product, 0 to a million, each product once; left out = what is expected (a one-tap confirm).
  /** @param {any} input @param {Map<string,number>} expected */
  tripInputLines(input, expected) {
    if (input.lines === undefined || input.lines === null) return new Map([...expected].filter(([, q]) => q > 0));
    requireRule(Array.isArray(input.lines) && input.lines.length <= 60, 'List what went, one line per material.');
    const m = new Map();
    for (const l of input.lines) {
      requireRule(l && typeof l.product === 'string' && l.product, 'Pick a material.');
      requireRule(!m.has(l.product), 'Each material once, please.');
      m.set(l.product, integer(l.quantity, 'Amount', 0, 1000000));
    }
    for (const p of m.keys()) this.effective(p);
    return new Map([...m].filter(([, q]) => q > 0));
  },
  /** @param {string} action @param {any} input */
  tripConfirm(action, input) {
    requireLive(this);
    requireRule(input && typeof input === 'object', 'Choose a trip.');
    const step = STEP_OF[action],
      trip = this.repo.get(input.trip, 'trip'),
      tp = this.tripPlan(trip),
      who = step === 'PACKED' ? { kind: 'PERSON', onBehalfOf: null } : this.tripWho(trip, tp),
      now = this.planNow();
    if (trip.steps?.[step]) {
      const s = trip.steps[step];
      throw Object.assign(
        new AppError(
          409,
          'Already confirmed: ' +
            STEP_WORDS[step].toLowerCase() +
            ' at ' +
            this.tripHm(Date.parse(s.at)) +
            ' by ' +
            s.byName +
            '.',
        ),
        { code: 'ALREADY_CONFIRMED', detail: this.tripAlready(trip, step, input) },
      );
    }
    requireRule(trip.state !== 'CANCELLED', 'This trip was cancelled.');
    const next = this.tripNext(trip);
    if (!next.includes(action))
      throw new AppError(
        409,
        next.length
          ? 'First confirm ' +
              STEP_WORDS[
                STEP_OF[next.find((a) => a !== 'packConfirmed' && a !== 'tripReturned') ?? next[0]]
              ].toLowerCase() +
              '.'
          : 'This trip is finished.',
      );
    requireRule(tp?.truck, 'This trip has no truck. Book one on Today.');
    if (step === 'LOADED' || step === 'COLLECTED') {
      let site = null;
      try {
        site = this.repo.get(trip.site, 'site');
      } catch {}
      requireRule(site?.status === 'ACTIVE', (site?.name ?? 'That site') + ' was removed. Cancel this trip.');
    }
    const when = this.tripWhen(trip, step, input, now, tp),
      receivedBy = step === 'DELIVERED' ? optText(input.receivedBy, 'Received by', 80) : null;
    if (step === 'DELIVERED') requireRule(receivedBy, 'Who received it? Type their name.');
    const byName = this.user.name ?? 'Someone';
    const prov = this.repo.provenance;
    this.repo.provenance = {
      kind: who.kind,
      onBehalfOf: who.onBehalfOf,
      origin: 'command:' + action,
      occurredAt: step === 'PACKED' ? null : when.at,
    };
    /** @type {Map<string,number>} */
    let done;
    try {
      done = this.tripStep(trip, tp, step, input, when);
    } finally {
      this.repo.provenance = prov ? { ...prov, kind: who.kind, onBehalfOf: who.onBehalfOf, occurredAt: null } : null;
    }
    const id = randomUUID(),
      lines = [...done].map(([product, quantity]) => ({ product, quantity }));
    cached(this.db, INSERT_CONFIRMATION).run(
      id,
      this.repo.company,
      trip.id,
      trip.site,
      step,
      JSON.stringify(lines),
      receivedBy,
      when.at,
      iso(now),
      this.user.id,
      who.kind,
      who.onBehalfOf,
      'command:' + action,
      when.reason,
      this.key ?? randomUUID(),
    );
    if (when.reason)
      this.auth.audit(this.user, 'trip.backdated', {
        trip: trip.id,
        step,
        occurredAt: when.at,
        recordedAt: iso(now),
        reason: when.reason,
      });
    const fresh = this.repo.get(trip.id, 'trip');
    fresh.steps = {
      ...(fresh.steps ?? {}),
      [step]: {
        id,
        at: when.at,
        recordedAt: iso(now),
        by: this.user.id,
        byName,
        kind: who.kind,
        onBehalfOf: who.onBehalfOf,
        ...(receivedBy ? { receivedBy } : {}),
        ...(when.reason ? { reason: when.reason } : {}),
      },
    };
    fresh.flag = null;
    this.tripAfter(fresh, tp, step, done, when, now);
    this.repo.save(fresh);
    if (step === 'LOADED' || step === 'COLLECTED') this.tripDriverYes(tp, now);
    this.tripPlanSync(fresh.truckPlan, now, fresh);
    const words = this.tripStepWords(fresh, step);
    return {
      trip: this.tripView(fresh, { crew: !!this.user.crew }),
      confirmation: { id, step, at: when.at },
      message: words,
    };
  },
  // A trip that left means its driver drove it: the booking's "Can you make it?" is answered yes (Today stops waiting for an answer).
  /** @param {any} tp @param {number} now */
  tripDriverYes(tp, now) {
    const m = tp?.message ? this.planMsg(tp.message) : null;
    if (!m || !['SENT', 'WAITING_TO_SEND'].includes(m.status) || m.closedAt) return;
    this.planAnswerMsg(m, { yes: true, by: this.user.id, via: 'TRIP' }, now);
    this.planEdit(tp.id, (/** @type {any} */ x) => {
      if (x.stage === 'ASKING') x.stage = 'READY';
      x.heard = m.id + ':YES';
      this.planLog(x, (m.personName || 'The driver') + ' is driving it (the trip left).', now);
    });
  },
  // A step confirmed twice (the office for the driver, then the driver's phone once it had signal): what was recorded, and whether this
  // second confirmation says the same (the same pieces and, for a delivery, the same name). The phone shows the difference to the driver.
  /** @param {any} trip @param {TripStep} step @param {any} input */
  tripAlready(trip, step, input) {
    const s = trip.steps[step],
      row = cached(this.db, 'SELECT lines,received_by FROM trip_confirmation WHERE company_id=? AND id=?').get(
        this.repo.company,
        s.id,
      );
    const lines = row ? JSON.parse(row.lines) : [],
      got = new Map(lines.map((/** @type {any} */ l) => [l.product, l.quantity]));
    // what this confirmation would have recorded: its own lines, or the one-tap amounts of that step
    const tl = this.tripLines(trip),
      oneTap = new Map(
        tl.map((/** @type {any} */ l) => [
          l.product,
          step === 'LOADED' || step === 'COLLECTED' || step === 'PACKED'
            ? l.asked
            : step === 'DELIVERED'
              ? l.loaded
              : trip.direction === 'BACK'
                ? l.collected
                : l.loaded - l.delivered,
        ]),
      );
    let said = oneTap;
    try {
      said = this.tripInputLines(input ?? {}, oneTap);
    } catch {}
    said = new Map([...said].filter(([, q]) => q > 0));
    const sameLines = said.size === got.size && [...said].every(([p, q]) => got.get(p) === q),
      norm = (/** @type {any} */ v) =>
        String(v ?? '')
          .trim()
          .replace(/\s+/g, ' ')
          .toLowerCase(),
      sameName = step !== 'DELIVERED' || !input?.receivedBy || norm(input.receivedBy) === norm(row?.received_by);
    const named = (/** @type {Map<string,number>} */ m) =>
      [...m].map(([product, quantity]) => ({ product, name: this.planName(product, 'Material'), quantity }));
    return {
      same: sameLines && sameName,
      step,
      recorded: {
        at: s.at,
        byName: s.byName,
        kind: s.kind,
        receivedBy: row?.received_by ?? null,
        lines: named(got),
      },
      said: { lines: named(said), receivedBy: input?.receivedBy ?? null },
    };
  },
  // A phone's tap that arrived after the office had already recorded that step differently: the office is told once (per tap).
  /** @param {string} action @param {any} input @param {string} key @param {any} detail */
  crewConflict(action, input, key, detail) {
    if (!detail || detail.same) return;
    const k = 'crew-conflict:' + key;
    if (
      cached(
        this.db,
        "SELECT 1 FROM objects WHERE company_id=? AND kind='notification' AND json_extract(data,'$.key')=?",
      ).get(this.repo.company, k)
    )
      return;
    let trip = null;
    try {
      trip = this.repo.get(input?.trip, 'trip');
    } catch {
      return;
    }
    const w = (/** @type {any} */ x) =>
      x.lines.map((/** @type {any} */ l) => l.quantity + ' × ' + l.name).join(', ') +
      (x.receivedBy ? ', received by ' + x.receivedBy : '');
    const n = this.notify(
      'Driver says different',
      this.tripLabel(trip) +
        ' ' +
        STEP_WORDS[/** @type {TripStep} */ (detail.step)].toLowerCase() +
        ': ' +
        (this.user.name ?? 'The driver') +
        "'s phone said " +
        w(detail.said) +
        '. The office recorded ' +
        w(detail.recorded) +
        '. Check with them.',
      trip.site,
    );
    n.key = k;
    this.repo.save(n);
  },
  // "Loaded & left 7:42 (Dave)", "Delivered 8:21 · received by J. Smith": the words a step leaves on the trip, Today and the board.
  // now: say the day too when it was not today ("Delivered Tue 13 Oct 09:00 · received by ...").
  /** @param {any} trip @param {TripStep} step @param {number} [now] */
  tripStepWords(trip, step, now) {
    const s = trip.steps[step];
    if (!s) return '';
    const t = now ? this.tripWhenWords(Date.parse(s.at), now) : this.tripHm(Date.parse(s.at));
    if (step === 'DELIVERED')
      return (
        (trip.state === 'DELIVERED_SHORT' ? 'Delivered short ' : 'Delivered ') + t + ' · received by ' + s.receivedBy
      );
    if (step === 'RETURNED' && trip.undelivered)
      return (
        'Back at yard ' +
        t +
        ', not delivered' +
        (s.kind === 'ON_BEHALF' ? ' (recorded by ' + s.byName + ')' : ' (' + s.byName + ')')
      );
    return (
      STEP_WORDS[step] + ' ' + t + (s.kind === 'ON_BEHALF' ? ' (recorded by ' + s.byName + ')' : ' (' + s.byName + ')')
    );
  },
  // The stock side of a step. Returns the pieces confirmed, per product.
  /** @param {any} trip @param {any} tp @param {TripStep} step @param {any} input @param {{ms:number,at:string}} when */
  tripStep(trip, tp, step, input, when) {
    const truckId = tp.truck,
      lines = this.tripLines(trip);
    if (step === 'PACKED')
      return this.tripInputLines(input, new Map(lines.map((/** @type {any} */ l) => [l.product, l.asked])));
    if (step === 'LOADED' || step === 'COLLECTED') {
      const from = step === 'LOADED' ? trip.yard : trip.site,
        want = this.tripInputLines(input, new Map(lines.map((/** @type {any} */ l) => [l.product, l.asked])));
      requireRule(want.size, 'Nothing to confirm: say what went on the truck.');
      this.tripTruckFree(truckId, trip);
      const picks = this.tripTake(trip, from, want);
      this.tripMove(picks, from, truckId, step, trip);
      return want;
    }
    // DELIVERED and RETURNED take what is on the truck for this trip
    const onTruck = this.tripOnTruck(trip),
      want = this.tripInputLines(input, onTruck);
    for (const [p, q] of want)
      requireRule(
        q <= (onTruck.get(p) ?? 0),
        'Only ' + (onTruck.get(p) ?? 0) + ' ' + this.planName(p, 'of that') + ' went on the truck for this trip.',
      );
    if (step === 'DELIVERED') requireRule(want.size, 'Nothing to confirm: say what was delivered.');
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
            Number(this.repo.lines(a.c.id).length !== 1 || a.have > left) -
              Number(this.repo.lines(b.c.id).length !== 1 || b.have > left) ||
            b.have - a.have ||
            String(a.c.name).localeCompare(String(b.c.name)),
        );
      for (const x of holders) {
        if (!left) break;
        const n = Math.min(left, x.have);
        picks.push({ container: x.c.id, product: p, quantity: n });
        left -= n;
      }
    }
    this.tripMove(picks, truckId, step === 'DELIVERED' ? trip.site : trip.yard, step, trip);
    return want;
  },
  // A truck still carrying another trip's pieces (loaded or collected, not set down) cannot be loaded again until that is confirmed.
  /** @param {string} truckId @param {any} trip */
  tripTruckFree(truckId, trip) {
    const other = this.tripRowsBy(
      'objects_trip_state',
      'trip',
      "json_extract(data,'$.state') IN ('LOADED','DELIVERED_SHORT','COLLECTED') AND (json_extract(data,'$.truck')||'')=?",
      truckId,
    ).find((/** @type {any} */ t) => t.id !== trip.id);
    if (other)
      throw new AppError(
        409,
        this.planName(truckId, 'The truck') +
          ' still has ' +
          this.tripLabel(other) +
          ' on board (' +
          TRIP_STATE_WORDS[other.state].toLowerCase() +
          '). Confirm that first.',
      );
  },
  // The exact pieces for a Loaded & left or Collected: first what the trip's orders hold (oldest order first), then free stock for any extra.
  // Every hold of the trip's orders is closed (used, or let go: nothing more is held for a trip that has left).
  /** @param {any} trip @param {string} from @param {Map<string,number>} want @returns {Pick[]} */
  tripTake(trip, from, want) {
    /** @type {Pick[]} */
    const picks = [];
    const taken = new Map();
    const res = trip.orders.flatMap((/** @type {string} */ id) => this.orderHolds(id));
    for (const r of res) {
      // a hold is used only for pieces really there now (a count or a removal since may have left fewer; the rest is picked from free stock)
      let there = 0;
      try {
        const c = this.repo.get(r.container, 'container');
        if (!c.retired && c.location === from)
          there = this.repo.quantity(c.id, r.product) - (taken.get(r.container + '|' + r.product) ?? 0);
      } catch {}
      const left = want.get(r.product) ?? 0,
        used = Math.min(left, r.quantity, Math.max(0, there), Math.max(0, left - (taken.get('#' + r.product) ?? 0)));
      if (used > 0) {
        picks.push({ container: r.container, product: r.product, quantity: used });
        add(taken, r.container + '|' + r.product, used);
        add(taken, '#' + r.product, used);
      }
      this.repo.remove(r.id, 'reservation'); // used, or let go (orderRelease says why a hold is not kept)
    }
    for (const [p, q] of want) {
      const need = q - (taken.get('#' + p) ?? 0);
      if (need <= 0) continue;
      const got = this.tripPick(from, p, need, taken);
      if (got.short > 0) {
        const place = from === trip.yard ? 'in the yard' : 'at ' + this.planSiteName(from);
        throw new AppError(
          409,
          'Only ' +
            (need - got.short) +
            ' more ' +
            this.planName(p, 'of that') +
            ' free ' +
            place +
            '. Change the amount to what really went.',
        );
      }
      for (const x of got.picks) {
        picks.push(x);
        add(taken, x.container + '|' + x.product, x.quantity);
      }
    }
    return picks;
  },
  // Moves exact pieces from one place to another: a container whose whole content goes (and nothing else holds it) moves as it is; the rest
  // are split into one new bundle at the same place first (SPLIT), and the bundle moves. One ledger row per container and product (event =
  // the step), with the place ids as source and destination. Loose pieces set down at a yard or site join that place's one loose bundle
  // (CONSOLIDATED, no change of place; the emptied bundle is retired), so a real yard does not collect a bundle per trip.
  /** @param {Pick[]} picks @param {string} from @param {string} to @param {string} event @param {any} trip */
  tripMove(picks, from, to, event, trip) {
    /** @type {Map<string,Map<string,number>>} */
    const by = new Map();
    for (const p of picks) {
      if (!(p.quantity > 0)) continue;
      let m = by.get(p.container);
      if (!m) by.set(p.container, (m = new Map()));
      add(m, p.product, p.quantity);
    }
    const held = this.tripHeldMap(),
      /** @type {any[]} */ whole = [],
      /** @type {any[]} */ split = [];
    for (const [cid, m] of by) {
      const c = this.repo.get(cid, 'container');
      requireRule(c.location === from, 'Those pieces are not where the records say. Refresh and try again.');
      const lines = this.repo.lines(cid),
        all =
          lines.length > 0 &&
          lines.every((/** @type {any} */ l) => (m.get(l.product_id) ?? 0) === l.quantity) &&
          m.size === lines.length &&
          ![...held.keys()].some((k) => k.startsWith(cid + '|'));
      if (all) whole.push(c);
      else for (const [p, q] of m) split.push({ c, product: p, quantity: q });
    }
    if (split.length) {
      const bundle = this.tripBundle(from, trip);
      for (const s of split) {
        this.repo.balance(s.c.id, s.product, -s.quantity);
        this.repo.balance(bundle.id, s.product, s.quantity);
        this.repo.event(this.user.id, 'SPLIT', {
          container: bundle.id,
          product: s.product,
          quantity: s.quantity,
          source: s.c.id,
          destination: bundle.id,
          reason: 'Split from ' + s.c.name + ' for ' + this.tripLabel(trip),
          key: this.key,
        });
      }
      whole.push(this.repo.get(bundle.id, 'container'));
    }
    const words = STEP_WORDS[/** @type {TripStep} */ (event)] + ' · ' + this.tripLabel(trip),
      fromKind = this.repo.get(from).kind,
      toKind = this.repo.get(to).kind;
    for (const c of whole) {
      for (const l of this.repo.lines(c.id))
        this.repo.event(this.user.id, event, {
          container: c.id,
          product: l.product_id,
          quantity: l.quantity,
          source: from,
          destination: to,
          reason: words,
          key: this.key,
        });
      if (fromKind === 'yard' && !c.bundle) c.home = { location: from, x: c.x, y: c.y, rotation: c.rotation ?? 0 };
      // a stillage stacked on this one stays where it is, on the ground now (a real yard's map is a picture: the forklift took it off first)
      for (const above of this.tripRows('container', NOT_RETIRED + " AND json_extract(data,'$.support')=?", c.id))
        if (!whole.some((w) => w.id === above.id)) {
          above.support = null;
          this.repo.save(above);
        }
      Object.assign(
        c,
        { location: to, support: null, trip: trip.id, placedAt: iso(this.planNow()) },
        this.tripSpot(c, to),
      );
      this.repo.save(c);
    }
    if (toKind === 'yard' || toKind === 'site')
      for (const c of whole) if (c.bundle) this.tripMerge(this.repo.get(c.id, 'container'), to);
  },
  // Loose pieces set down at a place join its loose bundle (the first one there); the first to arrive becomes it.
  /** @param {any} c @param {string} place */
  tripMerge(c, place) {
    const pile = this.tripRows(
      'container',
      NOT_RETIRED + " AND json_extract(data,'$.location')=? AND json_extract(data,'$.pile')=1 AND id<>?",
      place,
      c.id,
    )[0];
    if (!pile) {
      if (!c.pile) {
        c.pile = true;
        this.repo.save(c);
      }
      return;
    }
    for (const l of this.repo.lines(c.id)) {
      this.repo.balance(c.id, l.product_id, -l.quantity);
      this.repo.balance(pile.id, l.product_id, l.quantity);
      this.repo.event(this.user.id, 'CONSOLIDATED', {
        container: pile.id,
        product: l.product_id,
        quantity: l.quantity,
        source: c.id,
        destination: pile.id,
        reason: 'Loose pieces put with ' + pile.name,
        key: this.key,
      });
    }
    Object.assign(c, {
      retired: true,
      retiredAt: iso(this.planNow()),
      retiredWhy: 'Put with ' + pile.name,
      pile: false,
      // an emptied bundle is nowhere any more (its last place is kept), so the places it passed through never read it again
      lastLocation: c.location,
      location: null,
    });
    this.repo.save(c);
  },
  // A container for loose pieces split from a stillage (no frame weight), at the place the split happens.
  /** @param {string} place @param {any} trip */
  tripBundle(place, trip) {
    // B-001, B-002, ...: the company's bundle counter (the revisions table), so naming one never reads every container
    bumpRevision(this.db, this.repo.company, 'bundle');
    const n = cached(this.db, "SELECT n FROM revisions WHERE company_id=? AND name='bundle'").get(this.repo.company).n;
    const draft = {
      name: 'B-' + String(n).padStart(3, '0'),
      type: 'BUNDLE',
      model: 'Loose pieces, split from a stillage',
      length: 2000,
      width: 1000,
      height: 500,
      envelopeLength: 2000,
      envelopeWidth: 1000,
      tare: 0,
      capacity: null,
      location: place,
      rotation: 0,
      support: null,
      condition: 'SERVICEABLE',
      mode: 'LIVE',
      bundle: true,
      trip: trip.id,
    };
    return this.repo.add('container', { ...draft, ...this.tripSpot(draft, place) });
  },
  // Where a container is drawn at a place. A real yard's map is a picture: a stillage back at the yard goes back to its old spot (on top of
  // the stack there now, if there is one), anything else to the next spot of a simple grid by the gate. On a truck: the deck.
  /** @param {any} c @param {string} place */
  tripSpot(c, place) {
    let loc = null;
    try {
      loc = this.repo.get(place);
    } catch {}
    if (!loc || loc.kind === 'truck') return { x: 0, y: 0, rotation: 0, support: null };
    const others = this.tripContainersAt(place).filter((/** @type {any} */ o) => o.id !== c.id);
    const clear = (
      /** @type {number} */ x,
      /** @type {number} */ y,
      /** @type {number} */ w,
      /** @type {number} */ h,
    ) =>
      !others.some(
        (/** @type {any} */ o) =>
          x < o.x + (o.envelopeLength ?? o.length) &&
          o.x < x + w &&
          y < o.y + (o.envelopeWidth ?? o.width) &&
          o.y < y + h,
      );
    const w = c.envelopeLength ?? c.length ?? 2000,
      h = c.envelopeWidth ?? c.width ?? 1000;
    if (c.home && c.home.location === place) {
      if (clear(c.home.x, c.home.y, w, h))
        return { x: c.home.x, y: c.home.y, rotation: c.home.rotation ?? 0, support: null };
      const stack = others.filter((/** @type {any} */ o) => o.x === c.home.x && o.y === c.home.y && o.type === c.type);
      const top = stack.find((/** @type {any} */ o) => !others.some((/** @type {any} */ x) => x.support === o.id));
      if (top && stack.length < 7) return { x: c.home.x, y: c.home.y, rotation: top.rotation ?? 0, support: top.id };
    }
    const xs = (loc.points ?? []).map((/** @type {any} */ p) => p.x),
      ys = (loc.points ?? []).map((/** @type {any} */ p) => p.y),
      x0 = xs.length ? Math.ceil(Math.min(...xs)) + 500 : 0,
      y0 = ys.length ? Math.ceil(Math.min(...ys)) + 3000 : 0,
      x1 = xs.length ? Math.floor(Math.max(...xs)) - w - 500 : x0 + 20000;
    const perRow = Math.max(1, Math.floor((x1 - x0) / (w + 200)) + 1);
    for (let i = 0; i < 400; i++) {
      const x = x0 + (i % perRow) * (w + 200),
        y = y0 + Math.floor(i / perRow) * (h + 200);
      if (clear(x, y, w, h)) return { x, y, rotation: 0, support: null };
    }
    return { x: x0, y: y0, rotation: 0, support: null };
  },
  // After a step: the trip's state, its orders' lines and states, and the truck's record of where it is.
  /** @param {any} trip @param {any} tp @param {TripStep} step @param {Map<string,number>} done @param {{at:string}} when @param {number} now */
  tripAfter(trip, tp, step, done, when, now) {
    const field = { LOADED: 'loaded', DELIVERED: 'delivered', COLLECTED: 'collected', RETURNED: 'returned' }[step];
    if (field) this.tripSpread(trip, done, field);
    let truck = null;
    try {
      truck = this.repo.get(tp.truck, 'truck');
    } catch {}
    const onTruck = this.tripOnTruck(trip),
      left = [...onTruck.values()].reduce((s, n) => s + n, 0);
    if (step === 'PACKED') trip.state = 'PACKED';
    if (step === 'LOADED') {
      trip.state = 'LOADED';
      if (truck)
        Object.assign(truck, {
          status: 'IN_TRANSIT',
          at: trip.yard,
          destination: trip.site,
          liveTrip: trip.id,
          leftAt: when.at,
        });
    }
    if (step === 'DELIVERED') {
      trip.state = left > 0 ? 'DELIVERED_SHORT' : 'DELIVERED';
      if (truck)
        Object.assign(truck, { status: 'AT_SITE', at: trip.site, destination: null, liveTrip: trip.id, leftAt: null });
    }
    if (step === 'COLLECTED') {
      trip.state = 'COLLECTED';
      if (truck)
        Object.assign(truck, {
          status: 'IN_TRANSIT',
          at: trip.site,
          destination: trip.yard,
          liveTrip: trip.id,
          leftAt: when.at,
        });
    }
    if (step === 'RETURNED') {
      if (trip.direction === 'OUT' && !trip.steps.DELIVERED) trip.undelivered = true;
      trip.state = 'RETURNED';
      trip.notBack = [...onTruck].map(([product, quantity]) => ({ product, quantity }));
      if (truck)
        Object.assign(truck, { status: 'AT_YARD', at: trip.yard, destination: null, liveTrip: null, leftAt: null });
    }
    if (truck) this.repo.save(truck);
    for (const id of trip.orders) {
      const o = this.repo.get(id, 'order');
      if (o.status === 'CANCELLED') continue;
      if (step === 'LOADED') o.status = 'LOADED';
      if (step === 'DELIVERED')
        o.status = o.lines.every((/** @type {any} */ l) => l.delivered >= l.requested) ? 'DELIVERED' : 'SHORT';
      if (step === 'COLLECTED') o.status = 'COLLECTED';
      if (step === 'RETURNED' && o.direction === 'BACK') o.status = 'RETURNED';
      if (step === 'RETURNED' && trip.undelivered) o.status = 'NOT_DELIVERED'; // "Send again" makes a new order of the same
      this.repo.save(o);
      if (o.planItem) this.tripListSync(o, trip, step, now);
    }
  },
  // Spreads a step's pieces over the trip's orders, oldest first, each up to what it asked for (loaded, collected) or had (delivered from
  // loaded, returned from collected or loaded); anything over goes on the last order with that material (or a new line on the first).
  /** @param {any} trip @param {Map<string,number>} done @param {string} field */
  tripSpread(trip, done, field) {
    const orders = trip.orders.map((/** @type {string} */ id) => this.repo.get(id, 'order'));
    const cap = (/** @type {any} */ l, /** @type {any} */ o) =>
      field === 'loaded' || field === 'collected'
        ? l.requested
        : field === 'delivered'
          ? l.loaded
          : o.direction === 'BACK'
            ? l.collected
            : l.loaded - l.delivered;
    for (const [p, q] of done) {
      let left = q;
      const has = orders.filter((/** @type {any} */ o) => o.lines.some((/** @type {any} */ l) => l.product === p));
      for (const o of has) {
        const l = o.lines.find((/** @type {any} */ x) => x.product === p),
          n = Math.max(0, Math.min(left, cap(l, o) - l[field]));
        l[field] += n;
        left -= n;
      }
      if (left > 0) {
        const o = has.at(-1) ?? orders[0];
        let l = o.lines.find((/** @type {any} */ x) => x.product === p);
        if (!l) {
          l = { product: p, requested: 0, loaded: 0, delivered: 0, collected: 0, returned: 0, pack: null };
          o.lines.push(l);
        }
        l[field] += left;
      }
      for (const o of has.length ? has : [orders[0]]) this.repo.save(o);
    }
  },
  // Today follows the trips: a Materials list is done when its order is delivered (or back); a truck booking when every trip on it is.
  /** @param {any} o @param {any} trip @param {TripStep} step @param {number} now */
  tripListSync(o, trip, step, now) {
    let it = null;
    try {
      it = this.repo.get(o.planItem, 'planItem');
    } catch {}
    if (!it || it.status === 'CANCELLED') return;
    this.planEdit(it.id, (/** @type {any} */ x) => {
      const words = this.tripStepWords(trip, step);
      if (step === 'PACKED') x.stage = 'PACKED';
      if (step === 'LOADED' || step === 'COLLECTED') {
        x.stage = 'ON_THE_WAY';
        x.status = 'ACTIVE';
      }
      if (step === 'RETURNED' && trip.undelivered) {
        x.stage = 'WAITING';
        x.problem = UNDELIVERED_WORDS + '. Tap Send again on its trip, or cancel this list.';
      } else if (step === 'DELIVERED' || (step === 'RETURNED' && o.direction === 'BACK')) {
        Object.assign(x, {
          status: 'DONE',
          stage: 'DONE',
          doneAt: iso(now),
          problem: null,
          unconfirmedAt: null,
          why: null,
        });
        if (o.status === 'SHORT')
          x.short = o.lines
            .filter((/** @type {any} */ l) => l.delivered < l.requested)
            .map((/** @type {any} */ l) => ({ product: l.product, quantity: l.requested - l.delivered }));
        this.planCloseMsgs(x, now);
      }
      this.planLog(x, words + '.', now);
    });
  },
  // The Today truck booking follows its trips: under way from the first confirmation, done when every trip on it is delivered or back.
  // trip: the trip just confirmed (its step goes in the booking's history).
  /** @param {string} itemId @param {number} now @param {any} [trip] */
  tripPlanSync(itemId, now, trip = null) {
    let it = null;
    try {
      it = this.repo.get(itemId, 'planItem');
    } catch {}
    if (!it || it.type !== 'TRUCK' || it.status === 'CANCELLED') return;
    const count = (/** @type {string} */ states) =>
      cached(
        this.db,
        "SELECT COUNT(*) n FROM objects WHERE company_id=? AND kind='trip' AND json_extract(data,'$.truckPlan')=? AND json_extract(data,'$.state') IN (" +
          states +
          ')',
      ).get(this.repo.company, it.id).n;
    const open = count("'BOOKED','PACKED','LOADED','DELIVERED_SHORT','COLLECTED'"),
      finished = count("'DELIVERED','RETURNED'");
    if (!open && !finished) return;
    const last = trip ? tripLast(trip) : null;
    this.planEdit(it.id, (/** @type {any} */ x) => {
      if (last) this.planLog(x, this.tripLabel(trip) + ': ' + this.tripStepWords(trip, last[0]) + '.', now);
      if (!open)
        Object.assign(x, {
          status: 'DONE',
          stage: 'DONE',
          doneAt: iso(now),
          problem: null,
          unconfirmedAt: null,
          why: null,
        });
      else if (last) {
        x.status = 'ACTIVE';
        x.stage = 'ON';
        if (x.unconfirmedAt) Object.assign(x, { unconfirmedAt: null, problem: null, why: null });
      }
    });
  },
  // Trips still waiting for a confirmation, oldest first.
  tripOpenRows() {
    return this.tripRowsBy('objects_trip_state', 'trip', OPEN_STATES);
  },

  // ---------- the business clock: flags only (clock.js clockPass) ----------
  /** @param {number} now */
  clockTrips(now) {
    for (const trip of this.tripOpenRows()) {
      const tp = this.tripPlan(trip);
      if (!tp) continue;
      const over = now >= this.clockAt(tp.day, DAY_END);
      let words = null;
      if ((trip.state === 'BOOKED' || trip.state === 'PACKED') && over)
        words =
          trip.direction === 'OUT'
            ? 'Not confirmed: nobody recorded that it left the yard'
            : 'Not confirmed: nobody recorded the collection';
      else if (trip.state === 'LOADED' || trip.state === 'COLLECTED') {
        const since = Date.parse(trip.steps[trip.state]?.at),
          mins = this.tripMinutes(trip.site);
        if (now > since + mins * 60000 + LATE_MS)
          words =
            'Not confirmed: left ' +
            (trip.state === 'LOADED' ? 'the yard ' : this.planSiteName(trip.site) + ' ') +
            this.tripHm(since) +
            ', usually ~' +
            mins +
            ' min. ' +
            (trip.state === 'LOADED' ? 'Delivered?' : 'Back at yard?');
      } else if (trip.state === 'DELIVERED_SHORT' && over) {
        const n = [...this.tripOnTruck(trip).values()].reduce((s, x) => s + x, 0);
        words = 'Not confirmed: ' + plural(n, 'piece') + ' still on the truck';
      }
      if (!words || trip.flag?.words === words) continue;
      const first = !trip.flag;
      trip.flag = { code: 'UNCONFIRMED_TRIP', words, since: iso(now) };
      this.repo.save(trip);
      if (first)
        this.notify(
          'Not confirmed',
          this.tripLabel(trip) + ' to ' + this.planSiteName(trip.site) + ': ' + words + '.',
          trip.site,
        );
    }
  },

  // ---------- the LIVE board (#22): state from confirmations, never invented motion ----------
  // A site's usual trip minutes: typed on the site, else the median of its last 5 real drives there (left to delivered), once there are 3,
  // else 30. A real drive: at least 5 minutes, both taps made on the driver's own phone, and not both sent within 2 minutes of each other
  // (a driver who taps both on arrival, or an office keying a docket in, teaches nothing about the road).
  /** @param {string} siteId */
  tripMinutes(siteId) {
    let site = null;
    try {
      site = this.repo.get(siteId, 'site');
    } catch {}
    if (site?.plannedMinutes > 0) return site.plannedMinutes;
    const rows = cached(
      this.db,
      "SELECT trip_id,step,occurred_at,recorded_at,actor_kind FROM trip_confirmation WHERE company_id=? AND site_id=? AND step IN ('LOADED','DELIVERED') ORDER BY sequence DESC LIMIT 80",
    ).all(this.repo.company, siteId);
    /** @type {Map<string,any>} */
    const by = new Map();
    for (const r of rows) {
      let x = by.get(r.trip_id);
      if (!x) by.set(r.trip_id, (x = {}));
      x[r.step] = { at: Date.parse(r.occurred_at), rec: Date.parse(r.recorded_at), person: r.actor_kind === 'PERSON' };
    }
    const mins = [...by.values()]
      .filter(
        (x) =>
          x.LOADED &&
          x.DELIVERED &&
          x.LOADED.person &&
          x.DELIVERED.person &&
          x.DELIVERED.at - x.LOADED.at >= MIN_DRIVE_MS &&
          Math.abs(x.DELIVERED.rec - x.LOADED.rec) >= 2 * 60000,
      )
      .slice(0, MEDIAN_OF)
      .map((x) => Math.round((x.DELIVERED.at - x.LOADED.at) / 60000));
    return mins.length >= LEARN_FROM ? (median(mins) ?? DEFAULT_MINUTES) : DEFAULT_MINUTES;
  },
  // Per truck, its last confirmed step (truck.liveTrip: the trip it last moved on) or today's first booked trip; the confirmations of the
  // last 15 minutes (the replay queue); pieces per site from the records. Every truck row is a truck record and every movement a confirmation
  // or a labelled estimate ("usually ~N min", drawn no further than 90% of the way).
  /** @param {{visibleSite?:(id:string)=>boolean}} [opts] */
  liveBoard({ visibleSite = () => true } = {}) {
    const now = this.planNow(),
      today = this.planToday(now);
    /** @type {Map<string,any>} */
    const bookedFor = new Map();
    for (const r of cached(
      this.db,
      "SELECT t.id,t.kind,t.data,t.version FROM objects t JOIN objects p ON p.company_id=t.company_id AND p.id=json_extract(t.data,'$.truckPlan') WHERE t.company_id=? AND t.kind='trip' AND json_extract(t.data,'$.state') IN ('BOOKED','PACKED') AND json_extract(p.data,'$.day')=? AND json_extract(p.data,'$.status')<>'CANCELLED' ORDER BY json_extract(t.data,'$.time'),t.rowid",
    ).all(this.repo.company, today)) {
      const t = this.repo.decode(r);
      if (visibleSite(t.site) && !bookedFor.has(t.truck)) bookedFor.set(t.truck, t);
    }
    const trucks = [];
    for (const truck of this.repo.all('truck')) {
      if (truck.retired) continue;
      let t = null;
      try {
        t = truck.liveTrip ? this.repo.get(truck.liveTrip, 'trip') : null;
      } catch {}
      if (t && !visibleSite(t.site)) t = null;
      /** @type {any} */
      let row = {
        truck: truck.id,
        name: truck.name,
        state: 'PARKED',
        place: truck.yard,
        from: null,
        to: null,
        since: null,
        trip: null,
        words: null,
        estimate: null,
        late: false,
      };
      if (t?.state === 'LOADED' || t?.state === 'COLLECTED') {
        const out = t.state === 'LOADED',
          mins = this.tripMinutes(t.site),
          since = Date.parse(t.steps[t.state].at);
        row = {
          ...row,
          state: out ? 'TO_SITE' : 'TO_YARD',
          place: null,
          from: out ? t.yard : t.site,
          to: out ? t.site : t.yard,
          since: t.steps[t.state].at,
          trip: t.id,
          words:
            'Left ' +
            (out ? '' : this.planSiteName(t.site) + ' ') +
            this.tripHm(since) +
            ' · usually ~' +
            mins +
            ' min',
          estimate: { startedAt: t.steps[t.state].at, minutes: mins, cap: 0.9 },
          late: now > since + mins * 60000 + LATE_MS,
        };
      } else if (
        t &&
        t.steps?.DELIVERED &&
        !t.steps.RETURNED &&
        // a delivery of an earlier day gives way to today's booking (Back at yard is optional after a full delivery)
        !(bookedFor.has(truck.id) && this.clockDay(Date.parse(t.steps.DELIVERED.at)) !== today)
      ) {
        row = {
          ...row,
          state: 'AT_SITE',
          place: t.site,
          since: t.steps.DELIVERED.at,
          trip: t.id,
          words: this.tripStepWords(t, 'DELIVERED', now),
        };
      } else if (bookedFor.has(truck.id)) {
        const b = bookedFor.get(truck.id);
        t = b;
        row = { ...row, state: 'BOOKED', trip: b.id, to: b.site, words: b.time + ' → ' + this.planSiteName(b.site) };
      } else t = null;
      if (t) {
        const last = tripLast(t);
        row.tripLabel = this.tripLabel(t);
        row.flag = t.flag ?? null;
        row.lastEvent = last
          ? {
              id: last[1].id,
              step: last[0],
              at: last[1].at,
              byName: last[1].byName,
              receivedBy: last[1].receivedBy ?? null,
            }
          : null;
      } else if (!visibleSite(truck.at) && truck.at !== truck.yard) continue;
      trucks.push(row);
    }
    // the replay queue: confirmations recorded in the last 15 minutes, by id (the page plays each one once)
    const replays = [];
    for (const r of cached(
      this.db,
      "SELECT id,trip_id,step,occurred_at,recorded_at,received_by FROM trip_confirmation WHERE company_id=? AND recorded_at>=? AND step<>'PACKED' ORDER BY sequence",
    ).all(this.repo.company, iso(now - REPLAY_MS))) {
      let t = null;
      try {
        t = this.repo.get(r.trip_id, 'trip');
      } catch {}
      if (!t || !visibleSite(t.site)) continue;
      const hm = this.tripHm(Date.parse(r.occurred_at));
      replays.push({
        id: r.id,
        step: r.step,
        trip: r.trip_id,
        truck: t.truck ?? this.tripPlan(t)?.truck ?? null,
        site: t.site,
        at: r.occurred_at,
        recordedAt: r.recorded_at,
        words:
          r.step === 'DELIVERED'
            ? 'Delivered ' + hm + ' · received by ' + r.received_by
            : STEP_WORDS[/** @type {TripStep} */ (r.step)] + ' ' + hm,
      });
    }
    // what each site holds, from the records (confirmed deliveries and collections)
    /** @type {Record<string,any>} */
    const sites = {};
    const active = new Set(
      this.repo
        .all('site')
        .filter((/** @type {any} */ s) => s.status === 'ACTIVE' && visibleSite(s.id))
        .map((/** @type {any} */ s) => s.id),
    );
    for (const id of active) sites[id] = { pieces: 0, lines: [] };
    for (const r of cached(
      this.db,
      "SELECT json_extract(o.data,'$.location') loc,ct.product_id product,SUM(ct.quantity) q FROM contents ct JOIN objects o ON o.company_id=ct.company_id AND o.id=ct.container_id WHERE ct.company_id=? AND ct.quantity>0 AND coalesce(json_extract(o.data,'$.retired'),0)=0 GROUP BY loc,ct.product_id",
    ).all(this.repo.company)) {
      if (!active.has(r.loc)) continue;
      sites[r.loc].pieces += r.q;
      sites[r.loc].lines.push({ product: r.product, name: this.planName(r.product, 'Material'), quantity: r.q });
    }
    // today, hm and dayOver: the company's own day and clock (the board's Book form never reads the browser's clock, which may be in another zone)
    return {
      now: iso(now),
      today,
      hm: this.tripHm(now),
      dayOver: now >= this.planAt(today, DAY_END),
      trucks,
      replays,
      sites,
    };
  },
  // ---------- a driver's phone ----------
  // My trips: today's and tomorrow's (the run sheet), and earlier ones still waiting for a confirmation. Only the signed-in driver's own.
  crewTrips() {
    requireLive(this);
    const driver = this.user.crew?.driver ?? this.crewDriverOf(this.user.id);
    if (!driver) throw new AppError(404, 'Record not found in your company.');
    const today = this.planToday(),
      d = this.teamPerson(driver);
    const trips = cached(
      this.db,
      "SELECT t.id,t.kind,t.data,t.version FROM objects t JOIN objects p ON p.company_id=t.company_id AND p.id=json_extract(t.data,'$.truckPlan') WHERE t.company_id=? AND t.kind='trip' AND json_extract(p.data,'$.driver')=? AND json_extract(p.data,'$.status')<>'CANCELLED' AND json_extract(t.data,'$.state')<>'CANCELLED' AND (json_extract(p.data,'$.day') IN (?,?) OR (json_extract(p.data,'$.day')<? AND json_extract(t.data,'$.state') IN ('BOOKED','PACKED','LOADED','DELIVERED_SHORT','COLLECTED'))) ORDER BY t.rowid",
    )
      .all(this.repo.company, driver, today, addDays(today, 1), today)
      .map((/** @type {any} */ r) => this.tripView(this.repo.decode(r), { crew: true }));
    trips.sort(
      (a, b) =>
        String(a.day).localeCompare(String(b.day)) ||
        String(a.time).localeCompare(String(b.time)) ||
        a.number - b.number,
    );
    return {
      driver: { id: driver, name: d?.name ?? this.user.name },
      company: this.planCompany(),
      today,
      trips,
    };
  },
};
