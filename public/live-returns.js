// Back & counted, with a resolution for every shortfall (ADR 0010, audit #4 and H3): Count later on a return, the count itself, the
// four outcomes for what did not come back (still on site, lost, damaged, our loss), the yard's quarantine (repair, scrap, charge), the
// one site-finish question ("sent N · back M · K missing: charge, write off or still looking?"), the owner's replacement values on the
// Materials catalogue and the intake fields on Add stock. Loaded only in a real yard (live-office.js imports it, ADR 0007). The HTML
// functions are pure; lrSetup wires one set of listeners on the document. Money is shown in dollars and sent in cents.
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
export const lrMoney = (cents) =>
  '$' +
  (Math.round(Number(cents) || 0) / 100).toLocaleString('en-AU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
/** Dollars typed → cents, or null when blank. @param {any} v */
export const lrCents = (v) => {
  const s = String(v ?? '')
    .trim()
    .replace(/[$,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
};
export const LR_OUTCOMES = [
  ['STILL_ON_SITE', 'Still on site', 'hire keeps running'],
  ['LOST', 'Lost', 'charged at the replacement value'],
  ['DAMAGED', 'Damaged', 'goes to quarantine'],
  ['OUR_LOSS', 'Our loss', 'written off · the owner only'],
];
export const LR_Q_OUTCOMES = [
  ['REPAIRED', 'Repaired', 'back in stock'],
  ['SCRAPPED', 'Scrapped', 'gone, nobody charged'],
  ['CHARGED', 'Scrapped and charged', 'the site pays the replacement value'],
];
/** @type {any} */
const LR = {
  host: null,
  bound: false,
  open: null,
  draft: {},
  lines: [],
  err: null,
  working: false,
  accounts: new Map(),
  busy: new Set(),
  finish: null,
  q: null,
  values: { draft: {}, paste: '', err: null, saved: 0 },
};
/** @param {{get:(p:string)=>Promise<any>,cmd:(a:string,d:any)=>Promise<any>,notify:(t:string)=>void,redraw:()=>void,refresh:()=>Promise<any>,state:()=>any,owner:()=>boolean,products:()=>Map<string,any>}} host */
export function lrSetup(host) {
  LR.host = host;
  if (typeof document === 'undefined' || LR.bound) return;
  LR.bound = true;
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onInput);
  document.addEventListener('submit', onSubmit);
}
export const lrForget = () => {
  for (const v of LR.accounts.values()) v.at = 0;
};
const products = () => LR.host?.products?.() ?? new Map();
const owner = () => !!LR.host?.owner?.();
const valueOf = (product) => products().get(product)?.replacementValue ?? null;
// ---------------------------------------------------------------- a return: count later, count now, and what happened to the rest
/** The office's "Count later" beside Back at yard (the pieces stay on the truck's record until counted). @param {any} t */
export function lrCountLaterHTML(t) {
  if (t.direction !== 'BACK' && t.state !== 'LOADED') return '';
  return (
    '<button type="button" class="lo-link" data-lr-later="' +
    esc(t.id) +
    '"' +
    (LR.working ? ' disabled' : '') +
    '>Back, count later</button>'
  );
}
/** What a returned trip still needs: a count, or an outcome for each missing piece; and what was already sorted. @param {any} t @param {{ops?:boolean}} [opts] */
export function lrTripExtraHTML(t, { ops = true } = {}) {
  if (t.state !== 'RETURNED') return '';
  let h = '';
  const sorted = (t.resolutions ?? []).length
    ? '<p class="lr-sorted">' +
      esc(
        'Sorted: ' +
          t.resolutions
            .map(
              (r) =>
                r.quantity +
                ' × ' +
                (products().get(r.product)?.name ?? 'part') +
                ' ' +
                (LR_OUTCOMES.find((o) => o[0] === r.outcome)?.[1] ?? r.outcome).toLowerCase() +
                (r.charge ? ' · charged ' + lrMoney((r.unitValue ?? 0) * r.quantity) : ''),
            )
            .join(' · '),
      ) +
      '</p>'
    : '';
  const missing = (t.notBack ?? []).reduce((n, l) => n + l.quantity, 0);
  if (t.countPending) {
    h +=
      '<p class="lo-warn">Back at the yard, not counted yet.</p>' +
      (ops && LR.open?.trip !== t.id
        ? '<div class="lo-acts"><button type="button" class="lo-btn" data-lr-count="' +
          esc(t.id) +
          '">Count it now</button></div>'
        : '');
    if (LR.open?.trip === t.id && LR.open.kind === 'count') h += countForm(t);
    return h + sorted;
  }
  if (missing) {
    h +=
      '<p class="lo-warn">' +
      esc(plural(missing, 'piece') + ' not back. Say what happened to ' + (missing === 1 ? 'it' : 'them') + '.') +
      '</p>' +
      (ops && LR.open?.trip !== t.id
        ? '<div class="lo-acts"><button type="button" class="lo-btn" data-lr-resolve="' +
          esc(t.id) +
          '">Sort it out</button></div>'
        : '');
    if (LR.open?.trip === t.id && LR.open.kind === 'resolve') h += resolveForm(t);
  }
  return h + sorted;
}
function countForm(t) {
  const lines = (t.lines ?? [])
    .filter((l) => (l.onTruck ?? 0) > 0)
    .map((l) => {
      const q = LR.draft[l.product] ?? l.onTruck;
      return (
        '<label class="lo-line' +
        (q !== l.onTruck ? ' changed' : '') +
        '"><span>' +
        esc(l.name) +
        ' <small>' +
        l.onTruck +
        ' collected</small></span><input type="number" min="0" max="' +
        l.onTruck +
        '" step="1" inputmode="numeric" data-lr-q="' +
        esc(l.product) +
        '" value="' +
        q +
        '" aria-label="' +
        esc('Counted back: ' + l.name) +
        '"></label>'
      );
    })
    .join('');
  return (
    '<form class="lo-form" data-lr-count-form="' +
    esc(t.id) +
    '"><p class="lo-form-title">Counted back at the yard</p><div class="lo-lines">' +
    lines +
    '</div>' +
    (LR.err ? '<p class="lo-err" role="alert">' + esc(LR.err) + '</p>' : '') +
    '<div class="lo-form-acts"><button type="submit" class="lo-go"' +
    (LR.working ? ' disabled' : '') +
    '>Save the count</button><button type="button" class="lo-link" data-lr-x>Never mind</button></div><p class="lo-note">Anything short stays on the trip until someone says what happened to it.</p></form>'
  );
}
const outcomeOpts = (sel) =>
  LR_OUTCOMES.map(
    ([k, w, sub]) =>
      '<option value="' +
      k +
      '"' +
      (sel === k ? ' selected' : '') +
      (k === 'OUR_LOSS' && !owner() ? ' disabled' : '') +
      '>' +
      esc(w + ' · ' + sub) +
      '</option>',
  ).join('');
function resolveForm(t) {
  const names = new Map((t.lines ?? []).map((l) => [l.product, l.name]));
  const rows = LR.lines
    .map((l, i) => {
      const v = valueOf(l.product),
        needValue = l.outcome === 'LOST' && v === null;
      return (
        '<div class="lr-line" data-lr-i="' +
        i +
        '"><div class="lr-line-top"><b>' +
        esc(names.get(l.product) ?? 'Part') +
        '</b><small>' +
        esc(l.missing + ' missing') +
        '</small></div><div class="lo-fields"><label class="lo-field"><span>How many</span><input type="number" min="1" max="' +
        l.missing +
        '" step="1" inputmode="numeric" data-lr-f="quantity" value="' +
        l.quantity +
        '"></label><label class="lo-field lr-wide"><span>What happened</span><select data-lr-f="outcome">' +
        outcomeOpts(l.outcome) +
        '</select></label>' +
        (l.outcome === 'LOST'
          ? needValue
            ? '<label class="lo-field"><span>Value each ($)</span><input inputmode="decimal" data-lr-f="unitValue" value="' +
              esc(l.unitValue ?? '') +
              '" placeholder="No replacement value set" required></label>'
            : '<p class="lr-value">Charged at ' + lrMoney(v) + ' each</p>'
          : '') +
        '<label class="lo-field lr-wide"><span>Why (optional)</span><input maxlength="200" data-lr-f="reason" value="' +
        esc(l.reason ?? '') +
        '" placeholder="e.g. Fell off the truck"></label></div>' +
        (l.missing > l.quantity
          ? '<button type="button" class="lo-link" data-lr-split="' + i + '">Not all the same? Split it</button>'
          : '') +
        '</div>'
      );
    })
    .join('');
  return (
    '<form class="lo-form lr-resolve" data-lr-resolve-form="' +
    esc(t.id) +
    '"><p class="lo-form-title">What happened to the pieces not back?</p>' +
    rows +
    (LR.err ? '<p class="lo-err" role="alert">' + esc(LR.err) + '</p>' : '') +
    '<div class="lo-form-acts"><button type="submit" class="lo-go"' +
    (LR.working ? ' disabled' : '') +
    '>Save what happened</button><button type="button" class="lo-link" data-lr-x>Never mind</button></div><p class="lo-note">Still on site keeps the hire running. Lost is charged at the replacement value. Damaged goes to quarantine and is never sent out. Our loss is written off and needs the owner.</p></form>'
  );
}
// ---------------------------------------------------------------- the yard's quarantine (Stock)
/** Quarantined pieces by product, from the snapshot. @param {any} s */
export function lrQuarantineLines(s) {
  const boxes = (s?.containers ?? []).filter((c) => c.quarantine && !c.retired),
    ids = new Set(boxes.map((c) => c.id));
  const by = new Map();
  for (const l of s?.balances ?? [])
    if (ids.has(l.container) && l.quantity > 0) by.set(l.product_id, (by.get(l.product_id) ?? 0) + l.quantity);
  const lots = boxes.flatMap((c) => c.lots ?? []);
  const sites = new Map((s?.sites ?? []).map((x) => [x.id, x.name]));
  return [...by].map(([product, quantity]) => ({
    product,
    quantity,
    from: [...new Set(lots.filter((x) => x.product === product).map((x) => x.site))]
      .filter(Boolean)
      .map((id) => ({ id, name: sites.get(id) ?? 'a site' })),
  }));
}
/** The Quarantine card on the Stock page. @param {any} s @param {{ops?:boolean}} [opts] */
export function lrQuarantineHTML(s, { ops = true } = {}) {
  const lines = lrQuarantineLines(s);
  if (!lines.length) return '';
  const names = products();
  const rows = lines
    .map((l) => {
      const open = LR.q?.product === l.product;
      return (
        '<li class="lr-qrow' +
        (open ? ' is-open' : '') +
        '"><span class="lr-q-t"><b>' +
        esc(names.get(l.product)?.name ?? l.product) +
        '</b><small>' +
        esc(plural(l.quantity, 'piece') + (l.from.length ? ' · from ' + l.from.map((x) => x.name).join(', ') : '')) +
        '</small></span>' +
        (ops && !open
          ? '<button type="button" class="lo-btn soft" data-lr-q="' + esc(l.product) + '">Sort it out</button>'
          : '') +
        (open ? quarantineForm(l) : '') +
        '</li>'
      );
    })
    .join('');
  return (
    '<section class="panel lr-quarantine" id="lr-quarantine" aria-labelledby="lr-q-h"><div class="tdh-card-head"><span class="tdh-badge lr-q-badge" aria-hidden="true"><i></i></span><div class="tdh-card-title"><h2 id="lr-q-h">Quarantine</h2><p>Damaged gear waits here. Nothing is sent out from it.</p></div></div><ul class="lr-qlist">' +
    rows +
    '</ul></section>'
  );
}
function quarantineForm(l) {
  const q = LR.q,
    v = valueOf(l.product),
    needValue = q.outcome === 'CHARGED' && v === null;
  return (
    '<form class="lo-form lr-qform" data-lr-q-form="' +
    esc(l.product) +
    '"><div class="lo-fields"><label class="lo-field"><span>How many</span><input type="number" min="1" max="' +
    l.quantity +
    '" step="1" inputmode="numeric" name="quantity" value="' +
    esc(q.quantity || l.quantity) +
    '"></label><label class="lo-field lr-wide"><span>What happens</span><select name="outcome">' +
    LR_Q_OUTCOMES.map(
      ([k, w, sub]) =>
        '<option value="' + k + '"' + (q.outcome === k ? ' selected' : '') + '>' + esc(w + ' · ' + sub) + '</option>',
    ).join('') +
    '</select></label>' +
    (q.outcome === 'CHARGED' && l.from.length > 1
      ? '<label class="lo-field"><span>Which site</span><select name="site">' +
        l.from
          .map(
            (x) =>
              '<option value="' +
              esc(x.id) +
              '"' +
              (q.site === x.id ? ' selected' : '') +
              '>' +
              esc(x.name) +
              '</option>',
          )
          .join('') +
        '</select></label>'
      : '') +
    (q.outcome === 'CHARGED'
      ? needValue
        ? '<label class="lo-field"><span>Value each ($)</span><input inputmode="decimal" name="unitValue" required value="' +
          esc(q.unitValue ?? '') +
          '" placeholder="No replacement value set"></label>'
        : '<p class="lr-value">Charged at ' + lrMoney(v) + ' each</p>'
      : '') +
    '<label class="lo-field lr-wide"><span>Why (optional)</span><input maxlength="200" name="reason" value="' +
    esc(q.reason ?? '') +
    '"></label></div>' +
    (LR.err ? '<p class="lo-err" role="alert">' + esc(LR.err) + '</p>' : '') +
    '<div class="lo-form-acts"><button type="submit" class="lo-go"' +
    (LR.working ? ' disabled' : '') +
    '>Save</button><button type="button" class="lo-link" data-lr-x>Never mind</button></div></form>'
  );
}
// ---------------------------------------------------------------- the one site-finish question
/** A site's account (GET /api/site-account?site=), fetched when missing or older than 15 s. @param {string} site */
export function lrAccount(site) {
  const have = LR.accounts.get(site);
  if ((!have || Date.now() - have.at > 15000) && LR.host && !LR.busy.has(site)) {
    LR.busy.add(site);
    LR.host
      .get('site-account?site=' + encodeURIComponent(site))
      .then((d) => LR.accounts.set(site, { at: Date.now(), data: d }))
      .catch(() => LR.accounts.set(site, { at: Date.now(), data: have?.data ?? null }))
      .finally(() => {
        LR.busy.delete(site);
        LR.host?.redraw();
      });
  }
  return have?.data ?? null;
}
/** "sent N · back M · K missing: charge, write off or still looking?" @param {any} site @param {any} a the account @param {{ops?:boolean,why?:string|null}} [opts] */
export function lrFinishHTML(site, a, { ops = true, why = null } = {}) {
  if (!a) return '<p class="lo-quiet">Adding up what was sent and what came back…</p>';
  const open = LR.finish?.site === site.id,
    k = a.missing ?? 0;
  let h =
    '<div class="lr-finish" data-lr-finish="' +
    esc(site.id) +
    '"><p class="lr-finish-h">Finish this site</p><p class="lr-account"><b>' +
    esc(a.words) +
    '</b>' +
    (a.charged ? '<small>' + esc(plural(a.charged, 'piece') + ' charged') + '</small>' : '') +
    (a.writtenOff ? '<small>' + esc(plural(a.writtenOff, 'piece') + ' written off') + '</small>' : '') +
    (a.looking ? '<small>Still looking since ' + esc(String(a.looking.since).slice(0, 10)) + '</small>' : '') +
    '</p>' +
    (why ? '<p class="lo-warn">' + esc(why) + '</p>' : '');
  if (a.unresolvedTrips?.some((t) => t.pending))
    h += '<p class="lo-warn">Count the returns from ' + esc(site.name) + ' first (on Today, the trip’s card).</p>';
  else if (ops && !open)
    h +=
      '<div class="lo-acts">' +
      (k
        ? '<button type="button" class="lo-btn" data-lr-finish-go="CHARGE" data-site="' +
          esc(site.id) +
          '">Charge for ' +
          k +
          '</button><button type="button" class="lo-btn soft" data-lr-finish-go="WRITE_OFF" data-site="' +
          esc(site.id) +
          '"' +
          (owner() ? '' : ' disabled title="The owner writes off"') +
          '>Write off</button>' +
          (a.looking
            ? ''
            : '<button type="button" class="lo-btn soft" data-lr-finish-go="STILL_LOOKING" data-site="' +
              esc(site.id) +
              '">Still looking</button>')
        : '<button type="button" class="lo-btn" data-lr-finish-go="CHARGE" data-site="' +
          esc(site.id) +
          '">Finish the site</button>') +
      '</div>';
  if (open) {
    const o = LR.finish.outcome,
      words =
        o === 'CHARGE'
          ? k
            ? plural(k, 'piece') + ' charged at the replacement value, then the site is finished.'
            : 'Nothing missing. The site is finished.'
          : o === 'WRITE_OFF'
            ? plural(k, 'piece') + ' written off as our loss, then the site is finished.'
            : 'The site stays open and on Needs you until the pieces turn up or are charged.';
    h +=
      '<form class="lo-form" data-lr-finish-form="' +
      esc(site.id) +
      '"><p class="lo-form-title">' +
      esc(o === 'CHARGE' ? 'Charge' : o === 'WRITE_OFF' ? 'Write off' : 'Still looking') +
      '</p><p class="lo-note">' +
      esc(words) +
      '</p><label class="lo-field"><span>Why (optional)</span><input maxlength="200" name="reason" value="' +
      esc(LR.finish.reason ?? '') +
      '"></label>' +
      (LR.err ? '<p class="lo-err" role="alert">' + esc(LR.err) + '</p>' : '') +
      '<div class="lo-form-acts"><button type="submit" class="lo-go"' +
      (LR.working ? ' disabled' : '') +
      '>' +
      esc(o === 'CHARGE' ? 'Charge and finish' : o === 'WRITE_OFF' ? 'Write off and finish' : 'Keep looking') +
      '</button><button type="button" class="lo-link" data-lr-x>Never mind</button></div></form>';
  }
  return h + '</div>';
}
// ---------------------------------------------------------------- the owner's replacement values (Materials catalogue)
/** Paste from a spreadsheet: "name or code<tab>dollars" per line → values, matched by name or reference. @param {string} text @param {any[]} list */
export function lrParsePaste(text, list) {
  const byKey = new Map();
  for (const p of list) {
    for (const k of [p.name, p.reference]) if (k) byKey.set(String(k).trim().toLowerCase(), p.id);
  }
  const out = [],
    missed = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\t|,(?=[^,]*$)|;/).map((x) => x.trim());
    if (parts.length < 2) {
      missed.push(line);
      continue;
    }
    const value = lrCents(parts.at(-1)),
      key = parts.slice(0, -1).join(',').toLowerCase();
    const id = byKey.get(key);
    if (!id || value === null || Number.isNaN(value)) missed.push(line);
    else out.push({ product: id, replacementValue: value });
  }
  return { values: out, missed };
}
/** The values panel: the owner only. @param {any[]} list products @param {{owner?:boolean}} [opts] */
export function lrValuesHTML(list, { owner: isOwner = false } = {}) {
  if (!isOwner) return '';
  const rows = list
    .filter((p) => !p.retired)
    .map((p) => {
      const d = LR.values.draft[p.id];
      return (
        '<tr><th scope="row">' +
        esc(p.name) +
        (p.reference ? ' <small>' + esc(p.reference) + '</small>' : '') +
        '</th><td>' +
        (p.replacementValue == null ? '<span class="lr-none">none</span>' : lrMoney(p.replacementValue)) +
        '</td><td><input inputmode="decimal" data-lr-v="' +
        esc(p.id) +
        '" value="' +
        esc(d ?? '') +
        '" placeholder="' +
        esc(p.replacementValue == null ? '0.00' : (p.replacementValue / 100).toFixed(2)) +
        '" aria-label="' +
        esc('Replacement value of ' + p.name + ' in dollars') +
        '"></td></tr>'
      );
    })
    .join('');
  const n = Object.values(LR.values.draft).filter((v) => String(v ?? '').trim() !== '').length;
  return (
    '<section class="panel lr-values" id="lr-values" aria-labelledby="lr-values-h"><div class="tdh-card-head"><span class="tdh-badge lr-v-badge" aria-hidden="true"><i>$</i></span><div class="tdh-card-title"><h2 id="lr-values-h">Replacement values</h2><p>What a lost piece is charged at, ex GST. The owner sets these. Used on Back &amp; counted and when a site finishes.</p></div></div>' +
    '<form data-lr-values-form><div class="lr-values-wrap"><table class="lr-values-table"><thead><tr><th scope="col">Part</th><th scope="col">Now</th><th scope="col">New value ($)</th></tr></thead><tbody>' +
    rows +
    '</tbody></table></div>' +
    '<details class="lr-paste"><summary>Paste from a spreadsheet</summary><p class="lo-note">One part per line: its name or code, then the value. Copied straight from two columns.</p><textarea data-lr-paste rows="4" placeholder="Standard 2.0 m\t42.50">' +
    esc(LR.values.paste) +
    '</textarea><button type="button" class="lo-btn soft" data-lr-paste-go>Fill the values in</button>' +
    (LR.values.pasteWords ? '<p class="lo-quiet">' + esc(LR.values.pasteWords) + '</p>' : '') +
    '</details>' +
    (LR.values.err ? '<p class="lo-err" role="alert">' + esc(LR.values.err) + '</p>' : '') +
    '<div class="lo-form-acts"><button type="submit" class="lo-go"' +
    (n && !LR.working ? '' : ' disabled') +
    '>' +
    esc(n ? 'Save ' + plural(n, 'value') : 'Save values') +
    '</button></div></form></section>'
  );
}
// ---------------------------------------------------------------- Add stock in a real yard: what it cost and where it came from (an intake record)
/** The fields under the board's Add stock. @param {any} f the draft {unitCost, supplier, reference, receivedOn} */
export function lrIntakeFieldsHTML(f = {}, today = '') {
  return (
    '<div class="lr-intake" data-lr-intake><p class="lr-intake-h">Where it came from <small>(optional, kept with the stock record)</small></p><div class="lo-fields"><label class="lo-field"><span>Cost each ($)</span><input inputmode="decimal" name="unitCost" value="' +
    esc(f.unitCost ?? '') +
    '" placeholder="0.00"></label><label class="lo-field"><span>Supplier</span><input name="supplier" maxlength="80" value="' +
    esc(f.supplier ?? '') +
    '"></label><label class="lo-field"><span>Invoice / reference</span><input name="reference" maxlength="60" value="' +
    esc(f.reference ?? '') +
    '"></label><label class="lo-field"><span>Received on</span><input type="date" name="receivedOn" value="' +
    esc(f.receivedOn ?? today ?? '') +
    '"></label></div></div>'
  );
}
/** Reads the intake fields into a gameAddStock input (cents for the cost). @param {HTMLElement|null} box */
export function lrIntakeRead(box) {
  if (!box) return {};
  const get = (n) =>
    /** @type {HTMLInputElement|null} */ (box.querySelector('[name="' + n + '"]'))?.value?.trim() ?? '';
  const out = {};
  const cost = lrCents(get('unitCost'));
  if (cost !== null && !Number.isNaN(cost)) out.unitCost = cost;
  if (get('supplier')) out.supplier = get('supplier');
  if (get('reference')) out.reference = get('reference');
  if (get('receivedOn')) out.receivedOn = get('receivedOn');
  return out;
}
// ---------------------------------------------------------------- events
const tripById = (id) => LR.host?.trip?.(id) ?? null;
async function run(action, data, done) {
  if (LR.working) return null;
  LR.working = true;
  LR.err = null;
  LR.host.redraw();
  try {
    const r = await LR.host.cmd(action, data);
    lrForget();
    LR.host.forget?.();
    done?.(r);
    if (r?.message) LR.host.notify(r.message);
    await LR.host.refresh();
    return r;
  } catch (e) {
    LR.err = e.message;
    if (!LR.open && !LR.finish && !LR.q) LR.host.notify(e.message);
    return null;
  } finally {
    LR.working = false;
    LR.host.redraw();
  }
}
function onClick(e) {
  const b = /** @type {HTMLElement} */ (e.target)?.closest?.('button');
  if (!b || !LR.host) return;
  const d = b.dataset;
  if (d.lrLater !== undefined) {
    run('tripReturned', { trip: d.lrLater, countLater: true }, () => LR.host.closeTrip?.());
    return;
  }
  if (d.lrCount !== undefined) {
    LR.open = { trip: d.lrCount, kind: 'count' };
    LR.draft = {};
    LR.err = null;
    LR.host.closeTrip?.();
    LR.host.redraw();
    return;
  }
  if (d.lrResolve !== undefined) {
    const t = tripById(d.lrResolve);
    LR.open = { trip: d.lrResolve, kind: 'resolve' };
    LR.lines = (t?.notBack ?? []).map((l) => ({
      product: l.product,
      missing: l.quantity,
      quantity: l.quantity,
      outcome: 'STILL_ON_SITE',
      reason: '',
      unitValue: '',
    }));
    LR.err = null;
    LR.host.closeTrip?.();
    LR.host.redraw();
    return;
  }
  if (d.lrSplit !== undefined) {
    const l = LR.lines[Number(d.lrSplit)];
    if (!l || l.quantity >= l.missing) return;
    const rest = l.missing - l.quantity;
    LR.lines.splice(Number(d.lrSplit) + 1, 0, {
      ...l,
      missing: rest,
      quantity: rest,
      outcome: 'LOST',
      reason: '',
      unitValue: '',
    });
    l.missing = l.quantity;
    LR.host.redraw();
    return;
  }
  if (b.hasAttribute('data-lr-x')) {
    LR.open = null;
    LR.finish = null;
    LR.q = null;
    LR.err = null;
    LR.host.redraw();
    return;
  }
  if (d.lrQ !== undefined) {
    LR.q = { product: d.lrQ, outcome: 'REPAIRED', quantity: '', site: '', reason: '', unitValue: '' };
    LR.err = null;
    LR.host.redraw();
    return;
  }
  if (d.lrFinishGo !== undefined) {
    LR.finish = { site: d.site, outcome: d.lrFinishGo, reason: '' };
    LR.err = null;
    LR.host.redraw();
    requestAnimationFrame(() => document.querySelector('[data-lr-finish-form] input')?.focus({ preventScroll: true }));
    return;
  }
  if (b.hasAttribute('data-lr-paste-go')) {
    const list = [...products().values()],
      r = lrParsePaste(LR.values.paste, list);
    for (const v of r.values) LR.values.draft[v.product] = (v.replacementValue / 100).toFixed(2);
    LR.values.pasteWords =
      plural(r.values.length, 'value') +
      ' filled in' +
      (r.missed.length
        ? ' · not matched: ' + r.missed.slice(0, 5).join(' / ') + (r.missed.length > 5 ? ' …' : '')
        : '') +
      '. Check them, then Save.';
    LR.host.redraw();
  }
}
function onInput(e) {
  const t = /** @type {HTMLInputElement} */ (e.target);
  if (!t?.dataset) return;
  if (t.dataset.lrQ !== undefined) LR.draft[t.dataset.lrQ] = Math.max(0, Math.floor(Number(t.value) || 0));
  else if (t.dataset.lrF !== undefined) {
    const i = Number(t.closest('[data-lr-i]')?.getAttribute('data-lr-i')),
      l = LR.lines[i];
    if (!l) return;
    if (t.dataset.lrF === 'quantity') l.quantity = Math.max(1, Math.min(l.missing, Math.floor(Number(t.value) || 1)));
    else l[t.dataset.lrF] = t.value;
    if (['outcome', 'quantity'].includes(t.dataset.lrF) && e.type === 'change') LR.host.redraw();
  } else if (t.dataset.lrV !== undefined) LR.values.draft[t.dataset.lrV] = t.value;
  else if (t.hasAttribute('data-lr-paste')) LR.values.paste = t.value;
  else if (t.closest('[data-lr-q-form]') && LR.q) {
    LR.q[t.name] = t.value;
    if (t.name === 'outcome' && e.type === 'change') LR.host.redraw();
  } else if (t.closest('[data-lr-finish-form]') && LR.finish) LR.finish[t.name] = t.value;
}
function onSubmit(e) {
  const f = /** @type {HTMLFormElement} */ (e.target);
  if (!f?.dataset || !LR.host) return;
  if (f.dataset.lrCountForm !== undefined) {
    e.preventDefault();
    const t = tripById(f.dataset.lrCountForm);
    if (!t) return;
    const lines = (t.lines ?? [])
      .filter((l) => (l.onTruck ?? 0) > 0)
      .map((l) => ({ product: l.product, quantity: LR.draft[l.product] ?? l.onTruck }));
    run('returnCount', { trip: t.id, lines }, () => {
      LR.open = null;
    });
    return;
  }
  if (f.dataset.lrResolveForm !== undefined) {
    e.preventDefault();
    const lines = [];
    for (const l of LR.lines) {
      const line = { product: l.product, quantity: l.quantity, outcome: l.outcome };
      if (l.reason?.trim()) line.reason = l.reason.trim();
      if (l.outcome === 'LOST' && valueOf(l.product) === null) {
        const c = lrCents(l.unitValue);
        if (c === null || Number.isNaN(c)) {
          LR.err =
            'Type the value of each lost piece in dollars, or set a replacement value in the Materials catalogue.';
          LR.host.redraw();
          return;
        }
        line.unitValue = c;
      }
      lines.push(line);
    }
    run('returnResolve', { trip: f.dataset.lrResolveForm, lines }, () => {
      LR.open = null;
    });
    return;
  }
  if (f.dataset.lrQForm !== undefined) {
    e.preventDefault();
    const fd = new FormData(f),
      input = {
        product: f.dataset.lrQForm,
        quantity: Number(fd.get('quantity')),
        outcome: String(fd.get('outcome')),
      };
    if (fd.get('site')) input.site = String(fd.get('site'));
    if (String(fd.get('reason') ?? '').trim()) input.reason = String(fd.get('reason')).trim();
    if (fd.has('unitValue')) {
      const c = lrCents(fd.get('unitValue'));
      if (c === null || Number.isNaN(c)) {
        LR.err = 'Type the value of each piece in dollars.';
        LR.host.redraw();
        return;
      }
      input.unitValue = c;
    }
    run('quarantineResolve', input, () => {
      LR.q = null;
    });
    return;
  }
  if (f.dataset.lrFinishForm !== undefined) {
    e.preventDefault();
    const fd = new FormData(f),
      input = { site: f.dataset.lrFinishForm, outcome: LR.finish?.outcome };
    if (String(fd.get('reason') ?? '').trim()) input.reason = String(fd.get('reason')).trim();
    run('siteFinish', input, (r) => {
      LR.finish = null;
      LR.host.finished?.(r);
    });
    return;
  }
  if (f.hasAttribute('data-lr-values-form')) {
    e.preventDefault();
    const values = [];
    for (const [product, v] of Object.entries(LR.values.draft)) {
      if (String(v ?? '').trim() === '') continue;
      const c = lrCents(v);
      if (Number.isNaN(c)) {
        LR.values.err = 'A value is dollars and cents, like 42.50.';
        LR.host.redraw();
        return;
      }
      values.push({ product, replacementValue: c });
    }
    if (!values.length) return;
    LR.values.err = null;
    run('productValue', { values }, () => {
      LR.values.draft = {};
      LR.values.pasteWords = '';
    }).then((r) => {
      if (!r) LR.values.err = LR.err;
    });
  }
}
export const __lr = {
  state: LR,
  reset() {
    Object.assign(LR, {
      open: null,
      draft: {},
      lines: [],
      err: null,
      accounts: new Map(),
      finish: null,
      q: null,
      values: { draft: {}, paste: '', err: null, saved: 0 },
    });
  },
  open(trip, kind, lines) {
    LR.open = { trip, kind };
    if (lines) LR.lines = lines;
  },
  finish(site, outcome) {
    LR.finish = site ? { site, outcome, reason: '' } : null;
  },
  q(product, outcome = 'REPAIRED') {
    LR.q = product ? { product, outcome, quantity: '', site: '', reason: '', unitValue: '' } : null;
  },
  setAccount(site, data) {
    LR.accounts.set(site, { at: Date.now(), data });
  },
  values(draft) {
    LR.values.draft = draft;
  },
};
