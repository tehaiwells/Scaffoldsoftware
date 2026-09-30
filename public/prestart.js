// The Pre-start page (owner brief 30 September 2026): a date picker (today, Tomorrow) and one Print button. The sheet is basic and complete:
// every rostered or tasked worker with the day's tasks in priority order (time, where, the gear list's lines, "with Kev, Sam"), the
// drivers' trips, a signature line each. It prints through the app's print mechanism (operations.js prOpen with a model kind 'prestart').
// prestartSheet(view) is pure (the tests build it in Node from GET /api/prestart); psSetup wires the page's two buttons.
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
/** @type {any} */
const PS = { host: null, bound: false, day: null, data: null, dataFor: null, busy: false, err: null };
/** @param {{get:(p:string)=>Promise<any>,notify:(t:string)=>void,redraw:()=>void,view:()=>string,today:()=>string|null,print:(m:any)=>void}} host */
export function psSetup(host) {
  PS.host = host;
  if (typeof document === 'undefined' || PS.bound) return;
  PS.bound = true;
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
}
export const psState = () => PS;
export const psDay = () => PS.day ?? PS.host?.today() ?? PS.data?.today ?? null;
export function psOpenDay(day) {
  PS.day = day;
}
const addDay = (day, n) => {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
function psFetch(force = false) {
  if (!PS.host || PS.busy) return;
  const day = psDay();
  if (!force && PS.dataFor === day && PS.data) return;
  PS.busy = true;
  PS.host
    .get('prestart' + (day ? '?day=' + day : ''))
    .then((d) => {
      PS.data = d;
      PS.dataFor = day;
      PS.err = null;
    })
    .catch((e) => {
      PS.err = e.message;
    })
    .finally(() => {
      PS.busy = false;
      PS.host.redraw();
    });
}
export const psForget = () => {
  PS.dataFor = null;
};
// ---------------------------------------------------------------- the print model (pure)
/**
 * The sheet from the server's view: {kind:'prestart', company, title, day, printedAt, workers[], drivers[]} plus the HTML.
 * @param {any} v GET /api/prestart
 */
export function prestartSheet(v) {
  const title = 'Pre-start · ' + v.dayLabel;
  // one word per person: Confirmed, Can't work, Not asked, Rostered (asked, no answer yet) or Not rostered
  const workers = (v.workers ?? []).map((w) => ({
    name: w.name,
    role: w.roleWords,
    where: w.where,
    time: w.timeWords,
    rostered: !w.rostered
      ? 'Not rostered'
      : w.rostered === 'CONFIRMED' || w.answer === 'YES'
        ? 'Confirmed'
        : w.rostered === 'DENIED' || w.answer === 'NO'
          ? 'Can’t work'
          : w.answer === 'NOT_ASKED'
            ? 'Not asked'
            : w.answer === 'NO_ANSWER'
              ? 'No answer'
              : w.answer === 'WAITING'
                ? 'Asked, waiting'
                : 'Rostered',
    answer: w.answer === 'YES' ? 'Yes' : w.answer === 'NO' ? 'Can’t' : '—',
    tasks: (w.tasks ?? []).map((t) => ({
      priority: t.priority,
      name: t.name,
      time: t.timeWords,
      where: t.where,
      kind: t.kindWords,
      lines: (t.lines ?? []).map((l) => l.quantity + ' × ' + l.name),
      with: t.workersWith ?? [],
      note: t.note,
      done: t.status === 'DONE',
    })),
  }));
  const drivers = (v.drivers ?? []).map((d) => ({
    name: d.name,
    truck: d.truck,
    time: d.timeWords,
    answer: d.answer === 'YES' ? 'Yes' : d.answer === 'NO' ? 'Can’t' : '—',
    trips: (d.trips ?? []).map((t) => ({ time: t.timeWords, words: t.words, siteName: t.siteName })),
  }));
  return {
    kind: 'prestart',
    what: 'Pre-start',
    company: v.company,
    title, // the print shell shows `what` and this title once: "Pre-start · Fri 2 Oct"
    shellTitle: v.dayLabel,
    day: v.day,
    dayLabel: v.dayLabel,
    printedAt: v.printedAt,
    printedBy: v.printedBy ?? null,
    workers,
    drivers,
    summary: v.summary ?? { workers: workers.length, tasks: 0, done: 0 },
  };
}
const prDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) +
        ' ' +
        String(d.getHours()).padStart(2, '0') +
        ':' +
        String(d.getMinutes()).padStart(2, '0');
};
/** The A4 sheet (pr-sheet classes; plain black on white). @param {ReturnType<typeof prestartSheet>} m */
export function psSheetHTML(m) {
  const worker = (w) =>
    '<section class="ps-worker"><div class="ps-worker-head"><h2>' +
    esc(w.name) +
    '</h2><span>' +
    esc([w.role, w.where, w.time, w.rostered].filter(Boolean).join(' · ')) +
    '</span></div>' +
    (w.tasks.length
      ? '<ol class="ps-tasks">' +
        w.tasks
          .map(
            (t) =>
              '<li><span class="ps-box" aria-hidden="true">' +
              (t.done ? '✓' : '') +
              '</span><div><b>P' +
              t.priority +
              ' ' +
              esc(t.name) +
              '</b><small>' +
              esc([t.time, t.where, t.kind].filter(Boolean).join(' · ')) +
              (t.with.length ? ' · with ' + esc(t.with.join(', ')) : '') +
              '</small>' +
              (t.lines.length
                ? '<ul class="ps-lines">' + t.lines.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>'
                : '') +
              (t.note ? '<small class="ps-note">' + esc(t.note) + '</small>' : '') +
              '</div></li>',
          )
          .join('') +
        '</ol>'
      : '<p class="ps-none">No tasks allocated.</p>') +
    '<div class="ps-sign"><span>Signed</span><i></i><span>Time</span><i class="short"></i></div></section>';
  const driver = (d) =>
    '<section class="ps-driver"><div class="ps-worker-head"><h2>' +
    esc(d.name) +
    '</h2><span>' +
    esc(
      d.truck +
        ' · ' +
        d.time +
        ' · ' +
        (d.answer === 'Yes' ? 'Confirmed' : d.answer === 'Can’t' ? 'Can’t drive' : 'Not confirmed'),
    ) +
    '</span></div>' +
    (d.trips.length
      ? '<ol class="ps-tasks">' +
        d.trips
          .map(
            (t) =>
              '<li><span class="ps-box" aria-hidden="true"></span><div><b>' +
              esc(t.time + ' · ' + t.words) +
              '</b></div></li>',
          )
          .join('') +
        '</ol>'
      : '<p class="ps-none">No trips booked.</p>') +
    '<div class="ps-sign"><span>Signed</span><i></i><span>Time</span><i class="short"></i></div></section>';
  return (
    '<article class="pr-sheet ps-sheet" aria-label="' +
    esc(m.title) +
    '"><div class="ps-head"><div><span class="ps-kind">' +
    esc(m.company) +
    '</span><h1>' +
    esc(m.title) +
    '</h1></div><small>Printed ' +
    esc(prDate(m.printedAt)) +
    (m.printedBy ? ' by ' + esc(m.printedBy) : '') +
    ' · ' +
    esc(plural(m.summary.workers, 'worker') + ', ' + plural(m.summary.tasks, 'task')) +
    '</small></div>' +
    (m.workers.length ? m.workers.map(worker).join('') : '<p class="ps-none">Nobody rostered or tasked that day.</p>') +
    (m.drivers.length ? '<h2 class="ps-section">Drivers</h2>' + m.drivers.map(driver).join('') : '') +
    '<div class="ps-foot">Tick each task as it is done. Everyone confirms on their phone, or tells the office.</div></article>'
  );
}
// ---------------------------------------------------------------- the page
/** @param {any} v GET /api/prestart */
export function psPageHTML(v) {
  const day = psDay(),
    today = PS.host?.today() ?? v?.today ?? null;
  const picker =
    '<div class="ps-bar"><label class="tm-f ps-date"><span>Day</span><input type="date" data-ps-date value="' +
    esc(day ?? '') +
    '"></label>' +
    (today
      ? '<button type="button" class="tdh-btn secondary" data-ps-day="' +
        esc(today) +
        '"' +
        (day === today ? ' aria-pressed="true"' : '') +
        '>Today</button><button type="button" class="tdh-btn secondary" data-ps-day="' +
        esc(addDay(today, 1)) +
        '"' +
        (day === addDay(today, 1) ? ' aria-pressed="true"' : '') +
        '>Tomorrow</button>'
      : '') +
    '<button type="button" class="tdh-go ps-print" data-ps-print' +
    (!v || PS.dataFor !== day ? ' disabled' : '') +
    '>Print</button></div>';
  const body = !v
    ? '<p class="tm-quiet">' + esc(PS.err ?? 'Loading…') + '</p>'
    : '<p class="ps-words">' +
      esc(
        v.dayLabel +
          ': ' +
          plural(v.summary.workers, 'worker') +
          ', ' +
          plural(v.summary.tasks, 'task') +
          (v.drivers.length ? ', ' + plural(v.drivers.length, 'driver') : ''),
      ) +
      '.</p><div class="ps-preview">' +
      psSheetHTML(prestartSheet(v)) +
      '</div>';
  return '<div class="page-prestart ps"><section class="panel ps-panel">' + picker + body + '</section></div>';
}
export function psView() {
  if (PS.host) psFetch(false);
  return psPageHTML(PS.dataFor === psDay() ? PS.data : null);
}
function onClick(e) {
  const b = e.target?.closest?.('[data-ps-day],[data-ps-print]');
  if (!b || !PS.host || PS.host.view() !== 'PRESTART') return;
  if (b.dataset.psDay !== undefined) {
    psOpenDay(b.dataset.psDay);
    PS.host.redraw();
    psFetch(false);
    return;
  }
  if (b.dataset.psPrint !== undefined && PS.data && PS.dataFor === psDay()) PS.host.print(prestartSheet(PS.data));
}
function onChange(e) {
  const t = e.target;
  if (!t?.matches?.('[data-ps-date]') || !PS.host || PS.host.view() !== 'PRESTART') return;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t.value)) {
    psOpenDay(t.value);
    PS.host.redraw();
    psFetch(false);
  }
}
