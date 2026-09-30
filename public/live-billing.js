// A real yard's billing on screen (ADR 0011, Phase 1A part 4): customers (Client sites), a site's customer, PO, off-hire notice and opening
// lots (the site card), and on the Hire page the statement per customer (preview → Issue → locked, reprint, reverse, adjust), the monthly
// accounting file for Xero or MYOB, the hire-stop rule and the other hire settings (owner), the go-live import from a pasted sheet and the
// parallel-run report. Loaded only in a real yard (operations.js imports it beside live-office.js, ADR 0007). The HTML functions are pure
// (the tests render them in Node from the server's own views); lbSetup wires one set of listeners on the document. Nothing here changes a
// record by itself: every button sends one command the office chose. Money is shown, never guessed: a code the owner has not set says so.
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Whole cents to dollars: $1,234.56 (a dash for nothing). @param {number|null|undefined} c */
export const lbMoney = (c) => {
  if (c == null) return '–';
  const v = Math.abs(Math.round(c)),
    whole = Math.floor(v / 100).toLocaleString('en-AU');
  return (c < 0 ? '-' : '') + '$' + whole + '.' + String(v % 100).padStart(2, '0');
};
/** Dollars typed to cents (12.50, $1,200, -40): null for nothing, NaN for nonsense. @param {string} v */
export const lbCents = (v) => {
  const t = String(v ?? '')
    .trim()
    .replace(/^\$/, '')
    .replace(/[\s,]/g, '')
    .replace(/^-\$/, '-');
  if (!t) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return NaN;
  const neg = t.startsWith('-'),
    [a, b = ''] = t.replace('-', '').split('.');
  return (neg ? -1 : 1) * (Number(a) * 100 + Number(b.padEnd(2, '0')));
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'Sun 18 Oct' for a company day, the same words as the server's (no browser clock, no locale: 'Sep', never 'Sept'). @param {string} d */
export const lbDay = (d) => {
  if (!DAY.test(String(d ?? ''))) return '';
  const t = new Date(d + 'T12:00:00Z');
  return DAYS[t.getUTCDay()] + ' ' + t.getUTCDate() + ' ' + MONTHS[t.getUTCMonth()];
};
const lbDayYear = (d) => (lbDay(d) ? lbDay(d) + ' ' + d.slice(0, 4) : '');
const MONTH_WORDS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
/** 'October 2026' for 'YYYY-MM'. @param {string} m */
const lbMonth = (m) =>
  /^\d{4}-\d{2}$/.test(String(m ?? '')) ? MONTH_WORDS[Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4) : '';
const yesterday = (d) => {
  if (!DAY.test(String(d ?? ''))) return '';
  const t = new Date(d + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
};
export const STOP_RULE_WORDS = {
  OFF_HIRE_DAY: 'the off-hire day',
  DAY_AFTER: 'the day after the off-hire call',
  COLLECTION: 'collection',
};
export const GOLIVE_KINDS = [
  ['customers', 'Customers', 'Name, ABN, email, address, terms, PO'],
  ['sites', 'Sites', 'Site, customer, address, PO, contact, phone'],
  ['stock', 'Yard stock', 'Part, reference, quantity, weight, system, category'],
  ['onHire', 'On hire', 'Site, part, quantity, since (DD/MM/YYYY), customer'],
  ['rates', 'Rates', 'Part, week $, day $, minimum days, from'],
];
/** @type {any} */
const LB = {
  host: null,
  bound: false,
  customers: null,
  custAt: 0,
  custBusy: false,
  settings: null,
  setAt: 0,
  setBusy: false,
  statements: null,
  stAt: 0,
  stBusy: false,
  offHires: null,
  offAt: 0,
  offBusy: false,
  preview: null,
  previewKey: '',
  previewBusy: false,
  cust: '',
  to: '',
  noAdj: false, // preview and issue without the open adjustments (a credit larger than the hire)
  month: '',
  open: null,
  form: {},
  err: null,
  working: false,
  file: null,
  issued: null,
  golive: { kind: 'customers', text: '', rows: null, check: null, result: null, err: null, busy: false },
  prun: { from: '', to: '', typed: {}, result: null, err: null, busy: false },
};
/** @param {{get:(p:string)=>Promise<any>,post:(p:string,d:any)=>Promise<any>,cmd:(a:string,d:any)=>Promise<any>,notify:(t:string)=>void,redraw:()=>void,refresh:()=>Promise<any>,state:()=>any,owner:()=>boolean,perms:()=>string[],today:()=>string|null,go:(v:string)=>void,parts?:()=>void}} host */
export function lbSetup(host) {
  LB.host = host;
  if (typeof document === 'undefined' || LB.bound) return;
  LB.bound = true;
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onInput);
  document.addEventListener('submit', onSubmit);
}
export const lbForget = () => {
  LB.custAt = 0;
  LB.setAt = 0;
  LB.stAt = 0;
  LB.offAt = 0;
  LB.previewKey = '';
};
/** Needs you's UNBILLED action lands here: the Hire page opens on that customer's statement. @param {string} id */
export const lbPick = (id) => {
  LB.cust = id ?? '';
  LB.previewKey = '';
};
/** Needs you's BILLED_CHANGED action: the Adjust form opens on that statement with the worked-out amount. @param {string} statement @param {number} cents @param {string} [description] */
export const lbAdjust = (statement, cents, description = '') => {
  LB.open = { kind: 'adjust', id: statement };
  LB.form = { amount: cents == null ? '' : (cents / 100).toFixed(2), description, reason: '', hire: true };
  LB.err = null;
};
const can = (p) => !!LB.host?.perms?.().includes(p);
// ---------------------------------------------------------------- data (fetched when missing or older than 15 s; the page redraws when it comes)
function fetchInto(key, atKey, busyKey, path, ttl = 15000, pick = (d) => d) {
  if ((!LB[key] || Date.now() - LB[atKey] > ttl) && LB.host && !LB[busyKey]) {
    LB[busyKey] = true;
    LB.host
      .get(path)
      .then((d) => {
        LB[key] = pick(d);
      })
      .catch(() => {})
      .finally(() => {
        LB[busyKey] = false;
        LB[atKey] = Date.now();
        LB.host?.redraw();
      });
  }
  return LB[key];
}
/** GET /api/customers */
export const lbCustomers = () => fetchInto('customers', 'custAt', 'custBusy', 'customers');
/** GET /api/hire-settings */
export const lbSettings = () =>
  fetchInto('settings', 'setAt', 'setBusy', 'hire-settings', 15000, (d) => d.settings ?? d);
/** GET /api/statements */
export const lbStatements = () => fetchInto('statements', 'stAt', 'stBusy', 'statements');
/** GET /api/off-hire */
export const lbOffHires = () => fetchInto('offHires', 'offAt', 'offBusy', 'off-hire');
/** GET /api/statement-preview for the chosen customer and day. */
export function lbPreview() {
  if (!LB.cust) return null;
  const key = LB.cust + '|' + LB.to + '|' + (LB.noAdj ? 'noadj' : '');
  if (LB.previewKey !== key && LB.host && !LB.previewBusy) {
    LB.previewBusy = true;
    LB.host
      .get(
        'statement-preview?customer=' +
          encodeURIComponent(LB.cust) +
          (LB.to ? '&to=' + LB.to : '') +
          (LB.noAdj ? '&adjustments=0' : ''),
      )
      .then((d) => {
        LB.preview = d;
        LB.err = null;
      })
      .catch((e) => {
        LB.preview = null;
        LB.err = e?.message ?? 'The statement could not be worked out.';
      })
      .finally(() => {
        LB.previewBusy = false;
        LB.previewKey = key;
        LB.host?.redraw();
      });
  }
  return LB.previewKey === key ? LB.preview : null;
}
// ---------------------------------------------------------------- small pieces
const head = (id, title, sub, art = '') =>
  '<div class="lb-head">' +
  (art ? '<span class="lb-art" aria-hidden="true">' + art + '</span>' : '') +
  '<div class="lb-head-text"><h2 id="' +
  id +
  '">' +
  title +
  '</h2>' +
  (sub ? '<p>' + sub + '</p>' : '') +
  '</div></div>';
const errHTML = (e) => (e ? '<p class="lb-err" role="alert">' + esc(e) + '</p>' : '');
const field = (name, label, value, { type = 'text', ph = '', max = 120, req = false, extra = '' } = {}) =>
  '<label class="lb-field"><span>' +
  label +
  '</span><input name="' +
  name +
  '" type="' +
  type +
  '" value="' +
  esc(value ?? '') +
  '"' +
  (ph ? ' placeholder="' + esc(ph) + '"' : '') +
  (max ? ' maxlength="' + max + '"' : '') +
  (req ? ' required' : '') +
  ' autocomplete="off"' +
  extra +
  '></label>';
const acts = (goWords, x = 'Never mind', working = false) =>
  '<div class="lb-form-acts"><button type="submit" class="lb-go"' +
  (working ? ' disabled' : '') +
  '>' +
  goWords +
  '</button><button type="button" class="lb-link" data-lb-act="close">' +
  x +
  '</button></div>';
const isOpen = (kind, id = '') => LB.open?.kind === kind && (LB.open.id ?? '') === (id ?? '');
const formVal = (name, fallback = '') => (LB.form[name] !== undefined ? LB.form[name] : fallback);
/** The customer picker (a site card, Send's New site, the Create site form). @param {any} customers GET /api/customers @param {string|null} current @param {{name?:string,label?:string,none?:string}} [o] */
export function lbPickHTML(
  customers,
  current,
  { name = 'customer', label = 'Customer', none = 'No customer yet' } = {},
) {
  const list = customers?.customers ?? null;
  return (
    '<label class="lb-field lb-pick"><span>' +
    label +
    '</span><select name="' +
    name +
    '"' +
    (list ? '' : ' disabled') +
    '><option value="">' +
    (list ? none : 'Loading customers…') +
    '</option>' +
    (list ?? [])
      .map(
        (c) =>
          '<option value="' + esc(c.id) + '"' + (c.id === current ? ' selected' : '') + '>' + esc(c.name) + '</option>',
      )
      .join('') +
    '</select></label>'
  );
}
// ---------------------------------------------------------------- Customers (Client sites page)
function customerForm(c) {
  const v = (k, fb) => formVal(k, fb ?? c?.[k] ?? '');
  return (
    '<form class="lb-form" data-lb-form="customer"' +
    (c ? ' data-lb-id="' + esc(c.id) + '"' : '') +
    '><p class="lb-form-title">' +
    (c ? 'Change ' + esc(c.name) : 'New customer') +
    '</p><div class="lb-fields">' +
    field('name', 'Customer name', v('name'), { req: true, ph: 'e.g. Acme Builders' }) +
    field('abn', 'ABN', v('abn', c?.abnText), { ph: '11 digits, checked', max: 20 }) +
    field('billingEmail', 'Billing email', v('billingEmail'), { type: 'email', ph: 'accounts@…', max: 254 }) +
    field('address', 'Billing address', v('address'), { max: 250 }) +
    field('termsDays', 'Payment terms (days)', v('termsDays'), {
      type: 'number',
      ph: 'not set',
      max: 0,
      extra: ' min="0" max="120" inputmode="numeric"',
    }) +
    field('defaultPO', 'Default PO', v('defaultPO'), { ph: 'optional', max: 60 }) +
    '</div>' +
    errHTML(LB.err) +
    acts(c ? 'Save' : 'Add customer', 'Never mind', LB.working) +
    '</form>'
  );
}
function reasonForm(kind, id, title, go, note = '') {
  return (
    '<form class="lb-form lb-reason" data-lb-form="' +
    kind +
    '" data-lb-id="' +
    esc(id) +
    '"><p class="lb-form-title">' +
    title +
    '</p>' +
    (note ? '<p class="lb-note">' + note + '</p>' : '') +
    '<div class="lb-fields">' +
    field('reason', 'Why (a few words)', formVal('reason'), { req: true, max: 200 }) +
    '</div>' +
    errHTML(LB.err) +
    acts(go, 'Never mind', LB.working) +
    '</form>'
  );
}
/** The customers card. @param {any} v GET /api/customers @param {{ops?:boolean,finance?:boolean,manage?:boolean}} [o] */
export function lbCustomersHTML(v, { ops = true, finance = false, manage = ops } = {}) {
  if (!v)
    return (
      '<section class="panel lb-card" id="lb-customers" aria-labelledby="lb-customers-h">' +
      head('lb-customers-h', 'Customers', '') +
      '<p class="lb-quiet">Loading…</p></section>'
    );
  const list = v.customers ?? [],
    removed = v.removed ?? [],
    unlinked = v.unlinkedSites ?? [];
  const row = (c) => {
    const sites = (c.sites ?? []).filter((s) => s.status === 'ACTIVE'),
      facts = [
        c.abnText ? 'ABN ' + esc(c.abnText) : '<i>No ABN</i>',
        c.termsDays != null ? plural(c.termsDays, 'day') + ' terms' : '<i>Terms not set</i>',
        c.defaultPO ? 'PO ' + esc(c.defaultPO) : '',
        c.billingEmail ? esc(c.billingEmail) : '',
      ]
        .filter(Boolean)
        .join(' · ');
    const money = finance
      ? c.exposure?.amount
        ? '<b>' +
          lbMoney(c.exposure.amount) +
          ' unbilled</b><small>' +
          [
            c.exposure.since ? 'since ' + esc(lbDay(c.exposure.since)) : '',
            c.lastStatement ? 'last ' + esc(c.lastStatement.number) : '',
          ]
            .filter(Boolean)
            .join(' · ') +
          '</small>'
        : '<b class="lb-none">Nothing unbilled</b>' +
          (c.lastStatement ? '<small>last ' + esc(c.lastStatement.number) + '</small>' : '')
      : '';
    return (
      '<li class="lb-cust' +
      (isOpen('customer', c.id) || isOpen('customerRemove', c.id) ? ' is-open' : '') +
      '" data-lb-cust-row="' +
      esc(c.id) +
      '"><div class="lb-cust-main"><span class="lb-cust-t"><b>' +
      esc(c.name) +
      '</b><small>' +
      facts +
      '</small><small>' +
      (sites.length
        ? plural(sites.length, 'site') +
          ': ' +
          esc(sites.map((s) => s.name + (s.po ? ' (PO ' + s.po + ')' : '')).join(', '))
        : 'No open site') +
      '</small></span>' +
      (money ? '<span class="lb-cust-money">' + money + '</span>' : '') +
      (manage
        ? '<span class="lb-cust-acts"><button type="button" class="lb-link" data-lb-act="customerEdit" data-lb-id="' +
          esc(c.id) +
          '">Change</button><button type="button" class="lb-link" data-lb-act="customerRemove" data-lb-id="' +
          esc(c.id) +
          '">Remove…</button></span>'
        : '') +
      '</div>' +
      (isOpen('customer', c.id) ? customerForm(c) : '') +
      (isOpen('customerRemove', c.id)
        ? reasonForm(
            'customerRemove',
            c.id,
            'Remove ' + esc(c.name),
            'Remove customer',
            'Kept in the records with the reason; its statements stay. A customer with an open site cannot be removed.',
          )
        : '') +
      '</li>'
    );
  };
  return (
    '<section class="panel lb-card" id="lb-customers" aria-labelledby="lb-customers-h">' +
    head(
      'lb-customers-h',
      'Customers',
      'Who you bill. A site links to one customer; one statement per customer covers all its sites.',
    ) +
    (unlinked.length && manage
      ? '<div class="lb-notice"><span>' +
        esc(plural(unlinked.length, 'site')) +
        ' with a client name but no customer: ' +
        esc(unlinked.map((s) => s.name + ' (' + s.client + ')').join(', ')) +
        '.</span><button type="button" class="lb-btn" data-lb-act="link">Link client names to customers</button></div>'
      : '') +
    (list.length
      ? '<ul class="lb-custs">' + list.map(row).join('') + '</ul>'
      : '<p class="lb-quiet">No customers yet.' +
        (manage ? ' Add one, or link the client names already on your sites.' : '') +
        '</p>') +
    (manage
      ? isOpen('customer', '')
        ? customerForm(null)
        : '<div class="lb-acts"><button type="button" class="lb-btn" data-lb-act="customerNew">+ Customer</button></div>'
      : '') +
    (removed.length
      ? '<details class="lb-removed"><summary>' +
        esc(plural(removed.length, 'removed customer')) +
        '</summary><ul class="lb-custs lb-custs-off">' +
        removed
          .map(
            (c) =>
              '<li class="lb-cust"><div class="lb-cust-main"><span class="lb-cust-t"><b>' +
              esc(c.name) +
              '</b><small>Removed' +
              (c.removedOn ? ' ' + esc(lbDay(c.removedOn)) : '') +
              (c.removedReason ? ': ' + esc(c.removedReason) : '') +
              '</small>' +
              (finance && c.exposure?.amount
                ? '<small><b>' +
                  lbMoney(c.exposure.amount) +
                  ' unbilled</b>: bring it back to issue the statement</small>'
                : '') +
              '</span>' +
              (manage
                ? '<span class="lb-cust-acts"><button type="button" class="lb-link" data-lb-act="customerRestore" data-lb-id="' +
                  esc(c.id) +
                  '">Bring back</button></span>'
                : '') +
              '</div></li>',
          )
          .join('') +
        '</ul></details>'
      : '') +
    '</section>'
  );
}
// ---------------------------------------------------------------- a site card: bills to, off-hire, opening lot
/** @param {any} site @param {{customers:any,offHires:any,ops?:boolean,today?:string|null,products?:any[]}} o */
export function lbSiteHTML(site, { customers, offHires, ops = true, today = null, products = [] }) {
  const c = (customers?.customers ?? []).find((x) => x.id === site.customer) ?? null,
    mine = (offHires?.offHires ?? []).filter((o) => o.site === site.id),
    waiting = mine.find((o) => o.status === 'WAITING') ?? null,
    last = mine.find((o) => o.status === 'COLLECTED') ?? null,
    active = site.status === 'ACTIVE';
  let h =
    '<div class="lb-site" data-lb-site="' +
    esc(site.id) +
    '"><p class="lb-site-line"><span class="lb-site-k">Bills to</span>' +
    (c
      ? '<b>' + esc(c.name) + '</b>' + (site.po ? '<small>PO ' + esc(site.po) + '</small>' : '')
      : site.customer
        ? '<b>' + esc(site.customerName ?? 'Customer') + '</b>'
        : '<i>No customer yet</i>' + (ops && active ? '<small>Set it under Edit site details</small>' : '')) +
    '</p>';
  if (waiting)
    h +=
      '<p class="lb-site-line' +
      (waiting.overdue ? ' is-late' : '') +
      '"><span class="lb-site-k">Off-hire</span><b>' +
      esc(waiting.label) +
      '</b><small>called ' +
      esc(lbDay(waiting.when)) +
      ' by ' +
      esc(waiting.whoCalled) +
      ' · pickup ' +
      esc(waiting.orderLabel) +
      ' for ' +
      esc(lbDay(waiting.pickupDay)) +
      (waiting.overdue ? ' · <b>not collected yet</b>' : '') +
      '</small></p>';
  else if (last)
    h +=
      '<p class="lb-site-line"><span class="lb-site-k">Off-hire</span><b>' +
      esc(last.label) +
      '</b><small>called ' +
      esc(lbDay(last.when)) +
      ' by ' +
      esc(last.whoCalled) +
      (last.collectedOn ? ' · collected ' + esc(lbDay(last.collectedOn)) : '') +
      '</small></p>';
  if (ops && active) {
    const off = isOpen('offHire', site.id),
      lot = isOpen('openingLot', site.id);
    h +=
      '<div class="lb-acts">' +
      (waiting
        ? ''
        : '<button type="button" class="lb-btn" data-lb-act="offHire" data-lb-id="' +
          esc(site.id) +
          '" aria-expanded="' +
          off +
          '">Off-hire called…</button>') +
      '<button type="button" class="lb-link" data-lb-act="openingLot" data-lb-id="' +
      esc(site.id) +
      '" aria-expanded="' +
      lot +
      '">Already on hire here? Add an opening lot</button></div>';
    if (off)
      h +=
        '<form class="lb-form" data-lb-form="offHire" data-lb-id="' +
        esc(site.id) +
        '"><p class="lb-form-title">The builder called it off</p><div class="lb-fields">' +
        field('when', 'Day they called', formVal('when', today ?? ''), {
          type: 'date',
          req: true,
          max: 0,
          extra: today ? ' max="' + esc(today) + '"' : '',
        }) +
        field('whoCalled', 'Who called', formVal('whoCalled'), { req: true, ph: 'e.g. Mick, site foreman' }) +
        field('pickupDay', 'Pickup day', formVal('pickupDay', today ?? ''), {
          type: 'date',
          req: true,
          max: 0,
        }) +
        field('note', 'Note', formVal('note'), { ph: 'optional', max: 300 }) +
        '</div><p class="lb-note">Makes a pickup number and one bring-back for what is on the site’s record (a bring-back already open keeps its part). A pickup day already gone is overdue on Needs you. When hire stops is the company’s rule (Hire settings).</p>' +
        errHTML(LB.err) +
        acts('Record the off-hire', 'Never mind', LB.working) +
        '</form>';
    if (lot)
      h +=
        '<form class="lb-form" data-lb-form="openingLot" data-lb-id="' +
        esc(site.id) +
        '"><p class="lb-form-title">Gear already on hire here when the yard went live</p><div class="lb-fields">' +
        '<label class="lb-field"><span>Part</span><select name="product" required><option value="">Choose a part…</option>' +
        (products ?? [])
          .filter((p) => !p.retired)
          .map(
            (p) =>
              '<option value="' +
              esc(p.id) +
              '"' +
              (formVal('product') === p.id ? ' selected' : '') +
              '>' +
              esc(p.name + (p.reference ? ' · ' + p.reference : '')) +
              '</option>',
          )
          .join('') +
        '</select></label>' +
        field('quantity', 'Pieces', formVal('quantity'), {
          type: 'number',
          req: true,
          max: 0,
          extra: ' min="1" step="1" inputmode="numeric"',
        }) +
        field('onHireSince', 'On hire since', formVal('onHireSince'), {
          type: 'date',
          req: true,
          max: 0,
          extra: today ? ' max="' + esc(today) + '"' : '',
        }) +
        (site.customer ? '' : lbPickHTML(customers, formVal('customer'), { none: 'No customer' })) +
        '</div>' +
        (site.billedUpTo
          ? '<label class="lb-check-line"><input type="checkbox" name="beforeBilled" value="1"' +
            (formVal('beforeBilled') ? ' checked' : '') +
            '><span>Hire before ' +
            esc(lbDay(site.billedUpTo)) +
            ' (billed on ' +
            esc(site.lastStatement ?? 'the last statement') +
            ') goes on an adjustment I will add</span></label>'
          : '') +
        '<p class="lb-note">Hire runs from that day at the rates of that day, never from today.</p>' +
        errHTML(LB.err) +
        acts('Add the lot', 'Never mind', LB.working) +
        '</form>';
  }
  return h + '</div>';
}
// ---------------------------------------------------------------- Hire page: statements
const rateWords = (r) =>
  !r?.priced
    ? 'no rate'
    : [r.week != null ? lbMoney(r.week) + '/wk' : '', r.day != null ? lbMoney(r.day) + '/day' : '']
        .filter(Boolean)
        .join(' + ') + (r.minDays ? ' · min ' + r.minDays + ' days' : '');
const CHARGE_WORDS = {
  LOST: 'Lost',
  DAMAGED: 'Damaged',
  SITE_FINISH: 'Not returned at site finish',
  QUARANTINE: 'Quarantine',
};
/** The pieces column in words: what moved inside the period ('30 at start · 24 in · 54 out · 0 at end'). @param {any} l */
export const lbPiecesWords = (l) => {
  const m = l.moved;
  if (!m || (!m.in && !m.out)) return l.start === l.end ? String(l.end) : l.start + ' → ' + l.end;
  return [
    l.start + ' at start',
    m.in ? m.in + ' in' : '',
    m.out ? m.out + ' out' + (m.sameDay ? ' (' + m.sameDay + ' same-day return)' : '') : '',
    l.end + ' at end',
  ]
    .filter(Boolean)
    .join(' · ');
};
/** The minimum-hire top-up in words: '24 × 28 days + 30 × 17 days short of the 28-day minimum'. @param {any} t */
export const lbTopUpWords = (t) => {
  const parts = (t?.parts ?? []).map((p) => p.q + ' × ' + plural(p.days, 'day'));
  return parts.length
    ? parts.join(' + ') + ' short of the ' + t.minDays + '-day minimum'
    : 'back before the ' + t.minDays + '-day minimum';
};
/** The statement body (a preview or an issued one): sites, lines, charges, adjustments, totals, the rule, the footer. @param {any} st */
export function lbStatementBodyHTML(st) {
  const cell = (label, html, cls = 'num') => '<td class="' + cls + '" data-l="' + label + '">' + html + '</td>';
  const line = (l) =>
    '<tr class="lb-line' +
    (l.rate?.priced || l.zero ? '' : ' is-unpriced') +
    (l.zero ? ' is-zero' : '') +
    '"><td class="lb-c-what"><b>' +
    esc(l.product.name) +
    '</b>' +
    (l.product.reference ? '<small>' + esc(l.product.reference) + '</small>' : '') +
    (l.split ? '<small>rate for ' + esc(lbDay(l.rateFrom)) + ' – ' + esc(lbDay(l.rateTo)) + '</small>' : '') +
    (l.zero ? '<small>same-day return: no hire charged</small>' : '') +
    (l.offHire ?? []).map((o) => '<small class="lb-rule">' + esc(o.words) + '</small>').join('') +
    '</td>' +
    cell('Pieces', esc(lbPiecesWords(l)), 'num lb-c-pcs') +
    cell('Piece-days', String(l.pieceDays)) +
    cell('Rate', esc(rateWords(l.rate)), 'num lb-c-rate') +
    cell('Amount', '<b>' + (l.amount == null ? 'not priced' : lbMoney(l.amount)) + '</b>', 'num lb-c-amt') +
    '</tr>' +
    (l.topUp
      ? '<tr class="lb-topup"><td class="lb-c-what">Minimum hire top-up<small>' +
        esc(l.product.name) +
        ' · ' +
        esc(lbTopUpWords(l.topUp)) +
        '</small></td>' +
        cell('Pieces', '', 'num lb-c-pcs') +
        cell('Piece-days', String(l.topUp.pieceDays)) +
        cell('Rate', '', 'num lb-c-rate') +
        cell(
          'Amount',
          '<b>' + (l.topUp.amount == null ? 'not priced' : lbMoney(l.topUp.amount)) + '</b>',
          'num lb-c-amt',
        ) +
        '</tr>'
      : '');
  const charge = (c) =>
    '<tr class="lb-charge"><td class="lb-c-what"><b>' +
    esc(CHARGE_WORDS[c.reason] ?? c.reason) +
    ': ' +
    esc(c.quantity + ' × ' + c.name) +
    '</b><small>' +
    esc(lbDay(c.occurredOn)) +
    (c.approvedBy ? ' · approved by ' + esc(c.approvedBy) : '') +
    '</small></td>' +
    cell('Pieces', String(c.quantity), 'num lb-c-pcs') +
    cell('Piece-days', '') +
    cell('Rate', lbMoney(c.unitValue) + ' each', 'num lb-c-rate') +
    cell('Amount', '<b>' + lbMoney(c.amount) + '</b>', 'num lb-c-amt') +
    '</tr>';
  const sites = (st.sites ?? [])
    .map(
      (s) =>
        '<div class="lb-st-site"><p class="lb-st-site-h"><b>' +
        esc(s.name) +
        '</b><small>' +
        [s.address ? esc(s.address) : '', s.po ? 'PO ' + esc(s.po) : '', esc(lbDay(s.from)) + ' – ' + esc(lbDay(s.to))]
          .filter(Boolean)
          .join(' · ') +
        '</small></p><div class="lb-table-wrap"><table class="lb-table"><thead><tr><th>Material</th><th class="num lb-c-pcs">Pieces</th><th class="num">Piece-days</th><th class="num lb-c-rate">Rate (ex GST)</th><th class="num lb-c-amt">Amount</th></tr></thead><tbody>' +
        (s.lines ?? []).map(line).join('') +
        (s.charges ?? []).map(charge).join('') +
        '</tbody><tfoot><tr><td colspan="4">' +
        esc(s.name) +
        ' subtotal</td><td class="num"><b>' +
        lbMoney(s.subtotal) +
        '</b></td></tr></tfoot></table></div></div>',
    )
    .join('');
  const adj = (st.adjustments ?? []).length
    ? '<div class="lb-st-site"><p class="lb-st-site-h"><b>Adjustments</b></p><ul class="lb-adjs">' +
      st.adjustments
        .map(
          (a) =>
            '<li><span><b>' +
            esc(a.number) +
            ' · ' +
            esc(a.description) +
            '</b><small>' +
            esc(a.reason) +
            (a.statement?.number ? ' · after ' + esc(a.statement.number) : '') +
            ' · approved by ' +
            esc(a.approvedBy?.name ?? '') +
            ' · ' +
            esc(lbDay(a.madeOn)) +
            '</small></span><b>' +
            lbMoney(a.amount) +
            '</b></li>',
        )
        .join('') +
      '</ul></div>'
    : '';
  return (
    sites +
    adj +
    '<div class="lb-totals"><div><small>Subtotal ex GST</small><b>' +
    lbMoney(st.subtotal) +
    '</b></div><div><small>GST ' +
    (st.gstPercent ?? 10) +
    '%</small><b>' +
    lbMoney(st.gst) +
    '</b></div><div class="grand"><small>Total inc GST</small><b>' +
    lbMoney(st.total) +
    '</b></div></div>' +
    '<p class="lb-rule-line">' +
    esc(st.hireStopRule ?? '') +
    (st.dueOn
      ? ' Due ' +
        esc(lbDayYear(st.dueOn)) +
        (st.customer?.termsDays != null ? ' (' + st.customer.termsDays + '-day terms).' : '.')
      : '') +
    '</p><p class="lb-footer">' +
    esc(st.footer ?? 'Statement — your accounting package issues the tax invoice.') +
    '</p>'
  );
}
/** The statements card: pick a customer, the preview, Issue; the issued list; the accounting file. @param {{customers:any,statements:any,preview:any,settings:any,today:string|null,finance?:boolean,issue?:boolean,owner?:boolean}} o */
export function lbStatementsHTML({
  customers,
  statements,
  preview,
  settings,
  today,
  finance = true,
  issue = false,
  owner = false,
}) {
  if (!finance) return '';
  const list = customers?.customers ?? [],
    cust = list.find((c) => c.id === LB.cust) ?? null;
  const pick =
    '<div class="lb-controls"><label class="lb-field lb-pick"><span>Customer</span><select data-lb-cust' +
    (customers ? '' : ' disabled') +
    '><option value="">' +
    (customers ? 'Choose a customer…' : 'Loading…') +
    '</option>' +
    list
      .map(
        (c) =>
          '<option value="' +
          esc(c.id) +
          '"' +
          (c.id === LB.cust ? ' selected' : '') +
          '>' +
          esc(c.name) +
          (c.exposure?.amount ? ' · ' + lbMoney(c.exposure.amount) + ' unbilled' : '') +
          '</option>',
      )
      .join('') +
    '</select></label><label class="lb-field"><span>Up to</span><input type="date" data-lb-to value="' +
    esc(LB.to || preview?.to || yesterday(today) || '') +
    '"' +
    (today ? ' max="' + esc(today) + '"' : '') +
    '></label></div>';
  // why Issue is off, with the one thing that fixes it: the day before the call, or the hire without the adjustments
  const fix =
    preview && !preview.canIssue
      ? preview.whyCode === 'PICKUP_OPEN' && preview.suggestedTo
        ? '<button type="button" class="lb-btn" data-lb-act="to" data-lb-day="' +
          esc(preview.suggestedTo) +
          '">Up to ' +
          esc(lbDay(preview.suggestedTo)) +
          '</button>'
        : preview.whyCode === 'TO_TODAY' && today
          ? '<button type="button" class="lb-btn" data-lb-act="to" data-lb-day="' +
            esc(yesterday(today)) +
            '">Up to ' +
            esc(lbDay(yesterday(today))) +
            '</button>'
          : preview.whyCode === 'MIXED_CREDIT' && issue
            ? '<button type="button" class="lb-btn" data-lb-act="noAdj">Preview without the adjustments</button>'
            : ''
      : '';
  let body;
  if (!LB.cust)
    body =
      '<p class="lb-quiet">' +
      (list.length
        ? 'Choose a customer: everything unbilled at its sites since the last statement shows here.'
        : 'No customers yet: add them on Client sites, or link the client names already on your sites.') +
      '</p>';
  else if (!preview) body = '<p class="lb-quiet">' + (LB.err ? esc(LB.err) : 'Working it out…') + '</p>';
  else
    body =
      '<div class="lb-preview' +
      (preview.canIssue ? '' : ' is-blocked') +
      '"><p class="lb-preview-h"><span class="lb-badge">Preview</span><b>' +
      esc(preview.customer.name) +
      '</b><small>' +
      esc(lbDay(preview.from)) +
      ' – ' +
      esc(lbDay(preview.to)) +
      (preview.customer.abnText ? ' · ABN ' + esc(preview.customer.abnText) : '') +
      '</small></p>' +
      (preview.why && preview.whyCode === 'PICKUP_OPEN'
        ? '<p class="lb-warn" role="alert">' + esc(preview.why) + ' ' + fix + '</p>'
        : '') +
      (preview.heldAdjustments
        ? '<p class="lb-note">' +
          esc(plural(preview.heldAdjustments, 'open adjustment')) +
          ' left off this statement (kept for the next one). <button type="button" class="lb-link" data-lb-act="withAdj">Put them back</button></p>'
        : '') +
      (preview.empty ? '' : lbStatementBodyHTML(preview)) +
      (preview.why && preview.whyCode !== 'PICKUP_OPEN'
        ? '<p class="lb-why">' + esc(preview.why) + ' ' + fix + '</p>'
        : '') +
      (issue && preview.canIssue
        ? '<div class="lb-acts"><button type="button" class="lb-go" data-lb-act="issue"' +
          (LB.working ? ' disabled' : '') +
          '>Issue statement</button><small class="lb-note">Locks it under the next number. A reprint is byte-identical; changes after issue are adjustments.</small></div>'
        : '') +
      '</div>';
  if (LB.issued)
    body =
      '<div class="lb-issued-now" role="status"><b>' +
      esc(LB.issued.number) +
      ' issued</b> · ' +
      lbMoney(LB.issued.total) +
      ' inc GST for ' +
      esc(LB.issued.customer?.name ?? '') +
      '. <a href="/api/statement.txt?id=' +
      esc(LB.issued.id) +
      '" target="_blank" rel="noopener">Reprint</a></div>' +
      body;
  // the issued list
  const rows = statements?.statements ?? [],
    shown = rows.slice(0, 20);
  const stRow = (s) =>
    '<li class="lb-st' +
    (s.reverses ? ' is-reversal' : s.reversedBy ? ' is-reversed' : '') +
    '" data-lb-st="' +
    esc(s.id) +
    '"><span class="lb-st-t"><b>' +
    esc(s.number) +
    '</b><span class="lb-badge lock" title="Locked: a reprint is byte-identical">Locked</span>' +
    (s.reverses ? '<span class="lb-badge">reverses ' + esc(s.reverses.number) + '</span>' : '') +
    (s.reversedBy ? '<span class="lb-badge off">reversed by ' + esc(s.reversedBy.number) + '</span>' : '') +
    '<small>' +
    esc(s.customerName) +
    ' · ' +
    esc((s.sites ?? []).join(', ')) +
    ' · ' +
    esc(lbDay(s.from)) +
    ' – ' +
    esc(lbDay(s.to)) +
    ' · issued ' +
    esc(lbDay(s.issuedOn)) +
    ' by ' +
    esc(s.issuedBy) +
    // what happened to it: 'in the Xero file for October 2026 (downloaded Thu 1 Oct)' — a file the office imports, nothing is sent
    (s.exports ?? [])
      .slice()
      .reverse()
      .filter((e, i, all) => all.findIndex((x) => x.format === e.format) === i)
      .map(
        (e) =>
          ' · in the ' +
          esc(e.words ?? e.format) +
          ' file for ' +
          esc(lbMonth(e.month)) +
          (e.on ? ' (downloaded ' + esc(lbDay(e.on)) + ')' : ''),
      )
      .join('') +
    '</small>' +
    (s.reverses && s.reason
      ? '<small class="lb-st-reason">Reverses ' + esc(s.reverses.number) + ': ' + esc(s.reason) + '</small>'
      : '') +
    (s.drift && !s.reversedBy
      ? '<small class="lb-drift">' +
        esc(
          'Reads ' +
            lbMoney(s.drift.now) +
            ' now (billed ' +
            lbMoney(s.drift.billed) +
            (s.drift.adjusted ? ', ' + lbMoney(s.drift.adjusted) + ' adjusted' : '') +
            '): an adjustment of ' +
            lbMoney(s.drift.delta) +
            ' would square it.',
        ) +
        (owner
          ? ' <button type="button" class="lb-link" data-lb-act="driftAdjust" data-lb-id="' +
            esc(s.id) +
            '" data-lb-cents="' +
            esc(s.drift.delta) +
            '" data-lb-words="' +
            esc(s.drift.description ?? '') +
            '">Adjust ' +
            lbMoney(s.drift.delta) +
            '…</button>'
          : '') +
        '</small>'
      : '') +
    '</span><b class="lb-st-total">' +
    lbMoney(s.total) +
    '</b><span class="lb-st-acts"><a class="lb-link" href="/api/statement.txt?id=' +
    esc(s.id) +
    '" target="_blank" rel="noopener">Reprint</a>' +
    (owner && !s.reverses && !s.reversedBy
      ? '<button type="button" class="lb-link" data-lb-act="adjust" data-lb-id="' +
        esc(s.id) +
        '">Adjust…</button><button type="button" class="lb-link" data-lb-act="reverse" data-lb-id="' +
        esc(s.id) +
        '">Reverse…</button>'
      : '') +
    '</span>' +
    (isOpen('reverse', s.id)
      ? reasonForm(
          'reverse',
          s.id,
          'Reverse ' + esc(s.number),
          'Reverse it',
          'A reversing statement under the next number voids it; the sites are open to bill again. Nothing is deleted.',
        )
      : '') +
    (isOpen('adjust', s.id)
      ? '<form class="lb-form" data-lb-form="adjust" data-lb-id="' +
        esc(s.id) +
        '" data-lb-cust-id="' +
        esc(s.customer) +
        '"><p class="lb-form-title">Adjustment after ' +
        esc(s.number) +
        '</p><div class="lb-fields">' +
        field('amount', 'Amount ex GST ($, minus for a credit)', formVal('amount'), {
          req: true,
          ph: 'e.g. -120.00',
          max: 20,
          extra: ' inputmode="decimal"',
        }) +
        field('description', 'What it is for', formVal('description'), { req: true, max: 120 }) +
        field('reason', 'Why (a few words)', formVal('reason'), { req: true, max: 200 }) +
        '</div><label class="lb-check-line"><input type="checkbox" name="hire" value="1"' +
        (formVal('hire') ? ' checked' : '') +
        '><span>This squares the hire of ' +
        esc(s.number) +
        ' read again (the "Billed differently" item), not a credit on top</span></label><p class="lb-note">Goes on ' +
        esc(s.customerName) +
        '’s next statement with you as the approver. The issued statement stays as it was.</p>' +
        errHTML(LB.err) +
        acts('Record the adjustment', 'Never mind', LB.working) +
        '</form>'
      : '') +
    '</li>';
  const issued = !statements
    ? '<p class="lb-quiet">Loading…</p>'
    : rows.length
      ? '<ul class="lb-sts">' +
        shown.map(stRow).join('') +
        '</ul>' +
        (rows.length > shown.length
          ? '<p class="lb-quiet">and ' + plural(rows.length - shown.length, 'more') + '</p>'
          : '')
      : '<p class="lb-quiet">Nothing issued yet.</p>';
  // the accounting file
  const month = LB.month || (today ?? '').slice(0, 7),
    xeroReady = !!settings?.xeroReady,
    myobReady = !!settings?.myobReady;
  const file =
    '<div class="lb-file"><label class="lb-field"><span>Month</span><input type="month" data-lb-month value="' +
    esc(month) +
    '"' +
    (today ? ' max="' + esc(today.slice(0, 7)) + '"' : '') +
    '></label><div class="lb-file-btns">' +
    (issue
      ? '<button type="button" class="lb-btn" data-lb-act="file" data-lb-fmt="xero"' +
        (xeroReady ? '' : ' disabled') +
        '>Download for Xero</button><button type="button" class="lb-btn" data-lb-act="file" data-lb-fmt="myob"' +
        (myobReady ? '' : ' disabled') +
        '>Download for MYOB</button><button type="button" class="lb-btn" data-lb-act="file" data-lb-fmt="generic">Generic CSV</button>'
      : '') +
    '</div>' +
    (settings && (!xeroReady || !myobReady)
      ? '<p class="lb-note lb-notset">' +
        (!xeroReady ? 'Xero: sales account code not set. ' : '') +
        (!myobReady ? 'MYOB: income account number not set. ' : '') +
        (owner
          ? '<button type="button" class="lb-link" data-lb-act="goSettings">Hire settings</button>'
          : 'The owner sets it under Hire settings.') +
        '</p>'
      : '') +
    (LB.file
      ? '<p class="lb-file-words" role="status">' +
        (LB.file.err
          ? esc(LB.file.err)
          : '<b>' +
            esc(LB.file.name) +
            '</b> saved: ' +
            esc(plural(LB.file.statements?.length ?? 0, 'statement')) +
            ', ' +
            lbMoney(LB.file.total) +
            ' inc GST. ' +
            esc(LB.file.words ?? '')) +
        '</p>'
      : '') +
    '</div>';
  return (
    '<section class="panel hr-card lb-card" id="lb-statements" aria-labelledby="lb-statements-h">' +
    head(
      'lb-statements-h',
      'Statements',
      'One statement per customer, for all its sites since the last one. Issued statements are locked; your accounting package issues the tax invoice.',
    ) +
    pick +
    body +
    '<h3 class="lb-sub">Issued</h3>' +
    issued +
    '<h3 class="lb-sub">The accounting file</h3><p class="lb-note">One file a month: every statement issued in the month, one row per line, ex GST, in the layout your package imports. No sync: you import the file.</p>' +
    file +
    '</section>'
  );
}
// ---------------------------------------------------------------- Hire page: settings (owner)
/** @param {any} s GET /api/hire-settings @param {{owner?:boolean}} [o] */
export function lbSettingsHTML(s, { owner = false } = {}) {
  if (!owner) return '';
  if (!s)
    return (
      '<section class="panel hr-card lb-card" id="lb-settings" aria-labelledby="lb-settings-h">' +
      head('lb-settings-h', 'Hire settings', '') +
      '<p class="lb-quiet">Loading…</p></section>'
    );
  const v = (k) => formVal(k, s[k] ?? ''),
    rule = formVal('stopRule', s.stopRule);
  const radio = (id, words) =>
    '<label class="lb-radio"><input type="radio" name="stopRule" value="' +
    id +
    '"' +
    (rule === id ? ' checked' : '') +
    '><span>' +
    words +
    '</span></label>';
  return (
    '<section class="panel hr-card lb-card" id="lb-settings" aria-labelledby="lb-settings-h">' +
    head(
      'lb-settings-h',
      'Hire settings',
      'The company’s rules for statements and the accounting file. Codes are yours: nothing here is guessed.',
    ) +
    '<form class="lb-form lb-settings" data-lb-form="settings"><fieldset class="lb-fieldset"><legend>When hire stops after an off-hire call</legend>' +
    radio('OFF_HIRE_DAY', 'On the off-hire day') +
    radio('DAY_AFTER', 'The day after the call') +
    radio('COLLECTION', 'At collection') +
    '<label class="lb-field lb-narrow"><span>…if collected within (days)</span><input type="number" name="collectWithinDays" min="1" max="90" step="1" value="' +
    esc(v('collectWithinDays')) +
    '" inputmode="numeric"></label><p class="lb-note">Now: ' +
    esc(s.ruleSentence ?? '') +
    ' Every statement line the rule touches says so.</p></fieldset>' +
    '<fieldset class="lb-fieldset"><legend>Xero</legend><div class="lb-fields">' +
    field('xeroAccountCode', 'Sales account code', v('xeroAccountCode'), { ph: 'not set', max: 20 }) +
    field('xeroTaxType', 'Tax rate name', v('xeroTaxType'), { ph: 'GST on Income', max: 60 }) +
    '</div></fieldset><fieldset class="lb-fieldset"><legend>MYOB</legend><div class="lb-fields">' +
    field('myobAccountNumber', 'Income account number', v('myobAccountNumber'), { ph: 'not set', max: 20 }) +
    field('myobTaxCode', 'Tax code', v('myobTaxCode'), { ph: 'GST', max: 10 }) +
    '</div></fieldset><fieldset class="lb-fieldset"><legend>Records</legend>' +
    '<label class="lb-field lb-narrow"><span>Keep records (years)</span><input type="number" name="retentionYears" min="5" max="99" step="1" value="' +
    esc(v('retentionYears')) +
    '" inputmode="numeric"></label><p class="lb-note">Nothing money- or time-related is ever deleted: removed sites, rates and customers are kept with their reason. Only closed messages older than this go.</p></fieldset>' +
    errHTML(isOpen('settings') ? LB.err : null) +
    '<div class="lb-form-acts"><button type="submit" class="lb-go"' +
    (LB.working ? ' disabled' : '') +
    '>Save hire settings</button>' +
    (s.updatedOn ? '<small class="lb-note">Saved ' + esc(lbDay(s.updatedOn)) + '</small>' : '') +
    '</div></form></section>'
  );
}
// ---------------------------------------------------------------- Hire page: go-live import and the parallel run (owner)
/** Pasted rows (tabs from a spreadsheet, or commas) → [{header: value}] and the headers. @param {string} text */
export function lbParseSheet(text) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const delim = lines[0].includes('\t') ? '\t' : lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const split = (line) => {
    if (delim === '\t') return line.split('\t').map((c) => c.trim());
    const out = [];
    let cur = '',
      q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const headers = split(lines[0]).map((h) => h.replace(/^﻿/, ''));
  const rows = lines.slice(1).map((l) => {
    const cells = split(l),
      r = {};
    headers.forEach((h, i) => {
      if (h) r[h] = cells[i] ?? '';
    });
    return r;
  });
  return { headers, rows };
}
// What applying a checked row would do, in a few words (a customer or site to make carries its fields, not a sentence).
const planWords = (p) =>
  p?.words ??
  (p?.action === 'create' && p.name
    ? p.name +
      (p.customerName ? ' · ' + p.customerName : '') +
      (p.termsDays != null ? ' · ' + p.termsDays + '-day terms' : '') +
      (p.po ? ' · PO ' + p.po : '') +
      ' (new)'
    : '');
/** @param {{owner?:boolean,products?:any[]}} [o] */
export function lbGoLiveHTML({ owner = false } = {}) {
  if (!owner) return '';
  const g = LB.golive,
    kind = GOLIVE_KINDS.find(([k]) => k === g.kind) ?? GOLIVE_KINDS[0];
  const chips = GOLIVE_KINDS.map(
    ([k, w]) =>
      '<button type="button" class="lb-chip' +
      (k === g.kind ? ' on' : '') +
      '" data-lb-act="kind" data-lb-kind="' +
      k +
      '" aria-pressed="' +
      (k === g.kind) +
      '">' +
      w +
      '</button>',
  ).join('');
  const check = g.check
    ? '<div class="lb-check' +
      (g.check.ok ? ' ok' : ' bad') +
      '"><p class="lb-check-h"><b>' +
      esc(g.check.words ?? '') +
      '</b></p><ol class="lb-rows">' +
      (g.check.rows ?? [])
        .slice(0, 60)
        .map(
          (r) =>
            '<li class="' +
            (r.problems?.length ? 'bad' : r.plan?.action === 'skip' ? 'skip' : 'ok') +
            '"><b>' +
            r.row +
            '</b><span>' +
            esc(planWords(r.plan)) +
            (r.problems?.length ? '<em>' + esc(r.problems.join('; ')) + '</em>' : '') +
            '</span></li>',
        )
        .join('') +
      '</ol>' +
      ((g.check.rows ?? []).length > 60
        ? '<p class="lb-quiet">and ' + ((g.check.rows ?? []).length - 60) + ' more rows</p>'
        : '') +
      '</div>'
    : '';
  const result = g.result
    ? '<p class="lb-done" role="status"><b>' +
      esc(g.result.message ?? '') +
      '</b>' +
      (g.result.made?.length
        ? ' ' +
          esc(
            g.result.made
              .slice(0, 8)
              .map((m) => m.name ?? (m.kind === 'lot' ? m.quantity + ' × ' + m.name : m.kind))
              .filter(Boolean)
              .join(', '),
          ) +
          (g.result.made.length > 8 ? ', …' : '')
        : '') +
      '</p>'
    : '';
  return (
    '<section class="panel hr-card lb-card" id="lb-golive" aria-labelledby="lb-golive-h">' +
    head(
      'lb-golive-h',
      'Bring your yard in',
      'Paste a list from your spreadsheet: customers, sites, yard stock, what is on hire (with its date) and your rates. Every row is checked first; a wrong row stops the whole list and says why. Nothing is guessed.',
    ) +
    '<div class="lb-chips" role="group" aria-label="Which list">' +
    chips +
    '</div><p class="lb-note">Columns for ' +
    kind[1].toLowerCase() +
    ': ' +
    esc(kind[2]) +
    '. The header row first; other columns are ignored.</p>' +
    '<textarea class="lb-paste" data-lb-text rows="6" spellcheck="false" placeholder="Select the rows in your spreadsheet (header row included), copy, paste here.">' +
    esc(g.text) +
    '</textarea>' +
    errHTML(g.err) +
    '<div class="lb-acts"><button type="button" class="lb-btn" data-lb-act="glCheck"' +
    (g.busy ? ' disabled' : '') +
    '>Check the rows</button><button type="button" class="lb-go" data-lb-act="glImport"' +
    (g.busy || !g.check?.ok ? ' disabled' : '') +
    '>Bring them in</button>' +
    (LB.host?.parts
      ? '<button type="button" class="lb-link" data-lb-act="parts">Choose more parts from the catalogue</button>'
      : '') +
    '</div>' +
    check +
    result +
    lbParallelHTML() +
    '</section>'
  );
}
/** The parallel run: the app's figure per customer beside what the office invoiced. */
export function lbParallelHTML() {
  const p = LB.prun,
    r = p.result;
  const rows = r
    ? '<div class="lb-table-wrap"><table class="lb-table lb-prun-table"><thead><tr><th>Customer</th><th class="num">The app (ex GST)</th><th class="num">What we invoiced</th><th class="num">Difference</th></tr></thead><tbody>' +
      (r.rows ?? [])
        .map(
          (x) =>
            '<tr><td><b>' +
            esc(x.name) +
            '</b><small>' +
            esc(plural(x.sites, 'site')) +
            (x.unpriced ? ' · ' + esc(plural(x.unpriced, 'part')) + ' not priced' : '') +
            '</small></td><td class="num">' +
            lbMoney(x.app) +
            '</td><td class="num"><input class="lb-typed" data-lb-typed="' +
            esc(x.customer) +
            '" inputmode="decimal" placeholder="0.00" value="' +
            esc(p.typed[x.customer] ?? (x.invoiced != null ? (x.invoiced / 100).toFixed(2) : '')) +
            '" aria-label="What we invoiced ' +
            esc(x.name) +
            '"></td><td class="num' +
            (x.difference ? (x.difference > 0 ? ' is-over' : ' is-under') : '') +
            '" data-lb-diff="' +
            esc(x.customer) +
            '" data-lb-app="' +
            esc(x.app) +
            '"><b>' +
            (x.difference == null ? '–' : lbMoney(x.difference)) +
            '</b>' +
            (x.percent != null ? '<small>' + (x.percent > 0 ? '+' : '') + x.percent + '%</small>' : '') +
            '</td></tr>',
        )
        .join('') +
      '</tbody></table></div><p class="lb-note">' +
      esc(r.words ?? '') +
      '</p>'
    : '';
  return (
    '<div class="lb-prun"><h3 class="lb-sub">Parallel run</h3><p class="lb-note">For a period, the app’s hire per customer beside what the office invoiced. Work it out, then type your figures: the difference shows as you type (app minus invoiced).</p>' +
    '<form class="lb-form lb-inline" data-lb-form="prun"><div class="lb-fields">' +
    field('from', 'From', p.from, { type: 'date', req: true, max: 0 }) +
    field('to', 'To', p.to, { type: 'date', req: true, max: 0 }) +
    '</div>' +
    errHTML(p.err) +
    '<div class="lb-form-acts"><button type="submit" class="lb-btn"' +
    (p.busy ? ' disabled' : '') +
    '>' +
    (r ? 'Work it out again' : 'Work it out') +
    '</button></div></form>' +
    rows +
    '</div>'
  );
}
// ---------------------------------------------------------------- events
async function run(action, data, done) {
  if (LB.working || !LB.host) return null;
  LB.working = true;
  LB.err = null;
  LB.host.redraw();
  try {
    const r = await LB.host.cmd(action, data);
    lbForget();
    done?.(r);
    if (r?.message) LB.host.notify(r.message);
    await LB.host.refresh();
    return r;
  } catch (e) {
    // the refusal shows under the form and as a toast; the focus leaves the form so the card is drawn again at once (a page waits
    // for the next poll while someone is typing in a form)
    LB.err = e.message;
    LB.host.notify(e.message);
    if (typeof document !== 'undefined') document.activeElement?.blur?.();
    return null;
  } finally {
    LB.working = false;
    LB.host.redraw();
  }
}
const openForm = (kind, id = '', form = {}) => {
  LB.open = isOpen(kind, id) ? null : { kind, id };
  LB.form = LB.open ? { ...form } : {};
  LB.err = null;
  LB.host.redraw();
  if (LB.open && typeof requestAnimationFrame !== 'undefined')
    requestAnimationFrame(() =>
      document.querySelector('[data-lb-form="' + kind + '"] input,[data-lb-form="' + kind + '"] select')?.focus?.({
        preventScroll: true,
      }),
    );
};
async function download(fmt) {
  const month = LB.month || (LB.host.today() ?? '').slice(0, 7);
  LB.file = null;
  try {
    // what the file carries, said in words after the save (from the summary, not the download's headers)
    let summary = null;
    try {
      summary = await LB.host.get('accounting-summary?format=' + fmt + '&month=' + encodeURIComponent(month));
    } catch (e) {
      LB.file = { err: e?.message ?? 'The file could not be made.' };
      LB.host.redraw();
      return;
    }
    const res = await fetch('/api/accounting.csv?format=' + fmt + '&month=' + encodeURIComponent(month));
    if (!res.ok) {
      let words = 'The file could not be made.';
      try {
        words = (await res.json()).error ?? words;
      } catch {}
      LB.file = { err: words };
    } else {
      const body = await res.text(),
        name =
          /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
          'scaffold-' + fmt + '-' + month + (fmt === 'myob' ? '.txt' : '.csv');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([body], { type: res.headers.get('content-type') ?? 'text/csv' }));
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      LB.file = {
        name,
        statements: summary?.statements ?? (res.headers.get('x-statements') ?? '').split(',').filter(Boolean),
        total: summary?.total ?? Number(res.headers.get('x-total') ?? 0),
        words: summary?.words ?? decodeURIComponent(res.headers.get('x-words') ?? ''),
      };
      LB.stAt = 0;
    }
  } catch (e) {
    LB.file = { err: e?.message ?? 'The file could not be made.' };
  }
  LB.host.redraw();
}
async function goLiveCheck() {
  const g = LB.golive,
    { rows } = lbParseSheet(g.text);
  g.err = null;
  g.result = null;
  g.check = null;
  if (!rows.length) {
    g.err = 'Paste the rows first, header row included.';
    LB.host.redraw();
    return;
  }
  g.rows = rows;
  g.busy = true;
  LB.host.redraw();
  try {
    g.check = await LB.host.post('golive-preview', { kind: g.kind, rows });
  } catch (e) {
    g.err = e.message;
  } finally {
    g.busy = false;
    LB.host.redraw();
  }
}
async function goLiveImport() {
  const g = LB.golive;
  if (!g.check?.ok || !g.rows) return;
  g.busy = true;
  g.err = null;
  LB.host.redraw();
  try {
    const r = await LB.host.cmd('goLiveImport', { kind: g.kind, rows: g.rows });
    g.result = r;
    g.check = null;
    g.text = '';
    g.rows = null;
    lbForget();
    if (r?.message) LB.host.notify(r.message);
    await LB.host.refresh();
  } catch (e) {
    g.err = e.message;
    if (e.detail?.check) g.check = e.detail.check;
  } finally {
    g.busy = false;
    LB.host.redraw();
  }
}
async function parallelRun() {
  const p = LB.prun;
  p.err = null;
  p.busy = true;
  LB.host.redraw();
  try {
    const invoiced = Object.entries(p.typed)
      .map(([customer, v]) => ({ customer, amount: lbCents(v) }))
      .filter((x) => x.amount != null && !Number.isNaN(x.amount) && x.amount >= 0);
    p.result = await LB.host.post('parallel-run', { from: p.from, to: p.to, invoiced });
  } catch (e) {
    p.err = e.message;
  } finally {
    p.busy = false;
    LB.host.redraw();
  }
}
function onClick(e) {
  const b = /** @type {HTMLElement} */ (e.target)?.closest?.('[data-lb-act]');
  if (!b || !LB.host) return;
  const d = b.dataset,
    id = d.lbId ?? '';
  switch (d.lbAct) {
    case 'close':
      LB.open = null;
      LB.err = null;
      LB.host.redraw();
      return;
    case 'customerNew':
      return openForm('customer', '');
    case 'customerEdit':
      return openForm('customer', id);
    case 'customerRemove':
      return openForm('customerRemove', id);
    case 'customerRestore':
      run('customerRestore', { id });
      return;
    case 'link':
      run('customerLinkSites', {});
      return;
    case 'offHire':
      return openForm('offHire', id, { when: LB.host.today() ?? '', pickupDay: LB.host.today() ?? '' });
    case 'openingLot':
      return openForm('openingLot', id);
    case 'issue':
      LB.issued = null;
      run(
        'statementIssue',
        { customer: LB.cust, ...(LB.to ? { to: LB.to } : {}), ...(LB.noAdj ? { withAdjustments: false } : {}) },
        (r) => {
          LB.issued = r.statement;
          LB.noAdj = false;
          LB.previewKey = '';
        },
      );
      return;
    case 'reverse':
      return openForm('reverse', id);
    case 'adjust':
      return openForm('adjust', id);
    case 'driftAdjust':
      lbAdjust(id, Number(d.lbCents ?? 0), d.lbWords ?? '');
      LB.host.redraw();
      return;
    case 'to':
      LB.to = d.lbDay ?? '';
      LB.issued = null;
      LB.previewKey = '';
      LB.host.redraw();
      return;
    case 'noAdj':
      LB.noAdj = true;
      LB.previewKey = '';
      LB.host.redraw();
      return;
    case 'withAdj':
      LB.noAdj = false;
      LB.previewKey = '';
      LB.host.redraw();
      return;
    case 'file':
      download(d.lbFmt ?? 'generic');
      return;
    case 'goSettings':
      document.getElementById('lb-settings')?.scrollIntoView({ block: 'start' });
      document.querySelector('#lb-settings input')?.focus({ preventScroll: true });
      return;
    case 'kind':
      LB.golive.kind = d.lbKind ?? 'customers';
      LB.golive.check = null;
      LB.golive.result = null;
      LB.golive.err = null;
      LB.host.redraw();
      return;
    case 'glCheck':
      goLiveCheck();
      return;
    case 'glImport':
      goLiveImport();
      return;
    case 'parts':
      LB.host.parts?.();
      return;
  }
}
function onInput(e) {
  const t = /** @type {HTMLInputElement} */ (e.target);
  if (!t?.closest || !LB.host) return;
  if (t.hasAttribute('data-lb-cust')) {
    if (e.type !== 'change') return;
    LB.cust = t.value;
    LB.issued = null;
    LB.previewKey = '';
    LB.host.redraw();
    return;
  }
  if (t.hasAttribute('data-lb-to')) {
    if (e.type !== 'change' || (t.value && !DAY.test(t.value))) return;
    LB.to = t.value;
    LB.issued = null;
    LB.previewKey = '';
    LB.host.redraw();
    return;
  }
  if (t.hasAttribute('data-lb-month')) {
    LB.month = t.value;
    return;
  }
  if (t.hasAttribute('data-lb-text')) {
    LB.golive.text = t.value;
    return;
  }
  if (t.hasAttribute('data-lb-typed')) {
    LB.prun.typed[t.dataset.lbTyped] = t.value;
    // the difference as the figure is typed (the app's figure is on the row already)
    const cell = t.closest('tr')?.querySelector('[data-lb-diff]');
    if (cell) {
      const inv = lbCents(t.value),
        app = Number(cell.dataset.lbApp ?? 0),
        ok = inv != null && !Number.isNaN(inv) && inv >= 0,
        diff = ok ? app - inv : null;
      cell.classList.toggle('is-over', !!diff && diff > 0);
      cell.classList.toggle('is-under', !!diff && diff < 0);
      cell.innerHTML =
        '<b>' +
        (diff == null ? '–' : lbMoney(diff)) +
        '</b>' +
        (ok && inv ? '<small>' + (diff > 0 ? '+' : '') + Math.round((diff / inv) * 1000) / 10 + '%</small>' : '');
    }
    return;
  }
  const f = t.closest('[data-lb-form]');
  if (!f) return;
  if (f.dataset.lbForm === 'prun') LB.prun[t.name] = t.value;
  else if (t.name) LB.form[t.name] = t.type === 'checkbox' ? t.checked : t.value;
}
function onSubmit(e) {
  const f = /** @type {HTMLFormElement} */ (e.target);
  if (!f?.dataset || f.dataset.lbForm === undefined || !LB.host) return;
  e.preventDefault();
  const fd = new FormData(f),
    v = (k) => String(fd.get(k) ?? '').trim(),
    id = f.dataset.lbId ?? '',
    kind = f.dataset.lbForm;
  const close = () => {
    LB.open = null;
    LB.form = {};
  };
  if (kind === 'customer') {
    const terms = v('termsDays');
    run(
      'customerSave',
      {
        ...(id ? { id } : {}),
        name: v('name'),
        abn: v('abn'),
        billingEmail: v('billingEmail') || null,
        address: v('address') || null,
        termsDays: terms === '' ? null : Number(terms),
        defaultPO: v('defaultPO') || null,
      },
      close,
    );
  } else if (kind === 'customerRemove') run('customerRemove', { id, reason: v('reason') }, close);
  else if (kind === 'reverse') run('statementReverse', { statement: id, reason: v('reason') }, close);
  else if (kind === 'adjust') {
    const cents = lbCents(v('amount'));
    if (cents == null || Number.isNaN(cents)) {
      LB.err = 'Amount: dollars and cents, like 120.00 or -40.50.';
      LB.host.redraw();
      return;
    }
    run(
      'adjustmentAdd',
      {
        customer: f.dataset.lbCustId,
        statement: id,
        amount: cents,
        description: v('description'),
        reason: v('reason'),
        ...(fd.get('hire') ? { hire: true } : {}),
      },
      () => {
        close();
        LB.previewKey = '';
      },
    );
  } else if (kind === 'offHire')
    run(
      'offHireRequested',
      { site: id, when: v('when'), whoCalled: v('whoCalled'), note: v('note') || null, pickupDay: v('pickupDay') },
      close,
    );
  else if (kind === 'openingLot')
    run(
      'openingLot',
      {
        site: id,
        product: v('product'),
        quantity: Number(v('quantity')),
        onHireSince: v('onHireSince'),
        ...(v('customer') ? { customer: v('customer') } : {}),
        ...(fd.get('beforeBilled') ? { beforeBilled: true } : {}),
      },
      close,
    );
  else if (kind === 'settings') {
    LB.open = { kind: 'settings', id: '' };
    run(
      'hireSettings',
      {
        stopRule: v('stopRule') || undefined,
        collectWithinDays: v('collectWithinDays') === '' ? undefined : Number(v('collectWithinDays')),
        xeroAccountCode: v('xeroAccountCode') || null,
        xeroTaxType: v('xeroTaxType') || null,
        myobAccountNumber: v('myobAccountNumber') || null,
        myobTaxCode: v('myobTaxCode') || null,
        retentionYears: v('retentionYears') === '' ? undefined : Number(v('retentionYears')),
      },
      () => {
        LB.open = null;
        LB.form = {};
      },
    );
  } else if (kind === 'prun') {
    LB.prun.from = v('from');
    LB.prun.to = v('to');
    parallelRun();
  }
}
export const __lb = {
  state: LB,
  reset() {
    Object.assign(LB, {
      customers: null,
      custAt: 0,
      settings: null,
      setAt: 0,
      statements: null,
      stAt: 0,
      offHires: null,
      offAt: 0,
      preview: null,
      previewKey: '',
      cust: '',
      to: '',
      noAdj: false,
      month: '',
      open: null,
      form: {},
      err: null,
      working: false,
      file: null,
      issued: null,
      golive: { kind: 'customers', text: '', rows: null, check: null, result: null, err: null, busy: false },
      prun: { from: '', to: '', typed: {}, result: null, err: null, busy: false },
    });
  },
  set(k, v) {
    LB[k] = v;
  },
  open(kind, id = '', form = {}) {
    LB.open = kind ? { kind, id } : null;
    LB.form = form;
  },
  golive(g) {
    Object.assign(LB.golive, g);
  },
  prun(p) {
    Object.assign(LB.prun, p);
  },
};
