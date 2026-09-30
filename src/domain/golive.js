// @ts-check
// Bringing an existing yard in (ADR 0011, the core of audit #9). A real yard only; mixed into Simulation.prototype.
//   openingLot     pieces already on hire at a site from a day in the past: provenance IMPORT, occurred_at on that day, so hire runs
//                  from onHireSince at the rates in force then, never from the import day
//   goLiveCheck    (pure) a pasted spreadsheet checked row by row: customers, sites, yard stock, on-hire lots with dates, rates; every
//                  problem in plain words; the batch is refused when any row is wrong (the catalogue import's refuse-and-explain style)
//   goLiveImport   applies a checked list, all or nothing; goLivePreview shows the check without writing
import { requireRule, integer } from './geometry.js';
import { cached } from '../database.js';
import { AppError } from '../service.js';
import { requireLive } from './mode.js';
import { addDays, dayLabel } from './schedule.js';
import { dayYear } from './billing.js';
import { nameKey } from './billing.js';
import { bdAbnValid } from './brand.js';
export const GOLIVE_KINDS = ['customers', 'sites', 'stock', 'onHire', 'rates'];
export const GOLIVE_MAX_ROWS = 500;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** @type {(ms:number)=>string} */
const iso = (ms) => new Date(ms).toISOString();
/** @type {(n:number,one:string,many?:string)=>string} */
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
// The columns each list may carry, with the header names accepted for each (case, spaces and punctuation ignored).
export const GOLIVE_COLUMNS = {
  customers: {
    name: ['name', 'customer', 'customer name', 'company', 'client'],
    abn: ['abn'],
    email: ['email', 'billing email', 'accounts email'],
    address: ['address', 'billing address', 'postal address'],
    terms: ['terms', 'terms days', 'payment terms', 'days'],
    po: ['po', 'default po', 'purchase order', 'po number'],
  },
  sites: {
    name: ['site', 'name', 'site name', 'job', 'project'],
    customer: ['customer', 'client', 'builder', 'company'],
    address: ['address', 'site address'],
    po: ['po', 'purchase order', 'po number'],
    contact: ['contact', 'site contact', 'contact name'],
    phone: ['phone', 'mobile', 'contact phone'],
    email: ['email', 'contact email'],
  },
  stock: {
    product: ['product', 'part', 'material', 'name', 'item', 'description'],
    reference: ['reference', 'ref', 'code', 'part number', 'sku'],
    quantity: ['quantity', 'qty', 'pieces', 'count', 'in yard', 'yard'],
    weight: ['weight', 'unit weight', 'weight g', 'weight (g)', 'grams', 'kg', 'weight kg', 'weight (kg)'],
    system: ['system', 'scaffold system', 'brand'],
    category: ['category', 'type', 'group'],
  },
  onHire: {
    site: ['site', 'site name', 'job', 'project'],
    product: ['product', 'part', 'material', 'name', 'item', 'description'],
    reference: ['reference', 'ref', 'code', 'part number', 'sku'],
    quantity: ['quantity', 'qty', 'pieces', 'on hire', 'count'],
    since: ['since', 'on hire since', 'from', 'date', 'delivered', 'start'],
    customer: ['customer', 'client', 'builder'],
    weight: ['weight', 'unit weight', 'weight g', 'weight (g)', 'grams', 'kg', 'weight kg', 'weight (kg)'],
    system: ['system', 'scaffold system', 'brand'],
    category: ['category', 'type', 'group'],
  },
  rates: {
    product: ['product', 'part', 'material', 'name', 'item', 'description'],
    reference: ['reference', 'ref', 'code', 'part number', 'sku'],
    week: ['week', 'week rate', 'per week', 'weekly', '$/week', 'week $'],
    day: ['day', 'day rate', 'per day', 'daily', '$/day', 'day $'],
    minDays: ['minimum', 'min days', 'minimum hire', 'minimum days', 'min hire'],
    from: ['from', 'applies from', 'date', 'start'],
  },
};
/** @type {(s:string)=>string} */
const headKey = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9$()]+/g, ' ')
    .trim();
