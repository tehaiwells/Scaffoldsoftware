// The Workers page's roster (owner brief 30 September 2026): a "+1 worker" form (name, job, where, phone, email) and, under each worker's
// row, a Roster button that unfolds a month grid: tap a day to roster them, tap again to clear; Mon–Fri / Mon–Sat patterns the clock keeps
// filled a fortnight ahead; a confirmed day shows a tick, a denied day red. Every tap is one command (rosterPick / rosterClear), no Save
// button. The HTML functions are pure (the tests render them in Node); rsSetup wires one set of listeners on the document. Data: GET /api/team
// (the rows) and GET /api/roster?person=&from=&to= (one person's grid).
import { monthGrid, monthTitle, monthAdd, WEEKDAY_LETTERS, PLAN_TIMES, planTimeWords } from './plan-cal.js';
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
/** @type {any} */
const RS = {
  host: null,
  bound: false,
  open: null, // the worker whose roster is unfolded
  month: null,
  data: null, // GET /api/roster for the open worker and month
  dataFor: null,
  busy: false,
  err: null,
  taps: new Set(), // days with a command on the way (drawn as pending)
  add: { on: false, name: '', job: 'YARD', where: '', mobile: '', email: '' },
  adding: false,
};
export const RS_STATUS_WORDS = {
  ROSTERED: 'Rostered',
  CONFIRMED: 'Confirmed',
  DENIED: 'Can’t work',
};
/** @param {{get:(p:string)=>Promise<any>,cmd:(a:string,d:any)=>Promise<any>,notify:(t:string)=>void,redraw:()=>void,refresh:()=>Promise<any>,view:()=>string,teamReload:()=>void,today:()=>string|null}} host */
export function rsSetup(host) {
  RS.host = host;
  if (typeof document === 'undefined' || RS.bound) return;
  RS.bound = true;
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
}
export const rsState = () => RS;
export const rsReset = () => {
  RS.open = null;
  RS.month = null;
  RS.data = null;
  RS.dataFor = null;
  RS.taps.clear();
  RS.add = { on: false, name: '', job: 'YARD', where: '', mobile: '', email: '' };
};
// ---------------------------------------------------------------- data
const monthOf = (day) => String(day ?? '').slice(0, 7);
function rsLoad(force = false) {
  if (!RS.host || !RS.open || RS.busy) return;
  const today = RS.host.today();
  if (!today) return;
  RS.month ??= monthOf(today);
  const grid = monthGrid(RS.month),
    key = RS.open + '|' + RS.month;
  const rev = RS.host.rev?.() ?? null; // the plan revision: an answer from a phone bumps it, so the grid reads again on the next poll
  if (!force && RS.dataFor === key && RS.data && RS.rev === rev) return;
  RS.rev = rev;
  RS.busy = true;
  RS.host
    .get('roster?person=' + encodeURIComponent(RS.open) + '&from=' + grid[0] + '&to=' + grid[41])
    .then((d) => {
      RS.data = d;
      RS.dataFor = key;
      RS.err = null;
    })
    .catch((e) => {
      RS.err = e.message;
    })
    .finally(() => {
      RS.busy = false;
      RS.host.redraw();
    });
}
// ---------------------------------------------------------------- HTML
/** The "+1 worker" button and, when open, its small form. @param {any} team GET /api/team */
export function rsAddHTML(team) {
  const a = RS.add;
  if (!a.on) return '<button type="button" class="tdh-go rs-add-go" data-rs-add-open>+1 worker</button>';
  const places = team?.places ?? [],
    jobs = team?.jobs ?? [
      { code: 'YARD', words: 'Yard worker' },
      { code: 'ONSITE', words: 'Onsite worker' },
    ];
  return (
    '<form class="rs-add" data-rs-add aria-label="Add a worker"><b class="rs-add-title">+1 worker</b>' +
    '<label class="tm-f"><span>Name</span><input name="name" maxlength="60" required autocomplete="off" value="' +
    esc(a.name) +
    '"></label>' +
    '<label class="tm-f"><span>Job</span><select name="job">' +
    jobs
      .map(
        (j) =>
          '<option value="' + j.code + '"' + (j.code === a.job ? ' selected' : '') + '>' + esc(j.words) + '</option>',
      )
      .join('') +
    '</select></label>' +
    '<label class="tm-f"><span>Where</span><select name="where">' +
    places
      .map(
        (p) =>
          '<option value="' +
          esc(p.id) +
          '"' +
          (p.id === a.where ? ' selected' : '') +
          '>' +
          esc(p.kind === 'yard' ? 'This yard' : p.name) +
          '</option>',
      )
      .join('') +
    '</select></label>' +
    '<label class="tm-f"><span>Phone</span><input name="mobile" inputmode="tel" maxlength="30" placeholder="0412 345 678" autocomplete="off" value="' +
    esc(a.mobile) +
    '"></label>' +
    '<label class="tm-f"><span>Email</span><input name="email" type="email" maxlength="120" placeholder="name@example.com" autocomplete="off" value="' +
    esc(a.email) +
    '"></label>' +
    '<div class="rs-add-acts"><button type="submit" class="tdh-go"' +
    (RS.adding ? ' disabled' : '') +
    '>Add</button><button type="button" class="tdh-link" data-rs-add-x>Not now</button></div></form>'
  );
}
/** The Roster button on a worker's row (with the next fortnight in a few words) and the unfolded grid. @param {any} x a team row */
export function rsRowHTML(x) {
  if (x.kind !== 'worker') return '';
  const open = RS.open === x.id,
    n = x.roster?.next14?.filter((d) => d.status !== 'DENIED').length ?? null,
    denied = x.roster?.next14?.filter((d) => d.status === 'DENIED').length ?? 0;
  const words =
    n === null
      ? ''
      : n === 0 && !denied
        ? 'Not rostered'
        : n +
          ' of the next 14 days' +
          (x.roster?.pattern ? ' · ' + x.roster.pattern.words : '') +
          (denied ? ' · ' + denied + ' can’t' : '');
  return (
    '<button type="button" class="secondary tdh-btn rs-open' +
    (open ? ' on' : '') +
    (denied ? ' has-no' : '') +
    '" data-rs-open="' +
    esc(x.id) +
    '" aria-expanded="' +
    open +
    '">' +
    (open ? 'Close roster' : 'Roster') +
    (words ? '<small>' + esc(words) + '</small>' : '') +
    '</button>'
  );
}
/** The unfolded roster of one worker: pattern buttons, where and time, the month grid. @param {any} x a team row */
export function rsGridHTML(x) {
  if (RS.open !== x.id) return '';
  rsLoad(false);
  const d = RS.dataFor === RS.open + '|' + RS.month ? RS.data : null,
    today = RS.host?.today() ?? d?.today ?? null,
    month = RS.month ?? monthOf(today);
  if (!month) return '';
  const grid = monthGrid(month),
    byDay = new Map((d?.days ?? []).map((r) => [r.day, r])),
    pattern = d?.pattern ?? x.roster?.pattern ?? null,
    where = d?.person?.where ?? x.whereId ?? '',
    places = d?.places ?? [];
  const patBtn = (kind, words) =>
    '<button type="button" class="tdh-btn secondary rs-pat' +
    (pattern?.kind === kind ? ' on' : '') +
    '" data-rs-pattern="' +
    kind +
    '" data-person="' +
    esc(x.id) +
    '" aria-pressed="' +
    (pattern?.kind === kind) +
    '">' +
    words +
    '</button>';
  const cells = grid
    .map((day) => {
      const r = byDay.get(day),
        st = r && r.status !== 'REMOVED' ? r.status : null,
        past = today && day < today,
        other = monthOf(day) !== month,
        pending = RS.taps.has(day);
      const cls =
        'rs-cell' +
        (other ? ' other' : '') +
        (past ? ' past' : '') +
        (day === today ? ' today' : '') +
        (st ? ' st-' + st.toLowerCase() : '') +
        (r?.source === 'PATTERN' && st ? ' pat' : '') +
        (pending ? ' pending' : '');
      const title = st
        ? RS_STATUS_WORDS[st] +
          (r.answer === 'NO' && r.reason ? ': ' + r.reason : '') +
          ' · ' +
          r.whereName +
          ' ' +
          r.timeWords
        : past
          ? ''
          : 'Tap to roster';
      return (
        '<button type="button" class="' +
        cls +
        '" data-rs-day="' +
        day +
        '" data-person="' +
        esc(x.id) +
        '"' +
        (past ? ' disabled' : '') +
        ' aria-label="' +
        esc(day + (st ? ' ' + RS_STATUS_WORDS[st] : '')) +
        '" title="' +
        esc(title) +
        '"><span class="rs-num">' +
        Number(day.slice(8)) +
        '</span>' +
        (st === 'CONFIRMED'
          ? '<span class="rs-mark tick" aria-hidden="true">✓</span>'
          : st === 'DENIED'
            ? '<span class="rs-mark no" aria-hidden="true">✕</span>'
            : st
              ? '<span class="rs-mark dot" aria-hidden="true"></span>'
              : '') +
        '</button>'
      );
    })
    .join('');
  return (
    '<div class="rs-panel" data-rs-panel="' +
    esc(x.id) +
    '"><div class="rs-tools"><div class="rs-pats">' +
    patBtn('MON_FRI', 'Mon–Fri') +
    patBtn('MON_SAT', 'Mon–Sat') +
    (pattern
      ? '<button type="button" class="tdh-link" data-rs-pattern-end="' + esc(x.id) + '">Stop pattern</button>'
      : '') +
    '</div><div class="rs-wt"><label class="tm-f"><span>Where</span><select data-rs-where="' +
    esc(x.id) +
    '">' +
    places
      .map(
        (p) =>
          '<option value="' +
          esc(p.id) +
          '"' +
          (p.id === (RS.where ?? where) ? ' selected' : '') +
          '>' +
          esc(p.kind === 'yard' ? 'This yard' : p.name) +
          '</option>',
      )
      .join('') +
    '</select></label><label class="tm-f"><span>Time</span><select data-rs-time="' +
    esc(x.id) +
    '">' +
    PLAN_TIMES.map(
      (t) =>
        '<option value="' +
        t +
        '"' +
        (t === (RS.time ?? pattern?.time ?? '07:00') ? ' selected' : '') +
        '>' +
        planTimeWords(t) +
        '</option>',
    ).join('') +
    '</select></label></div></div>' +
    '<div class="rs-month"><button type="button" class="tdh-btn secondary" data-rs-month="' +
    monthAdd(month, -1) +
    '" aria-label="Previous month">‹</button><b>' +
    esc(monthTitle(month)) +
    '</b><button type="button" class="tdh-btn secondary" data-rs-month="' +
    monthAdd(month, 1) +
    '" aria-label="Next month">›</button></div>' +
    '<div class="rs-grid" role="grid" aria-label="Roster for ' +
    esc(x.name) +
    '"><div class="rs-wd">' +
    WEEKDAY_LETTERS.map((l) => '<span>' + l + '</span>').join('') +
    '</div>' +
    cells +
    '</div>' +
    (RS.err ? '<p class="rs-err" role="alert">' + esc(RS.err) + '</p>' : '') +
    '<p class="rs-note">Tap a day to roster ' +
    esc(x.name.split(' ')[0]) +
    ', tap again to clear. A pattern keeps 14 days ahead filled. Everyone is asked the day before at 3 pm: ✓ confirmed, ✕ can’t.</p></div>'
  );
}
// ---------------------------------------------------------------- listeners
function onClick(e) {
  const b = e.target?.closest?.(
    '[data-rs-open],[data-rs-day],[data-rs-pattern],[data-rs-pattern-end],[data-rs-month],[data-rs-add-open],[data-rs-add-x]',
  );
  if (!b || !RS.host || RS.host.view() !== 'WORKERS') return;
  const d = b.dataset;
  if (d.rsAddOpen !== undefined) {
    RS.add.on = true;
    RS.host.redraw();
    requestAnimationFrame(() => document.querySelector('[data-rs-add] input[name=name]')?.focus());
    return;
  }
  if (d.rsAddX !== undefined) {
    RS.add.on = false;
    RS.host.redraw();
    return;
  }
  if (d.rsOpen !== undefined) {
    RS.open = RS.open === d.rsOpen ? null : d.rsOpen;
    RS.month = null;
    RS.where = null;
    RS.time = null;
    RS.host.redraw();
    if (RS.open) rsLoad(true);
    return;
  }
  if (d.rsMonth !== undefined) {
    RS.month = d.rsMonth;
    RS.host.redraw();
    rsLoad(true);
    return;
  }
  if (d.rsDay !== undefined) {
    const day = d.rsDay,
      r = RS.data?.days?.find((x) => x.day === day),
      on = r && r.status !== 'REMOVED';
    if (RS.taps.has(day)) return;
    RS.taps.add(day);
    RS.host.redraw();
    run(
      on
        ? RS.host.cmd('rosterClear', { person: d.person, days: [day] })
        : RS.host.cmd('rosterPick', {
            person: d.person,
            days: [day],
            ...(RS.where ? { where: RS.where } : {}),
            ...(RS.time ? { time: RS.time } : {}),
          }),
      () => RS.taps.delete(day),
    );
    return;
  }
  if (d.rsPattern !== undefined) {
    b.disabled = true;
    run(
      RS.host.cmd('rosterPattern', {
        person: d.person,
        kind: d.rsPattern,
        ...(RS.where ? { where: RS.where } : {}),
        ...(RS.time ? { time: RS.time } : {}),
      }),
    );
    return;
  }
  if (d.rsPatternEnd !== undefined) {
    b.disabled = true;
    run(RS.host.cmd('rosterPatternEnd', { person: d.rsPatternEnd }));
  }
}
function run(p, after) {
  p.then((r) => {
    if (r?.message) RS.host.notify(r.message);
  })
    .catch((e) => RS.host.notify(e.message))
    .finally(() => {
      after?.();
      rsLoad(true);
      RS.host.teamReload();
    });
}
function onChange(e) {
  const t = e.target;
  if (!t?.dataset || !RS.host || RS.host.view() !== 'WORKERS') return;
  if (t.dataset.rsWhere !== undefined) RS.where = t.value;
  if (t.dataset.rsTime !== undefined) RS.time = t.value;
}
function onInput(e) {
  const t = e.target;
  if (!t?.closest?.('[data-rs-add]') || !t.name) return;
  RS.add[t.name] = t.value;
}
async function onSubmit(e) {
  const f = e.target;
  if (!f?.matches?.('[data-rs-add]') || !RS.host) return;
  e.preventDefault();
  if (RS.adding) return;
  const v = Object.fromEntries(new FormData(f));
  RS.add = { ...RS.add, ...v, on: true };
  RS.adding = true;
  RS.host.redraw();
  try {
    const r = await RS.host.cmd('teamAdd', {
      name: v.name,
      job: v.job,
      where: v.where || null,
      mobile: v.mobile || null,
      email: v.email || null,
    });
    RS.host.notify(r.message);
    RS.add = { on: false, name: '', job: v.job, where: v.where, mobile: '', email: '' };
    RS.open = r.person?.id ?? null; // their roster opens straight away: the next thing the owner does is pick their days
    RS.month = null;
    await RS.host.refresh();
  } catch (err) {
    RS.host.notify(err.message);
  } finally {
    RS.adding = false;
    RS.host.teamReload();
    RS.host.redraw();
  }
}
