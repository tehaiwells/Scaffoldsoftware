// A real yard's Today as a dispatch tool (ADR 0010, audit #33, §7.3, H5/#17): the "Needs you" card (at most five things, one action each,
// dismissed with a reason), the day's tools (Day / Dispatch lanes, Move the day, Copy yesterday's crews, Print run sheets), the Dispatch
// lanes view (one lane per truck, one state dot per trip, unconfirmed first, orders waiting with a suggested truck, the day's people) and
// the printed run sheet. Loaded only in a real yard (operations.js imports it beside live-office.js, ADR 0007). The HTML functions are
// pure (the tests render them in Node from the server's own views); ltSetup wires one set of listeners on the document.
// Nothing here changes a record by itself: every button sends one command the office chose.
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
/** @type {any} */
const LT = {
  host: null,
  bound: false,
  needs: null,
  needsAt: 0,
  needsBusy: false,
  days: new Map(),
  busy: new Set(),
  mode: 'day',
  tool: null,
  form: {},
  dismiss: null,
  working: false,
  err: null,
  sheet: null,
};
export const LT_KIND_WORDS = {
  UNCONFIRMED_TRIP: 'Trip not confirmed',
  RETURN_SHORT: 'Back short',
  NO_DRIVER_YES: 'No yes from the driver',
  CLASH: 'Booked twice',
  NOT_CONFIRMED: 'Not confirmed',
  NOT_ASKED: 'Not asked in time',
  NO_ANSWER: 'No answer',
  CANT_MAKE_IT: 'Can’t make it',
  PAPERWORK: 'Paperwork',
  UNPRICED_ON_HIRE: 'No rate',
  OFF_HIRE_OVERDUE: 'Pickup overdue',
  UNBILLED: 'Unbilled',
  BILLED_CHANGED: 'Billed differently',
  // part 5 (ADR 0012): a task nobody confirmed, a rostered person who said no, and their task that needs someone else
  TASK_NOT_DONE: 'Task not done',
  TASK_CANT_WORK: 'Needs someone',
  ROSTER_DENIED: 'Can’t work',
};
const DOT_TONE = {
  DRAFT: 'draft',
  BOOKED: 'booked',
  ASKED: 'asked',
  YES: 'yes',
  ARRIVED: 'arrived', // at the pickup (ADR 0012)
  PACKED: 'packed',
  LOADED: 'road',
  AT_SITE: 'atsite', // at the drop
  DELIVERED: 'done',
  BACK: 'back',
};
/** @param {{get:(p:string)=>Promise<any>,cmd:(a:string,d:any)=>Promise<any>,notify:(t:string)=>void,redraw:()=>void,refresh:()=>Promise<any>,state:()=>any,go:(v:string)=>void,goItem:(id:string,day:string)=>void,goTrip:(id:string)=>void,selectDay:(d:string)=>void,addForm:(kind:string,day:string)=>void,today:()=>string|null,pickCustomer?:(id:string)=>void}} host */
export function ltSetup(host) {
  LT.host = host;
  if (typeof document === 'undefined' || LT.bound) return;
  LT.bound = true;
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onInput);
  document.addEventListener('submit', onSubmit);
}
export const ltMode = () => LT.mode;
export const ltForget = () => {
  LT.needsAt = 0;
  for (const v of LT.days.values()) v.at = 0;
};
// ---------------------------------------------------------------- data
/** The Needs-you list (GET /api/needs-you), fetched when missing or older than 15 s. */
export function ltNeeds() {
  if ((!LT.needs || Date.now() - LT.needsAt > 15000) && LT.host && !LT.needsBusy) {
    LT.needsBusy = true;
    LT.host
      .get('needs-you')
      .then((d) => {
        LT.needs = d;
      })
      .catch(() => {})
      .finally(() => {
        LT.needsBusy = false;
        LT.needsAt = Date.now();
        LT.host?.redraw();
      });
  }
  return LT.needs;
}
/** One day's lanes (GET /api/dispatch?day=), fetched when missing or older than 10 s. @param {string} day */
export function ltDispatch(day) {
  const key = day || 'today',
    have = LT.days.get(key);
  if ((!have || Date.now() - have.at > 10000) && LT.host && !LT.busy.has(key)) {
    LT.busy.add(key);
    LT.host
      .get('dispatch' + (day ? '?day=' + encodeURIComponent(day) : ''))
      .then((d) => {
        LT.days.set(key, { at: Date.now(), data: d });
        LT.err = null;
      })
      .catch((e) => {
        LT.err = e?.message ?? 'The lanes could not be loaded.';
        LT.days.set(key, { at: Date.now(), data: have?.data ?? null });
      })
      .finally(() => {
        LT.busy.delete(key);
        LT.host?.redraw();
      });
  }
  return have?.data ?? null;
}
// ---------------------------------------------------------------- the Needs-you card (Today) and chip (the board)
/** "Needs you · 3" for the board's top bar; nothing when nothing needs anyone. @param {any} needs */
export function ltChipHTML(needs) {
  const n = needs?.count ?? 0;
  if (!n) return '';
  return (
    '<button type="button" class="gm-needs" data-view="TODAY" data-gm-needs title="' +
    esc(plural(n, 'thing') + ' for you to sort out, on Today') +
    '"><span class="gm-needs-dot" aria-hidden="true"></span>Needs you · ' +
    n +
    '</button>'
  );
}
/** A relative "since" in a few words. @param {string} since @param {string|null} today */
const sinceWords = (since, today) => {
  if (!since) return '';
  const d = String(since).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !today) return '';
  const n = Math.round(
    (Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8)) -
      Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8))) /
      864e5,
  );
  return n <= 0 ? (n === 0 ? 'today' : 'coming') : n === 1 ? 'since yesterday' : 'for ' + n + ' days';
};
/** The top-5 card. @param {any} needs @param {{ops?:boolean,today?:string|null}} [opts] */
export function ltNeedsHTML(needs, { ops = true, today = null } = {}) {
  const art = '<span class="lt-needs-art" aria-hidden="true"><i></i><i></i><i></i></span>';
  const head = (title, sub, cls = '') =>
    '<div class="tdh-card-head"><span class="tdh-badge lt-needs-badge">' +
    art +
    '</span><div class="tdh-card-title"><h2 id="lt-needs-h">' +
    title +
    '</h2>' +
    (sub ? '<p>' + sub + '</p>' : '') +
    '</div></div>';
  if (!needs)
    return (
      '<section class="panel tdh-card lt-needs is-quiet" id="lt-needs" aria-labelledby="lt-needs-h">' +
      head('Needs you', '') +
      '<p class="tdh-quiet">Looking…</p></section>'
    );
  if (!needs.count)
    return (
      '<section class="panel tdh-card lt-needs is-quiet" id="lt-needs" aria-labelledby="lt-needs-h">' +
      head('Nothing needs you', 'Every trip, return and booking is confirmed or answered.') +
      '</section>'
    );
  const rows = (needs.items ?? [])
    .map((x) => {
      const open = LT.dismiss?.id === x.id;
      return (
        '<li class="lt-need kind-' +
        esc(x.kind) +
        (open ? ' is-open' : '') +
        '" data-lt-need="' +
        esc(x.id) +
        '"><i class="lt-need-dot" aria-hidden="true"></i><span class="lt-need-t"><small>' +
        esc(LT_KIND_WORDS[x.kind] ?? x.kind) +
        (sinceWords(x.since, today) ? ' · ' + esc(sinceWords(x.since, today)) : '') +
        '</small><b>' +
        esc(x.words) +
        '</b></span>' +
        (ops
          ? '<span class="lt-need-acts"><button type="button" class="tdh-btn tdh-soft" data-lt-act="' +
            esc(x.id) +
            '">' +
            esc(x.action?.label ?? 'Open') +
            '</button><button type="button" class="tdh-link" data-lt-dismiss="' +
            esc(x.id) +
            '" aria-expanded="' +
            open +
            '">Not now</button></span>'
          : '') +
        (open
          ? '<form class="tdh-mini lt-dismiss" data-lt-dismiss-form="' +
            esc(x.id) +
            '"><div class="tdh-fields"><label class="tdh-field tdh-wide"><span>Why put it aside?</span><input name="reason" maxlength="200" required autocomplete="off" placeholder="e.g. Renewed on paper, filed" value="' +
            esc(LT.dismiss?.reason ?? '') +
            '"></label></div><div class="tdh-form-acts"><button type="submit" class="tdh-go"' +
            (LT.working ? ' disabled' : '') +
            '>Put it aside</button><button type="button" class="tdh-link" data-lt-dismiss-x>Never mind</button></div>' +
            (LT.dismiss?.err ? '<p class="tdh-form-err" role="alert">' + esc(LT.dismiss.err) + '</p>' : '') +
            '<p class="tdh-note">It comes back only when something new happens to it.</p></form>'
          : '') +
        '</li>'
      );
    })
    .join('');
  return (
    '<section class="panel tdh-card lt-needs" id="lt-needs" aria-labelledby="lt-needs-h">' +
    head(
      'Needs you · ' + needs.count,
      needs.count > (needs.cap ?? 5)
        ? 'The first ' + (needs.cap ?? 5) + '. One thing to do for each.'
        : 'One thing to do for each.',
    ) +
    '<ul class="lt-needs-list">' +
    rows +
    '</ul>' +
    (needs.more ? '<p class="tdh-quiet">and ' + plural(needs.more, 'more thing') + ' after these</p>' : '') +
    '</section>'
  );
}
// ---------------------------------------------------------------- the day's tools
const dayShort = (day) =>
  /^\d{4}-\d{2}-\d{2}$/.test(String(day ?? ''))
    ? new Date(day + 'T12:00:00Z').toLocaleDateString('en-AU', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      })
    : '';