// A row's value for one of our fields, whichever accepted header the sheet used ('' when none).
/** @param {Record<string,unknown>} row @param {string[]} names */
export function pickField(row, names) {
  const want = new Set(names.map(headKey));
  for (const [k, v] of Object.entries(row)) if (want.has(headKey(k))) return String(v ?? '').trim();
  return '';
}
/** Which of our fields the sheet's headers map to (for the preview's header line). @param {keyof typeof GOLIVE_COLUMNS} kind @param {string[]} headers */
export function goLiveHeaders(kind, headers) {
  const cols = GOLIVE_COLUMNS[kind];
  return headers.map((h) => {
    const k = headKey(h);
    const field =
      Object.keys(cols).find((f) => cols[/** @type {keyof typeof cols} */ (f)].map(headKey).includes(k)) ?? null;
    return { header: h, field };
  });
}
// 'YYYY-MM-DD' or 'D/M/YYYY' (Australian). Anything else is refused in words, never guessed.
/** @param {string} v @returns {{day?:string,problem?:string}} */
export function goLiveDay(v) {
  const s = v.trim();
  if (!s) return { problem: 'a date is needed' };
  if (DAY.test(s) && addDays(s, 0) === s) return { day: s };
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) {
    const d = m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
    if (DAY.test(d) && addDays(d, 0) === d) return { day: d };
  }
  return { problem: "date '" + s + "' not understood: use DD/MM/YYYY (for example 03/03/2026)" };
}
// '$1,234.50', '1234.5', '12' -> cents. Blank: null (no rate).
/** @param {string} v @returns {{cents?:number|null,problem?:string}} */
export function goLiveMoney(v) {
  const s = v.replace(/[$,\s]/g, '');
  if (!s) return { cents: null };
  if (!/^\d+(\.\d{1,2})?$/.test(s))
    return { problem: "amount '" + v.trim() + "' not understood: dollars and cents, like 12.50" };
  return { cents: Math.round(Number(s) * 100) };
}
// Whole pieces.
/** @param {string} v @returns {{n?:number,problem?:string}} */
export function goLiveCount(v, { zero = false } = {}) {
  const s = v.replace(/[,\s]/g, '');
  if (!s) return { problem: 'a quantity is needed' };
  if (!/^\d+$/.test(s)) return { problem: "quantity '" + v.trim() + "' is not a whole number" };
  const n = Number(s);
  if (!zero && n < 1) return { problem: 'the quantity must be at least 1' };
  if (n > 1000000) return { problem: 'the quantity is too large' };
  return { n };
}
// Grams; '12.5 kg' or a kg column becomes grams. Blank: null (weight is optional in a real yard).
/** @param {string} v @param {boolean} kgColumn @returns {{grams?:number|null,problem?:string}} */
export function goLiveWeight(v, kgColumn = false) {
  const s = v.trim().toLowerCase();
  if (!s) return { grams: null };
  const m = /^([\d.,]+)\s*(kg|g)?$/.exec(s);
  if (!m) return { problem: "weight '" + v.trim() + "' not understood: grams, or kilograms with kg" };
  const num = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(num) || num <= 0) return { problem: "weight '" + v.trim() + "' must be above zero" };
  const grams = Math.round(m[2] === 'kg' || (!m[2] && kgColumn) ? num * 1000 : num);
  return { grams };
}
/** What a row refers to, looked up in the yard's records (built once per check): sites of every status, the opening lots already
 * brought in (site|product|day -> pieces) and the stock already brought in per product, so the same sheet pasted twice is skipped
 * unless `again` is asked for (ADR 0011 review).
 * @typedef {{customers:Map<string,any>,customerNames?:Map<string,string>,sites:Map<string,any>,productsByRef:Map<string,any[]>,productsByName:Map<string,any[]>,today:string,lots?:Map<string,number>,importedStock?:Map<string,number>}} GoLiveCtx */
// The check, pure: one entry per row with its problems and the plan (what applying it would do).
/** @param {keyof typeof GOLIVE_COLUMNS} kind @param {Record<string,unknown>[]} rows @param {GoLiveCtx} ctx @param {{again?:boolean}} [o] */
export function goLiveCheck(kind, rows, ctx, { again = false } = {}) {
  requireRule(GOLIVE_KINDS.includes(kind), 'Choose a list: customers, sites, stock, onHire or rates.');
  requireRule(Array.isArray(rows) && rows.length > 0, 'Paste at least one row.');
  requireRule(rows.length <= GOLIVE_MAX_ROWS, 'Up to ' + GOLIVE_MAX_ROWS + ' rows per list: split the sheet.');
  const cols = GOLIVE_COLUMNS[kind],
    get = (/** @type {Record<string,unknown>} */ row, /** @type {string} */ f) =>
      pickField(row, cols[/** @type {keyof typeof cols} */ (f)]);
  const seen = new Map(),
    newNames = new Map(); // names this same list makes (a second row for the same name is a duplicate)
  const product = (/** @type {Record<string,unknown>} */ row, /** @type {string[]} */ problems) => {
    const ref = get(row, 'reference'),
      name = get(row, 'product');
    if (!ref && !name) {
      problems.push('a part name (or reference) is needed');
      return null;
    }
    const byRef = ref ? (ctx.productsByRef.get(nameKey(ref)) ?? []) : [];
    if (byRef.length === 1) return byRef[0];
    if (byRef.length > 1) {
      problems.push("reference '" + ref + "' matches " + byRef.length + ' parts: give the part name too');
      return null;
    }
    const byName = name ? (ctx.productsByName.get(nameKey(name)) ?? []) : [];
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      problems.push("two parts are called '" + name + "': give the reference");
      return null;
    }
    return null; // unknown
  };
  const out = rows.map((row, i) => {
    /** @type {string[]} */
    const problems = [];
    /** @type {any} */
    let plan = null;
    requireRule(row && typeof row === 'object' && !Array.isArray(row), 'Row ' + (i + 1) + ' is not a row.');
    if (kind === 'customers') {
      const name = get(row, 'name'),
        abn = get(row, 'abn').replace(/[\s.-]+/g, ''),
        email = get(row, 'email').toLowerCase(),
        terms = get(row, 'terms');
      if (!name) problems.push('a customer name is needed');
      if (abn && !/^\d{11}$/.test(abn)) problems.push("ABN '" + get(row, 'abn') + "' does not have 11 digits");
      else if (abn && !bdAbnValid(abn)) problems.push("ABN '" + get(row, 'abn') + "' fails its check digits");
      if (email && !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email))
        problems.push("email '" + email + "' is not an email address");
      let termsDays = null;
      if (terms) {
        const t = goLiveCount(terms.replace(/days?/i, ''), { zero: true });
        if (t.problem) problems.push('terms: ' + t.problem);
        else if ((t.n ?? 0) > 120) problems.push('terms of more than 120 days');
        else termsDays = t.n ?? null;
      }
      const key = nameKey(name);
      if (name && seen.has(key)) problems.push("'" + name + "' is on row " + seen.get(key) + ' already');
      if (name) seen.set(key, i + 1);
      const existing = ctx.customers.get(key);
      plan = existing
        ? { action: 'skip', words: name + ' is already a customer: left as it is' }
        : {
            action: 'create',
            name,
            abn,
            billingEmail: email || null,
            address: get(row, 'address') || null,
            termsDays,
            defaultPO: get(row, 'po') || null,
          };
    } else if (kind === 'sites') {
      const name = get(row, 'name'),
        customer = get(row, 'customer'),
        key = nameKey(name);
      if (!name) problems.push('a site name is needed');
      if (name && seen.has(key)) problems.push("'" + name + "' is on row " + seen.get(key) + ' already');
      if (name) seen.set(key, i + 1);
      const c = customer ? ctx.customers.get(nameKey(customer)) : null;
      if (customer && !c) problems.push("no customer called '" + customer + "': import the customers first");
      const existing = ctx.sites.get(key);
      const email = get(row, 'email').toLowerCase();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        problems.push("email '" + email + "' is not an email address");
      plan = existing
        ? {
            action: 'skip',
            words:
              !existing.status || existing.status === 'ACTIVE'
                ? name + ' is already a site: left as it is'
                : name + ' is a removed site: open it again from Client sites (Removed / finished sites)',
          }
        : {
            action: 'create',
            name,
            customer: c?.id ?? null,
            customerName: c?.name ?? null,
            address: get(row, 'address') || null,
            po: get(row, 'po') || null,
            contact: get(row, 'contact') || null,
            phone: get(row, 'phone') || null,
            email: email || null,
          };
    } else if (kind === 'stock' || kind === 'onHire') {
      const p = product(row, problems),
        q = goLiveCount(get(row, 'quantity'));
      if (q.problem) problems.push(q.problem);
      const kgCol = Object.keys(row).some(
          (k) => /\bkg\b/.test(headKey(k)) && get(row, 'weight') === String(row[k] ?? '').trim(),
        ),
        w = goLiveWeight(get(row, 'weight'), kgCol);
      if (w.problem) problems.push(w.problem);
      const name = get(row, 'product'),
        ref = get(row, 'reference');
      let make = null;
      if (!p && (name || ref)) {
        const nk = nameKey(name || ref);
        if (newNames.has(nk)) make = { sameAsRow: newNames.get(nk) };
        else {
          newNames.set(nk, i + 1);
          make = {
            name: name || ref,
            reference: ref || name,
            system: get(row, 'system') || 'Imported',
            category: get(row, 'category') || 'Scaffold components',
            unitWeight: w.grams ?? null,
          };
        }
      }
      if (kind === 'stock') {
        const had = p ? (ctx.importedStock?.get(p.id) ?? 0) : 0;
        plan =
          had && !again
            ? {
                action: 'skip',
                words:
                  p.name +
                  ': ' +
                  had +
                  ' already brought in from a stock list. Tick "add these again" if this is a second lot.',
              }
            : {
                action: 'stock',
                product: p?.id ?? null,
                productName: p?.name ?? name ?? ref,
                make,
                quantity: q.n ?? null,
                words: (p ? p.name : (name || ref) + ' (new part)') + ': ' + (q.n ?? '?') + ' in the yard',
              };
      } else {
        const siteName = get(row, 'site'),
          site = siteName ? ctx.sites.get(nameKey(siteName)) : null,
          d = goLiveDay(get(row, 'since')),
          customer = get(row, 'customer'),
          c = customer ? ctx.customers.get(nameKey(customer)) : null;
        if (!siteName) problems.push('a site is needed');
        else if (!site) problems.push("no site called '" + siteName + "': import the sites first");
        else if (site.status && site.status !== 'ACTIVE')
          problems.push(siteName + ' is a removed site: open it again from Client sites first');
        if (d.problem) problems.push('on hire since: ' + d.problem);
        else if (d.day && d.day > ctx.today) problems.push('on hire since ' + d.day + ' is ahead of today');
        else if (d.day && d.day < addDays(ctx.today, -3660))
          problems.push('on hire since ' + d.day + ' is more than ten years back');
        if (customer && !c) problems.push("no customer called '" + customer + "': import the customers first");
        if (site && c && site.customer && site.customer !== c.id)
          problems.push(
            siteName +
              ' belongs to ' +
              (ctx.customerNames?.get(site.customer) ?? 'another customer') +
              ', not ' +
              c.name,
          );
        const had = site && p && d.day ? (ctx.lots?.get(site.id + '|' + p.id + '|' + d.day) ?? 0) : 0;
        plan =
          had && !again
            ? {
                action: 'skip',
                words:
                  p.name +
                  ' at ' +
                  site.name +
                  ': ' +
                  had +
                  ' already on record since ' +
                  dayYear(/** @type {string} */ (d.day)) +
                  '. Tick "add these again" if this is a second lot.',
              }
            : {
                action: 'onHire',
                site: site?.id ?? null,
                siteName: site?.name ?? siteName,
                product: p?.id ?? null,
                productName: p?.name ?? name ?? ref,
                make,
                quantity: q.n ?? null,
                since: d.day ?? null,
                customer: c?.id ?? null,
                words:
                  (p ? p.name : (name || ref) + ' (new part)') +
                  ': ' +
                  (q.n ?? '?') +
                  ' at ' +
                  (site?.name ?? siteName) +
                  ' since ' +
                  (d.day ? dayYear(d.day) : '?'),
              };
      }
    } else if (kind === 'rates') {
      const p = product(row, problems),
        week = goLiveMoney(get(row, 'week')),
        day = goLiveMoney(get(row, 'day')),
        min = get(row, 'minDays'),
        fromText = get(row, 'from');
      if (!p && !problems.length)
        problems.push(
          "no part called '" + (get(row, 'product') || get(row, 'reference')) + "': import the stock first",
        );
      if (week.problem) problems.push('week rate: ' + week.problem);
      if (day.problem) problems.push('day rate: ' + day.problem);
      if (week.cents == null && day.cents == null && !problems.length)
        problems.push('a week rate or a day rate is needed');
      let minDays = null;
      if (min) {
        const m = goLiveCount(min.replace(/days?/i, ''));
        if (m.problem) problems.push('minimum hire: ' + m.problem);
        else if ((m.n ?? 0) > 365) problems.push('minimum hire of more than 365 days');
        else minDays = m.n ?? null;
      }
      let from = null;
      if (fromText) {
        const d = goLiveDay(fromText);
        if (d.problem) problems.push('applies from: ' + d.problem);
        else from = d.day ?? null;
      }
      if (p && seen.has(p.id)) problems.push(p.name + ' is on row ' + seen.get(p.id) + ' already');
      if (p) seen.set(p.id, i + 1);
      plan = {
        action: 'rate',
        product: p?.id ?? null,
        productName: p?.name ?? get(row, 'product'),
        week: week.cents ?? null,
        day: day.cents ?? null,
        minDays,
        from,
        words:
          (p?.name ?? '?') +
          ': ' +
          [
            week.cents != null ? '$' + (week.cents / 100).toFixed(2) + '/week' : '',
            day.cents != null ? '$' + (day.cents / 100).toFixed(2) + '/day' : '',
          ]
            .filter(Boolean)
            .join(' + ') +
          (minDays ? ', minimum ' + plural(minDays, 'day') : '') +
          (from ? ', from ' + dayYear(from) : ', for every day'),
      };
    }
    return { row: i + 1, ok: !problems.length, problems, plan };
  });
  const bad = out.filter((r) => !r.ok).length;
  return {
    kind,
    rows: out,
    ok: !bad,
    total: out.length,
    bad,
    words: bad
      ? plural(bad, 'row') + ' of ' + out.length + ' need fixing before anything is brought in. Nothing was changed.'
      : plural(out.length, 'row') + ' checked: ready to bring in.',
  };
}