const addDays = (day, n) => {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Day / Dispatch lanes, Move the day, Copy yesterday's crews, Print run sheets (the office only). @param {string} day @param {string|null} today @param {{ops?:boolean}} [opts] */
export function ltToolsHTML(day, today, { ops = true } = {}) {
  if (!ops) return '';
  const past = !!today && day < today,
    seg = (m, words) =>
      '<button type="button" class="lt-seg' +
      (LT.mode === m ? ' on' : '') +
      '" data-lt-mode="' +
      m +
      '" aria-pressed="' +
      (LT.mode === m) +
      '">' +
      words +
      '</button>';
  const tool = (k, words) =>
    '<button type="button" class="secondary tdh-btn lt-tool' +
    (LT.tool === k ? ' on' : '') +
    '" data-lt-tool="' +
    k +
    '" aria-expanded="' +
    (LT.tool === k) +
    '">' +
    words +
    '</button>';
  let form = '';
  const err = LT.err && LT.tool ? '<p class="tdh-form-err" role="alert">' + esc(LT.err) + '</p>' : '';
  if (LT.tool === 'move')
    form =
      '<form class="tdh-mini lt-tool-form" data-lt-form="move"><p class="tdh-mini-title">Move everything on ' +
      esc(dayShort(day)) +
      ' to another day</p><div class="tdh-fields"><label class="tdh-field"><span>To</span><input type="date" name="to" required min="' +
      esc(today ?? '') +
      '" value="' +
      esc(LT.form.to ?? addDays(day, 1)) +
      '"></label></div><p class="tdh-note">Trucks, lists and workers go together, or nothing moves. Everyone is asked again for the new day.</p><div class="tdh-form-acts"><button type="submit" class="tdh-go"' +
      (LT.working ? ' disabled' : '') +
      '>Move the day</button><button type="button" class="tdh-link" data-lt-tool-x>Never mind</button></div>' +
      err +
      '</form>';
  if (LT.tool === 'copy')
    form =
      '<form class="tdh-mini lt-tool-form" data-lt-form="copy"><p class="tdh-mini-title">Copy the crews of one day onto ' +
      esc(dayShort(day)) +
      '</p><div class="tdh-fields"><label class="tdh-field"><span>From</span><input type="date" name="from" required value="' +
      esc(LT.form.from ?? addDays(day, -1)) +
      '"></label><label class="tdh-check"><input type="checkbox" name="draft"' +
      (LT.form.draft ? ' checked' : '') +
      '><span><b>As drafts</b><small>Look first, send later</small></span></label></div><p class="tdh-note">The same people, sites, times and numbers. All of them, or none.</p><div class="tdh-form-acts"><button type="submit" class="tdh-go"' +
      (LT.working ? ' disabled' : '') +
      '>Copy the crews</button><button type="button" class="tdh-link" data-lt-tool-x>Never mind</button></div>' +
      err +
      '</form>';
  if (LT.tool === 'print') {
    const d = ltDispatch(day),
      lanes = (d?.lanes ?? []).filter((l) => l.driver && !l.draft);
    form =
      '<form class="tdh-mini lt-tool-form" data-lt-form="print"><p class="tdh-mini-title">Run sheet for ' +
      esc(dayShort(day)) +
      '</p><div class="tdh-fields"><label class="tdh-field"><span>Driver</span><select name="driver"><option value="">Every driver (one page each)</option>' +
      lanes
        .map(
          (l) =>
            '<option value="' +
            esc(l.driver) +
            '"' +
            (LT.form.driver === l.driver ? ' selected' : '') +
            '>' +
            esc(l.driverName + ' · ' + l.truckName) +
            '</option>',
        )
        .join('') +
      '</select></label></div>' +
      (d && !lanes.length ? '<p class="tdh-note">No truck with a driver is booked that day.</p>' : '') +
      '<div class="tdh-form-acts"><button type="submit" class="tdh-go"' +
      (LT.working ? ' disabled' : '') +
      '>Print</button><button type="button" class="tdh-link" data-lt-tool-x>Never mind</button></div>' +
      err +
      '</form>';
  }
  return (
    '<div class="lt-tools" role="group" aria-label="This day"><div class="lt-segs" role="group" aria-label="How to see the day">' +
    seg('day', 'Day') +
    seg('lanes', 'Dispatch lanes') +
    '</div><div class="lt-tool-btns">' +
    (past ? '' : tool('move', 'Move the day')) +
    (past ? '' : tool('copy', 'Copy yesterday’s crews')) +
    tool('print', 'Print run sheets') +
    '</div></div>' +
    form
  );
}
// ---------------------------------------------------------------- the Dispatch lanes view of Today
const pill = (cls, words) => '<span class="tdh-pill ' + cls + '">' + esc(words) + '</span>';
const answerPill = (a) =>
  a === 'YES'
    ? pill('yes', 'Said yes')
    : a === 'WAITING'
      ? pill('wait', 'Asked, waiting')
      : a === 'NO'
        ? pill('no', 'Can’t make it')
        : a === 'NO_ANSWER'
          ? pill('no', 'No answer')
          : a === 'NOT_SENT'
            ? pill('off', 'Not asked yet')
            : a
              ? pill('off', String(a).toLowerCase().replaceAll('_', ' '))
              : '';
const dot = (code, words) =>
  '<i class="lt-dot dot-' + esc(DOT_TONE[code] ?? 'booked') + '" title="' + esc(words ?? code) + '"></i>';
/** One lane. @param {any} l @param {{ops?:boolean,pic?:(t:any)=>string}} opts */
export function ltLaneHTML(l, { ops = true, pic = null } = {}) {
  const trips = (l.trips ?? [])
    .map(
      (t) =>
        '<li class="lt-trip dot-' +
        esc(DOT_TONE[t.dot] ?? 'booked') +
        (t.unconfirmed ? ' is-unconfirmed' : '') +
        '" data-lt-trip="' +
        esc(t.id) +
        '">' +
        dot(t.dot, t.dotWords) +
        '<time>' +
        esc(t.timeWords ?? t.time ?? '') +
        '</time><span class="lt-trip-t"><b>' +
        esc(t.label + (t.direction === 'BACK' ? ' ← ' : ' → ') + t.siteName) +
        '</b><small>' +
        esc(plural(t.pieces ?? 0, 'piece') + ' · ' + (t.dotWords ?? '')) +
        (t.flag?.words ? ' · ' + esc(t.flag.words) : '') +
        '</small></span>' +
        (ops ? '<button type="button" class="tdh-link" data-lt-open-trip="' + esc(t.id) + '">Open</button>' : '') +
        '</li>',
    )
    .join('');
  return (
    '<article class="lt-lane' +
    (l.unconfirmed ? ' is-unconfirmed' : '') +
    (l.draft ? ' is-draft' : '') +
    '" data-lt-lane="' +
    esc(l.booking) +
    '"><div class="lt-lane-head">' +
    (pic ? '<span class="lt-lane-art">' + pic(l) + '</span>' : '') +
    '<span class="lt-lane-t"><b>' +
    esc(l.truckName) +
    '</b><small>' +
    esc((l.driverName ?? 'No driver named') + ' · from ' + (l.timeWords ?? l.time)) +
    '</small></span>' +
    (l.draft ? pill('off', 'Draft') : l.driver ? answerPill(l.answer) : pill('no', 'No driver')) +
    (l.dot ? '<span class="lt-lane-dot">' + dot(l.dot, l.dot) + '</span>' : '') +
    (ops ? '<button type="button" class="tdh-link" data-lt-open-item="' + esc(l.booking) + '">Open</button>' : '') +
    '</div>' +
    (trips ? '<ol class="lt-lane-trips">' + trips + '</ol>' : '<p class="lt-lane-empty">No trip on it yet.</p>') +
    (l.problem ? '<p class="tdh-problem">' + esc(l.problem) + '</p>' : '') +
    '</article>'
  );
}
/** The lanes view. @param {any} d GET /api/dispatch @param {{ops?:boolean,pic?:(t:any)=>string,waiting?:string}} [opts] */
export function ltLanesHTML(d, { ops = true, pic = null, waiting = '' } = {}) {
  if (!d)
    return (
      '<section class="panel lt-lanes" id="lt-lanes" aria-labelledby="lt-lanes-h"><h2 id="lt-lanes-h" class="tdh-sub">Dispatch lanes</h2><p class="tdh-quiet">' +
      (LT.err ? esc(LT.err) : 'Loading the lanes…') +
      '</p></section>'
    );
  const legend =
    '<div class="lt-legend" aria-hidden="true">' +
    (d.dots ?? []).map((x) => '<span>' + dot(x.code, x.words) + esc(x.words) + '</span>').join('') +
    '</div>';
  const lanes = (d.lanes ?? []).map((l) => ltLaneHTML(l, { ops, pic })).join('');
  const unbooked = (d.unbooked ?? []).length
    ? '<p class="lt-unbooked"><span>Not booked: ' +
      esc(d.unbooked.map((t) => t.name).join(', ')) +
      '</span>' +
      (ops && (!d.today || d.day >= d.today)
        ? '<button type="button" class="secondary tdh-btn" data-lt-add="TRUCK">+ Truck</button>'
        : '') +
      '</p>'
    : '';
  const p = d.people ?? {};
  const drivers = (p.drivers ?? []).length
    ? '<div class="lt-people-col"><h3 class="tdh-sub">Drivers</h3><ul class="lt-people">' +
      p.drivers
        .map(
          (x) =>
            '<li><b>' +
            esc(x.name) +
            '</b>' +
            (x.booking
              ? '<small>' + esc(x.truckName ?? '') + '</small>' + answerPill(x.answer)
              : pill('off', 'Not booked')) +
            '</li>',
        )
        .join('') +
      '</ul></div>'
    : '';
  const workers = (p.workers ?? []).length
    ? '<div class="lt-people-col"><h3 class="tdh-sub">Workers</h3><ul class="lt-people">' +
      p.workers
        .map(
          (w) =>
            '<li class="lt-gang"><b>' +
            esc(w.siteName + ' · ' + (w.timeWords ?? w.time)) +
            '</b>' +
            (w.draft
              ? pill('off', 'Draft')
              : pill(
                  w.onSite ? 'yes' : w.yes ? 'wait' : 'off',
                  w.onSite ? w.onSite + ' of ' + w.count + ' on site' : w.yes + ' of ' + w.count + ' said yes',
                )) +
            '<small>' +
            (w.people ?? [])
              .map(
                (x) =>
                  esc(x.name) +
                  (x.onSite ? ' ✓' : x.answer === 'YES' ? ' · yes' : x.answer === 'NO' ? ' · no' : ' · ?'),
              )
              .join(', ') +
            '</small>' +
            (ops
              ? '<button type="button" class="tdh-link" data-lt-open-item="' + esc(w.item) + '">Open</button>'
              : '') +
            '</li>',
        )
        .join('') +
      '</ul></div>'
    : '';
  const y = p.yard ?? {};
  const yard =
    '<div class="lt-people-col"><h3 class="tdh-sub">The yard</h3><ul class="lt-people"><li><b>Lists to pack</b>' +
    pill(y.toPack ? 'wait' : 'off', y.toPack ? String(y.toPack) : 'none') +
    '</li><li><b>Packed, waiting for the truck</b>' +
    pill(y.packed ? 'yes' : 'off', y.packed ? String(y.packed) : 'none') +
    '</li>' +
    (y.restack
      ? '<li><b>Re-stack</b>' +
        pill(
          y.restack.status === 'DONE' ? 'yes' : y.restack.draft ? 'off' : 'wait',
          y.restack.status === 'DONE' ? 'Done' : y.restack.draft ? 'Draft' : 'Booked',
        ) +
        (ops
          ? '<button type="button" class="tdh-link" data-lt-open-item="' + esc(y.restack.id) + '">Open</button>'
          : '') +
        '</li>'
      : '') +
    '</ul></div>';
  return (
    '<section class="panel lt-lanes" id="lt-lanes" aria-labelledby="lt-lanes-h"><div class="tdh-day-head"><h2 id="lt-lanes-h">Dispatch lanes</h2><span class="tdh-tag' +
    (d.day === d.today ? ' is-today' : '') +
    '">' +
    esc(d.dayLabel ?? d.day) +
    '</span></div>' +
    legend +
    (lanes ? '<div class="lt-lanes-list">' + lanes + '</div>' : '<p class="tdh-quiet">No truck booked this day.</p>') +
    unbooked +
    waiting +
    '<div class="lt-people-grid">' +
    drivers +
    workers +
    yard +
    '</div></section>'
  );
}
// ---------------------------------------------------------------- the run sheet (one printed page per driver)
/** @param {any} r GET /api/run-sheet */
export function ltSheetHTML(r) {
  const company = typeof r.company === 'string' ? r.company : (r.company?.name ?? 'Scaffold Yard');
  return (r.sheets ?? [])
    .map(
      (s) =>
        '<section class="lt-sheet"><div class="lt-sheet-head"><div><small>' +
        esc(company) +
        ' · Run sheet</small><h1>' +
        esc(s.driver?.name ?? 'Driver') +
        ' · ' +
        esc(s.truck?.name ?? 'Truck') +
        '</h1><p>' +
        esc(r.dayLabel ?? r.day) +
        ' · from ' +
        esc(s.timeWords ?? s.time) +
        (s.driver?.mobileWords || s.driver?.mobile ? ' · ' + esc(s.driver.mobileWords ?? s.driver.mobile) : '') +
        '</p></div><p class="lt-sheet-n">' +
        esc(plural((s.trips ?? []).length, 'trip')) +
        '</p></div>' +
        (s.note ? '<p class="lt-sheet-note">' + esc(s.note) + '</p>' : '') +
        '<table class="lt-sheet-table"><thead><tr><th>#</th><th>Time</th><th>Where</th><th>Load</th><th>Received by</th></tr></thead><tbody>' +
        (s.trips ?? [])
          .map(
            (t, i) =>
              '<tr><td>' +
              (i + 1) +
              '</td><td>' +
              esc(t.timeWords ?? t.time ?? '') +
              '</td><td><b>' +
              esc(t.words) +
              '</b>' +
              (t.address ? '<br>' + esc(t.address) : '') +
              (t.contact || t.phone
                ? '<br><small>' + esc([t.contact, t.phone].filter(Boolean).join(' · ')) + '</small>'
                : '') +
              (t.notes?.length ? '<br><small>' + esc(t.notes.join(' · ')) + '</small>' : '') +
              '</td><td>' +
              (t.lines ?? [])
                .map(
                  (l) =>
                    esc(l.quantity + ' × ' + l.name) +
                    (l.asked != null && l.asked !== l.quantity ? ' <small>(asked ' + l.asked + ')</small>' : ''),
                )
                .join('<br>') +
              '<br><small>' +
              esc(plural(t.pieces ?? 0, 'piece') + (t.state === 'PACKED' ? ' · packed' : '')) +
              '</small></td><td class="lt-sheet-sign">' +
              (t.receivedBy ? esc(t.receivedBy) : '') +
              '</td></tr>',
          )
          .join('') +
        '</tbody></table><div class="lt-sheet-foot"><span>Driver’s signature</span><span>Time back at yard</span></div></section>',
    )
    .join('');
}
/** Print the sheet: it is put on the page, printed, then taken away. @param {any} r */
function printSheet(r) {
  if (typeof document === 'undefined') return;
  document.querySelector('[data-lt-print]')?.remove();
  const box = document.createElement('div');
  box.className = 'lt-print';
  box.setAttribute('data-lt-print', '');
  box.innerHTML =
    ltSheetHTML(r) +
    '<p class="lt-print-bar"><button type="button" class="tdh-go" data-lt-print-go>Print</button><button type="button" class="tdh-link" data-lt-print-x>Close</button></p>';
  document.body.append(box);
  document.body.classList.add('lt-printing');
  const done = () => {
    removeEventListener('afterprint', done);
  };
  addEventListener('afterprint', done);
  try {
    setTimeout(() => window.print(), 50);
  } catch {}
}
export const ltPrintClose = () => {
  document.querySelector('[data-lt-print]')?.remove();
  document.body.classList.remove('lt-printing');
};
// ---------------------------------------------------------------- events
async function run(action, data, done) {
  if (LT.working) return null;
  LT.working = true;
  LT.err = null;
  LT.host.redraw();
  try {
    const r = await LT.host.cmd(action, data);
    ltForget();
    done?.(r);
    if (r?.message) LT.host.notify(r.message);
    await LT.host.refresh();
    return r;
  } catch (e) {
    LT.err = e.message;
    if (LT.dismiss) LT.dismiss.err = e.message;
    if (!LT.tool && !LT.dismiss) LT.host.notify(e.message);
    return null;
  } finally {
    LT.working = false;
    LT.host.redraw();
  }
}
/** Where an item's one action goes. @param {any} x */
function act(x) {
  const a = x?.action ?? {},
    h = LT.host;
  if (a.view === 'TODAY' && a.paperwork) {
    h.selectDay(a.day ?? h.today());
    requestAnimationFrame(() => document.getElementById('tdh-paper')?.scrollIntoView({ block: 'start' }));
    return;
  }
  if (a.view === 'TODAY' && a.item) return h.goItem(a.item, a.day ?? h.today());
  if (a.view === 'TODAY') return h.selectDay(a.day ?? h.today());
  if (a.view === 'TRIPS' && a.trip) return h.goTrip(a.trip);
  // UNBILLED: the Hire page opens on that customer's statement (ADR 0011); BILLED_CHANGED: on the Adjust form with the amount
  if (a.view === 'HIRE' && a.customer) {
    h.pickCustomer?.(a.customer);
    if (a.statement) h.openAdjust?.(a.statement, a.amount ?? null, a.description ?? '');
    h.go('HIRE');
    requestAnimationFrame(() =>
      document
        .querySelector(a.statement ? '[data-lb-st="' + CSS.escape(a.statement) + '"]' : '#lb-statements')
        ?.scrollIntoView({ block: 'start' }),
    );
    return;
  }
  // a removed customer with money owing: the Customers card on Client sites (Bring back)
  if (a.view === 'SITES' && a.customer) {
    h.go('SITES');
    requestAnimationFrame(() => document.getElementById('lb-customers')?.scrollIntoView({ block: 'start' }));
    return;
  }
  if (a.view === 'SITES' && a.site) {
    h.go('SITES');
    requestAnimationFrame(() => document.getElementById('si-site-' + a.site)?.scrollIntoView({ block: 'start' }));
    return;
  }
  if (a.view) h.go(a.view);
}
function onClick(e) {
  const b = /** @type {HTMLElement} */ (e.target)?.closest?.('button');
  if (!b || !LT.host) return;
  const d = b.dataset;
  if (d.ltAct !== undefined) {
    const x = (LT.needs?.items ?? []).find((i) => i.id === d.ltAct);
    if (x) act(x);
    return;
  }
  if (d.ltDismiss !== undefined) {
    LT.dismiss = LT.dismiss?.id === d.ltDismiss ? null : { id: d.ltDismiss, reason: '', err: null };
    LT.host.redraw();
    requestAnimationFrame(() => document.querySelector('.lt-dismiss input')?.focus({ preventScroll: true }));
    return;
  }
  if (b.hasAttribute('data-lt-dismiss-x')) {
    LT.dismiss = null;
    LT.host.redraw();
    return;
  }
  if (d.ltMode !== undefined) {
    LT.mode = d.ltMode === 'lanes' ? 'lanes' : 'day';
    LT.tool = null;
    LT.host.redraw();
    return;
  }
  if (d.ltTool !== undefined) {
    LT.tool = LT.tool === d.ltTool ? null : d.ltTool;
    LT.err = null;
    LT.form = {};
    LT.host.redraw();
    requestAnimationFrame(() =>
      document.querySelector('.lt-tool-form input,.lt-tool-form select')?.focus({ preventScroll: true }),
    );
    return;
  }
  if (b.hasAttribute('data-lt-tool-x')) {
    LT.tool = null;
    LT.err = null;
    LT.host.redraw();
    return;
  }
  if (d.ltOpenTrip !== undefined) {
    LT.mode = 'day';
    LT.host.goTrip(d.ltOpenTrip);
    return;
  }
  if (d.ltOpenItem !== undefined) {
    LT.mode = 'day';
    const day = b.closest('[data-lt-day]')?.getAttribute('data-lt-day') ?? LT.host.today();
    LT.host.goItem(d.ltOpenItem, day);
    return;
  }
  if (d.ltAdd !== undefined) {
    LT.mode = 'day';
    const day = b.closest('[data-lt-day]')?.getAttribute('data-lt-day') ?? LT.host.today();
    LT.host.addForm(d.ltAdd, day);
    return;
  }
  if (b.hasAttribute('data-lt-print-go')) {
    try {
      window.print();
    } catch {}
    return;
  }
  if (b.hasAttribute('data-lt-print-x')) ltPrintClose();
}
function onInput(e) {
  const t = /** @type {HTMLInputElement} */ (e.target);
  if (!t?.closest) return;
  if (t.closest('[data-lt-dismiss-form]') && LT.dismiss) LT.dismiss.reason = t.value;
  else if (t.closest('[data-lt-form]')) LT.form[t.name] = t.type === 'checkbox' ? t.checked : t.value;
}
function onSubmit(e) {
  const f = /** @type {HTMLFormElement} */ (e.target);
  if (!f?.dataset || !LT.host) return;
  if (f.dataset.ltDismissForm !== undefined) {
    e.preventDefault();
    const reason = String(new FormData(f).get('reason') ?? '').trim();
    run('needsYouDismiss', { id: f.dataset.ltDismissForm, reason }, () => {
      LT.dismiss = null;
    });
    return;
  }
  if (f.dataset.ltForm === undefined) return;
  e.preventDefault();
  const day = f.closest('[data-lt-day]')?.getAttribute('data-lt-day') ?? LT.host.today(),
    fd = new FormData(f);
  if (f.dataset.ltForm === 'move')
    run('planMoveDay', { from: day, to: String(fd.get('to') ?? '') }, (r) => {
      LT.tool = null;
      if (r?.to) LT.host.selectDay(r.to);
    });
  else if (f.dataset.ltForm === 'copy')
    run('planCopyCrews', { from: String(fd.get('from') ?? ''), to: day, draft: fd.get('draft') === 'on' }, () => {
      LT.tool = null;
    });
  else if (f.dataset.ltForm === 'print') {
    if (LT.working) return;
    LT.working = true;
    LT.err = null;
    LT.host.redraw();
    const driver = String(fd.get('driver') ?? '');
    LT.host
      .get('run-sheet?day=' + encodeURIComponent(day) + (driver ? '&driver=' + encodeURIComponent(driver) : ''))
      .then((r) => {
        LT.sheet = r;
        LT.tool = null;
        printSheet(r);
      })
      .catch((err) => {
        LT.err = err.message;
      })
      .finally(() => {
        LT.working = false;
        LT.host.redraw();
      });
  }
}
export const __lt = {
  state: LT,
  reset() {
    Object.assign(LT, {
      needs: null,
      needsAt: 0,
      days: new Map(),
      mode: 'day',
      tool: null,
      form: {},
      dismiss: null,
      err: null,
    });
  },
  setNeeds(n) {
    LT.needs = n;
    LT.needsAt = Date.now();
  },
  setDay(day, data) {
    LT.days.set(day || 'today', { at: Date.now(), data });
  },
  mode(m) {
    LT.mode = m;
  },
  tool(t) {
    LT.tool = t;
  },
  dismiss(id) {
    LT.dismiss = id ? { id, reason: '', err: null } : null;
  },
};