/** @type {Record<string,any> & ThisType<any>} */
export const goLiveMethods = {
  // Pieces already on hire at a site from a day in the past (IMPORT, occurred_at on that day at midday company time).
  openingLot(/** @type {any} */ input) {
    requireLive(this);
    const site = this.repo.get(input?.site, 'site'),
      today = this.planNowCal().today;
    requireRule(site.status === 'ACTIVE', site.name + ' is not an open site.');
    requireRule(!site.finishing, site.name + ' is being removed.');
    const p = this.effective(input?.product);
    requireRule(p && !p.retired, 'Choose a part from the catalogue.');
    const quantity = integer(input?.quantity, 'Pieces', 1, 1000000);
    const since = typeof input?.onHireSince === 'string' ? input.onHireSince : '';
    requireRule(DAY.test(since) && addDays(since, 0) === since, 'On hire since must be a date (YYYY-MM-DD).');
    requireRule(since <= today, 'On hire since cannot be ahead of today.');
    requireRule(since >= addDays(today, -3660), 'On hire since is more than ten years back. Check the date.');
    // a lot dated before the site's last statement: the days before billedUpTo would never reach a statement (ADR 0011 review), so
    // the lot is refused unless the office says it knows (beforeBilled: true) and adds an adjustment for that hire
    if (site.billedUpTo && since <= site.billedUpTo)
      requireRule(
        input?.beforeBilled === true,
        site.name +
          ' is billed up to ' +
          dayLabel(site.billedUpTo) +
          ' on ' +
          site.lastStatement +
          ': a lot on hire since ' +
          dayLabel(since) +
          ' would never be billed for the days up to then. Tick "hire before ' +
          dayLabel(site.billedUpTo) +
          ' goes on an adjustment" to add it anyway.',
      );
    if (input?.customer) {
      const c = this.customerGet(input.customer);
      if (!site.customer) this.repo.save({ ...this.repo.get(site.id, 'site'), customer: c.id, customerFrom: 'import' });
      else
        requireRule(
          site.customer === c.id,
          site.name + ' belongs to ' + this.customerName(site.customer) + ', not ' + c.name + '.',
        );
    }
    const reference =
      typeof input?.reference === 'string' && input.reference.trim() ? input.reference.trim().slice(0, 120) : null;
    // one bundle per site holds its opening lots (a real yard's map is a picture: the bundle sits by the gate)
    let c = this.tripRows(
      'container',
      "coalesce(json_extract(data,'$.retired'),0)=0 AND json_extract(data,'$.location')=? AND json_extract(data,'$.opening')=1",
      site.id,
    )[0];
    if (!c) {
      c = this.tripBundle(site.id, { id: null });
      c.opening = true;
      c.name = 'Opening lots';
      c.model = 'Pieces already on hire when the yard went live';
      this.repo.save(c);
    }
    this.repo.balance(c.id, p.id, quantity);
    const was = this.repo.provenance,
      at = iso(this.clockAt(since, '12:00'));
    this.repo.provenance = {
      ...(was ?? { kind: 'IMPORT', onBehalfOf: null, origin: 'command:openingLot' }),
      kind: 'IMPORT',
      occurredAt: at,
    };
    try {
      this.repo.event(this.user.id, 'OPENING_BALANCE', {
        container: c.id,
        product: p.id,
        quantity,
        destination: site.id,
        reason:
          'On hire at ' +
          site.name +
          ' since ' +
          since +
          ' (brought in at go-live)' +
          (reference ? ' · ' + reference : ''),
        key: this.key,
      });
    } finally {
      this.repo.provenance = was;
    }
    return {
      lot: {
        site: site.id,
        siteName: site.name,
        product: p.id,
        name: p.name,
        quantity,
        onHireSince: since,
        container: c.id,
        occurredAt: at,
      },
      message:
        quantity +
        ' × ' +
        p.name +
        ' on hire at ' +
        site.name +
        ' since ' +
        dayYear(since) +
        '.' +
        (site.billedUpTo && since <= site.billedUpTo
          ? ' Its hire up to ' + dayLabel(site.billedUpTo) + ' needs an adjustment on the Hire page.'
          : ''),
    };
  },
  goLiveCtx() {
    const customers = new Map(),
      customerNames = new Map();
    for (const c of this.customerRows())
      if (c.status !== 'REMOVED') {
        customers.set(nameKey(c.name), c);
        customerNames.set(c.id, c.name);
      }
    const sites = new Map();
    // every site, the removed ones too: a sheet naming one is told so instead of a second site of that name being made
    for (const s of this.repo.all('site'))
      if (s.status === 'ACTIVE' || !sites.has(nameKey(s.name))) sites.set(nameKey(s.name), s);
    const siteIds = new Set([...sites.values()].map((s) => s.id));
    // what earlier imports brought in, so the same sheet twice is skipped
    const lots = new Map(),
      importedStock = new Map();
    for (const r of cached(
      this.db,
      "SELECT product_id, destination, quantity, occurred_at, event FROM ledger WHERE company_id=? AND actor_kind='IMPORT' AND origin IN ('command:openingLot','command:goLiveImport') AND quantity>0",
    ).all(this.repo.company)) {
      if (r.event === 'OPENING_BALANCE' && r.destination && siteIds.has(r.destination)) {
        const k = r.destination + '|' + r.product_id + '|' + this.planDayOfIso(r.occurred_at);
        lots.set(k, (lots.get(k) ?? 0) + r.quantity);
      } else importedStock.set(r.product_id, (importedStock.get(r.product_id) ?? 0) + r.quantity);
    }
    const productsByRef = new Map(),
      productsByName = new Map();
    for (const p of this.effectiveProducts()) {
      if (p.retired) continue;
      for (const [m, k] of [
        [productsByRef, nameKey(p.reference)],
        [productsByName, nameKey(p.name)],
      ])
        if (k) m.set(k, [...(m.get(k) ?? []), p]);
    }
    return {
      customers,
      customerNames,
      sites,
      productsByRef,
      productsByName,
      today: this.planNowCal().today,
      lots,
      importedStock,
    };
  },
  // POST /api/golive-preview {kind, rows}: the check, nothing written.
  goLivePreview(/** @type {any} */ input = {}) {
    requireLive(this);
    this.auth.require(this.user, 'company.manage');
    return goLiveCheck(input.kind, input.rows, this.goLiveCtx(), { again: input.again === true });
  },
  // The command: checked, then applied all or nothing. A wrong row refuses the batch with every row's problems (409, detail.check).
  goLiveImport(/** @type {any} */ input = {}) {
    requireLive(this);
    const check = goLiveCheck(input.kind, input.rows, this.goLiveCtx(), { again: input.again === true });
    if (!check.ok) {
      const e = new AppError(409, check.words);
      e.code = 'CHECK_FAILED';
      e.detail = { check };
      throw e;
    }
    const made = [],
      skipped = [];
    const makeProduct = (/** @type {any} */ m) => {
      const p = this.product({
        name: m.name,
        reference: m.reference,
        manufacturer: 'Imported at go-live',
        region: 'AU',
        system: m.system,
        category: m.category,
        unitWeight: m.unitWeight,
        verification: 'COMPANY CONFIGURED',
        document: 'Go-live import',
        limitations: 'Brought in from the company’s own list at go-live.',
      });
      made.push({ kind: 'product', id: p.id, name: p.name });
      return p;
    };
    /** @type {Map<number,any>} */
    const byRow = new Map();
    for (const r of check.rows) {
      const plan = r.plan;
      if (plan.action === 'skip') {
        skipped.push({ row: r.row, words: plan.words });
        continue;
      }
      if (plan.action === 'create' && check.kind === 'customers') {
        const c = this.customerSave({
          name: plan.name,
          abn: plan.abn,
          billingEmail: plan.billingEmail,
          address: plan.address,
          termsDays: plan.termsDays,
          defaultPO: plan.defaultPO,
        }).customer;
        made.push({ kind: 'customer', id: c.id, name: c.name });
      } else if (plan.action === 'create' && check.kind === 'sites') {
        const s = this.site({
          name: plan.name,
          address: plan.address ?? undefined,
          client: plan.customerName,
          contact: plan.contact,
          phone: plan.phone,
          email: plan.email,
          customer: plan.customer,
          po: plan.po,
        });
        if (plan.customer) this.repo.save({ ...this.repo.get(s.id, 'site'), customerFrom: 'import' });
        made.push({ kind: 'site', id: s.id, name: s.name });
      } else if (plan.action === 'stock' || plan.action === 'onHire') {
        let productId = plan.product;
        if (!productId) {
          const m = plan.make;
          productId = m.sameAsRow ? byRow.get(m.sameAsRow) : makeProduct(m).id;
          byRow.set(r.row, productId);
        }
        if (plan.action === 'stock') {
          this.gameAddStock({ lines: [{ product: productId, quantity: plan.quantity }] });
          made.push({ kind: 'stock', product: productId, quantity: plan.quantity });
        } else {
          const lot = this.openingLot({
            product: productId,
            quantity: plan.quantity,
            site: plan.site,
            onHireSince: plan.since,
            customer: plan.customer,
          }).lot;
          made.push({ kind: 'lot', ...lot });
        }
      } else if (plan.action === 'rate') {
        this.hireRate({
          product: plan.product,
          week: plan.week,
          day: plan.day,
          minDays: plan.minDays,
          from: plan.from,
        });
        made.push({ kind: 'rate', product: plan.product, name: plan.productName });
      }
    }
    this.auth.audit(this.user, 'golive.import', { kind: check.kind, rows: check.total, made: made.length });
    return {
      kind: check.kind,
      made,
      skipped,
      check,
      message:
        plural(made.length, 'record') +
        ' brought in from the ' +
        check.kind +
        ' list' +
        (skipped.length ? ' (' + plural(skipped.length, 'row') + ' already there)' : '') +
        '.',
    };
  },
};
