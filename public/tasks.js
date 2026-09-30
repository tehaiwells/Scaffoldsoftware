// The Task progress page (owner brief 30 September 2026): every worker's name with their tasks for the day as a tick list, a green tick the
// moment the worker confirms a step on their phone (a 1 s poll of GET /api/tasks?day=, redrawn only when the answer changed), "N of M
// done" at the top, the office ticking for someone who phoned it in (ON_BEHALF), and "+ Task" for a plain task. The HTML functions are
// pure (the tests render them in Node from the server's own view); tpSetup wires one set of listeners on the document.
import { PLAN_TIMES, planTimeWords, smsHref } from './plan-cal.js';
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
const TICK =
  '<svg class="tp-tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const TP_STEP_WORDS = { RECEIVED: 'Received', PACKED: 'Packed', LOADED: 'Loaded', DONE: 'Done' };
export const TP_ANSWER = {
  YES: ['yes', 'Yes'],
  NO: ['no', 'Can’t make it'],
  WAITING: ['wait', 'Asked'],
  NO_ANSWER: ['wait', 'No answer'],
  NOT_ASKED: ['no', 'Not asked'],
};
/** @type {any} */
const TP = {
  host: null,
  bound: false,
  day: null,
  data: null,
  json: null,
  busy: false,
  err: null,
  timer: null,
  form: null, // the + Task form's draft
  confirm: null, // {task, person, step} waiting for "phoned it in?"
  working: false,
};
/** @param {{get:(p:string)=>Promise<any>,cmd:(a:string,d:any)=>Promise<any>,notify:(t:string)=>void,redraw:()=>void,view:()=>string,go:(v:string,opt?:any)=>void,goItem:(id:string,day:string)=>void,today:()=>string|null}} host */
export function tpSetup(host) {
  TP.host = host;
  if (typeof document === 'undefined' || TP.bound) return;
  TP.bound = true;
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onInput);
}
export const tpState = () => TP;
/** The page's day: the one picked, else today. */
export const tpDay = () => TP.day ?? TP.host?.today() ?? TP.data?.today ?? null;
export function tpOpenDay(day) {
  TP.day = day;
  TP.data = null;
  TP.json = null;
}
// ---------------------------------------------------------------- data (a 1 s poll while the page is open)
function tpFetch() {
  if (!TP.host || TP.busy) return;
  const day = tpDay();
  TP.busy = true;
  TP.host
    .get('tasks' + (day ? '?day=' + day : ''))
    .then((d) => {
      const j = JSON.stringify(d);
      TP.err = null;
      if (j === TP.json) return;
      TP.json = j;
      TP.data = d;
      if (!document.activeElement?.closest?.('[data-tp-form]')) TP.host.redraw();
    })
    .catch((e) => {
      if (TP.err !== e.message) {
        TP.err = e.message;
        TP.host.redraw();
      }
    })
    .finally(() => {
      TP.busy = false;
    });
}
/** Start or stop the poll (operations.js bindPage: on while the view is PROGRESS). @param {boolean} on */
export function tpWatch(on) {
  if (typeof document === 'undefined') return;
  if (!on) {
    if (TP.timer) clearInterval(TP.timer);
    TP.timer = null;
    return;
  }
  if (TP.timer) return;
  tpFetch();
  TP.timer = setInterval(() => {
    if (document.visibilityState !== 'hidden' && TP.host?.view() === 'PROGRESS') tpFetch();
    else tpWatch(false);
  }, 1000);
}
export const tpForget = () => {
  TP.json = null;
};
// ---------------------------------------------------------------- HTML
const addDay = (day, n) => {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const pill = (cls, words) => '<span class="tp-pill ' + cls + '">' + esc(words) + '</span>';
/** One tick box: green with a tick when the mark is there, empty otherwise; the office may tap an empty one to tick for them. */
function box(t, w, step, mark, { canTick, mine }) {
  const on = !!mark;
  const who = on
    ? (mark.kind === 'PERSON'
        ? 'On their phone'
        : mark.kind === 'ON_BEHALF'
          ? 'Ticked by ' + mark.byName
          : mark.kind === 'ENGINE'
            ? 'The yard'
            : mark.byName) +
      ' · ' +
      hm(mark.at)
    : '';
  const label =
    (mine ? w.name + ': ' : '') +
    TP_STEP_WORDS[step] +
    (on ? ' · done · ' + who : canTick ? ' · tap to tick for them' : ' · to do');
  return (
    '<' +
    (canTick && !on ? 'button type="button"' : 'span') +
    ' class="tp-box' +
    (on ? ' on' : '') +
    (canTick && !on ? ' can' : '') +
    '"' +
    (canTick && !on
      ? ' data-tp-tick="' + esc(t.id) + '" data-person="' + esc(w.person) + '" data-step="' + step + '"'
      : '') +
    ' title="' +
    esc(label) +
    '" aria-label="' +
    esc(label) +
    '"><i aria-hidden="true">' +
    (on ? TICK : '') +
    '</i><span>' +
    TP_STEP_WORDS[step] +
    '</span></' +
    (canTick && !on ? 'button' : 'span') +
    '>'
  );
}
const hm = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};
/** One task in a worker's list. @param {any} t the task view @param {any} w the worker row (t.workers[]) @param {any} v the page data */
export function tpTaskHTML(t, w, v) {
  const canTick = !!v.canPlan && t.status === 'OPEN' && t.day <= v.today,
    done = t.status === 'DONE',
    cancelled = t.status === 'CANCELLED';
  const steps =
    t.kind === 'LIST'
      ? box(t, w, 'RECEIVED', w.steps.RECEIVED, { canTick, mine: true }) +
        box(t, w, 'PACKED', w.steps.PACKED, { canTick: canTick && !!w.steps.RECEIVED, mine: false }) +
        box(t, w, 'LOADED', w.steps.LOADED, { canTick: canTick && !!w.steps.PACKED, mine: false })
      : box(t, w, 'DONE', w.steps.DONE, { canTick, mine: true });
  const meta = [t.timeWords, t.siteName, t.kind === 'LIST' ? 'pack + load' : null].filter(Boolean).map(esc).join(' · ');
  const others = t.workers.filter((x) => x.person !== w.person).map((x) => x.name);
  const ans = w.answer && TP_ANSWER[w.answer] ? TP_ANSWER[w.answer] : null;
  return (
    '<li class="tp-task' +
    (done ? ' is-done' : '') +
    (cancelled ? ' is-off' : '') +
    (t.flag ? ' is-flag' : '') +
    '" data-tp-task="' +
    esc(t.id) +
    '"><div class="tp-task-main"><span class="tp-big' +
    (done ? ' on' : '') +
    '" aria-hidden="true"><i>' +
    (done ? TICK : '') +
    '</i></span><div class="tp-task-text"><b>P' +
    w.priority +
    ' ' +
    esc(t.name) +
    '</b><small>' +
    meta +
    (others.length ? ' · with ' + esc(others.join(', ')) : '') +
    (t.flag && !done ? ' · <em class="tp-flag">not confirmed</em>' : '') +
    (cancelled ? ' · cancelled' : '') +
    '</small>' +
    (t.lines?.length
      ? '<small class="tp-lines">' + t.lines.map((l) => l.quantity + ' × ' + esc(l.name)).join(', ') + '</small>'
      : '') +
    '</div>' +
    (ans && ans[0] === 'no' && !done
      ? pill('no', ans[1]) +
        (v.canPlan
          ? '<button type="button" class="tdh-link" data-tp-swap="' +
            esc(t.id) +
            '" data-person="' +
            esc(w.person) +
            '">Swap</button>'
          : '')
      : '') +
    '</div><div class="tp-steps">' +
    steps +
    (t.kind === 'LIST' && t.list && v.canPlan
      ? '<button type="button" class="tdh-link tp-goto" data-tp-list="' +
        esc(t.list) +
        '" data-day="' +
        esc(t.day) +
        '">Open the list</button>'
      : '') +
    '</div></li>'
  );
}
/** One worker's panel: name, role, rostered pill, their tasks in priority order. @param {any} w @param {any} v */
export function tpWorkerHTML(w, v) {
  const ros =
    w.rostered === 'CONFIRMED'
      ? pill('yes', 'Rostered · confirmed')
      : w.rostered === 'DENIED'
        ? pill('no', 'Rostered · can’t work')
        : w.rostered
          ? pill('wait', w.rosterAnswer === 'NOT_ASKED' ? 'Rostered · not asked' : 'Rostered')
          : pill('off', 'Not rostered');
  const ans =
    w.answer && TP_ANSWER[w.answer] && w.tasks.length
      ? pill(TP_ANSWER[w.answer][0], 'Tasks · ' + TP_ANSWER[w.answer][1])
      : '';
  return (
    '<section class="panel tp-worker' +
    (w.tasks.length && w.done === w.tasks.length ? ' all-done' : '') +
    '" data-tp-worker="' +
    esc(w.person) +
    '"><div class="tp-head"><div class="tp-head-text"><h2>' +
    esc(w.name) +
    '</h2><p>' +
    esc(w.roleWords) +
    (w.whereName ? ' · ' + esc(w.whereName) : '') +
    '</p></div><div class="tp-pills">' +
    ros +
    ans +
    (w.mobile && v.canPlan
      ? '<a class="tdh-link" href="' + esc(smsHref(w.mobile, 'Hi ' + w.name.split(' ')[0] + ', ')) + '">Text them</a>'
      : '') +
    (w.tasks.length
      ? pill(w.done === w.tasks.length ? 'yes' : 'off', w.done + ' of ' + w.tasks.length + ' done')
      : '') +
    '</div></div>' +
    (w.tasks.length
      ? '<ul class="tp-list">' +
        w.tasks.map((t) => tpTaskHTML(t, t.workers.find((x) => x.person === w.person) ?? w, v)).join('') +
        '</ul>'
      : '<p class="tp-none">No tasks ' +
        (v.day === v.today ? 'today' : 'that day') +
        '.' +
        (v.canTask && !w.gone
          ? ' <button type="button" class="tdh-link" data-tp-add="' + esc(w.person) + '">+ Task</button>'
          : '') +
        '</p>') +
    '</section>'
  );
}
/** The "+ Task" form (a plain task: name, who with P1/P2/P3, time, where, note). @param {any} v */
export function tpFormHTML(v) {
  const f = TP.form;
  if (!f) return '';
  const chip = (p, n) =>
    '<button type="button" class="tp-chip' +
    (f.people[p.id] === n ? ' on' : '') +
    '" data-tp-pri="' +
    esc(p.id) +
    '" data-n="' +
    n +
    '" aria-pressed="' +
    (f.people[p.id] === n) +
    '">P' +
    n +
    '</button>';
  return (
    '<form class="panel tp-form" data-tp-form aria-label="New task"><div class="tp-head"><div class="tp-head-text"><h2>+ Task</h2><p>A plain job for one or more workers. A gear list is allocated on Daily activities.</p></div></div>' +
    '<label class="tm-f"><span>What</span><input name="name" maxlength="60" required autocomplete="off" placeholder="Sweep the racks" value="' +
    esc(f.name) +
    '"></label>' +
    '<div class="tp-who"><span class="tp-who-label">Who, and their priority that day</span><ul>' +
    (v.team ?? [])
      .map(
        (p) =>
          '<li' +
          (f.people[p.id] ? ' class="on"' : '') +
          '><span class="tp-who-name">' +
          esc(p.name) +
          '</span><span class="tp-chips">' +
          [1, 2, 3].map((n) => chip(p, n)).join('') +
          '</span></li>',
      )
      .join('') +
    '</ul></div>' +
    '<div class="tp-form-row"><label class="tm-f"><span>Time</span><select name="time"><option value="">Any time</option>' +
    PLAN_TIMES.map(
      (t) => '<option value="' + t + '"' + (t === f.time ? ' selected' : '') + '>' + planTimeWords(t) + '</option>',
    ).join('') +
    '</select></label><label class="tm-f"><span>Where</span><select name="site"><option value="">Anywhere</option>' +
    (v.places ?? [])
      .map(
        (p) =>
          '<option value="' +
          esc(p.id) +
          '"' +
          (p.id === f.site ? ' selected' : '') +
          '>' +
          esc(p.kind === 'yard' ? 'This yard' : p.name) +
          '</option>',
      )
      .join('') +
    '</select></label><label class="tm-f tp-note"><span>Note</span><input name="note" maxlength="200" autocomplete="off" value="' +
    esc(f.note) +
    '"></label></div>' +
    (f.err ? '<p class="rs-err" role="alert">' + esc(f.err) + '</p>' : '') +
    '<div class="rs-add-acts"><button type="submit" class="tdh-go"' +
    (TP.working ? ' disabled' : '') +
    '>Add the task</button><button type="button" class="tdh-link" data-tp-form-x>Not now</button></div></form>'
  );
}
/** The whole page. @param {any} v GET /api/tasks */
export function tpPageHTML(v) {
  if (!v)
    return (
      '<div class="page-progress tp"><section class="panel"><p class="tm-quiet">' +
      esc(TP.err ?? 'Loading today’s tasks…') +
      '</p></section></div>'
    );
  const day = v.day,
    rel =
      day === v.today
        ? 'Today'
        : day === addDay(v.today, 1)
          ? 'Tomorrow'
          : day === addDay(v.today, -1)
            ? 'Yesterday'
            : '';
  const head =
    '<div class="tp-bar"><div class="tp-date"><button type="button" class="tdh-btn secondary" data-tp-day="' +
    addDay(day, -1) +
    '" aria-label="Previous day">‹</button><span class="tp-date-words"><b>' +
    esc(v.dayLabel) +
    '</b>' +
    (rel ? '<small>' + rel + '</small>' : '') +
    '</span><button type="button" class="tdh-btn secondary" data-tp-day="' +
    addDay(day, 1) +
    '" aria-label="Next day">›</button>' +
    (day !== v.today
      ? '<button type="button" class="tdh-link" data-tp-day="' + esc(v.today) + '">Today</button>'
      : '') +
    '</div><p class="tp-summary" aria-live="polite"><b>' +
    v.summary.done +
    ' of ' +
    v.summary.total +
    ' done</b>' +
    (v.summary.total ? '' : ' · nothing allocated ' + (day === v.today ? 'today' : 'that day')) +
    '</p>' +
    (v.canTask && !TP.form ? '<button type="button" class="tdh-go" data-tp-add>+ Task</button>' : '') +
    '</div>';
  const confirmBox = TP.confirm
    ? '<div class="tp-confirm" role="dialog" aria-label="Tick for them"><p><b>' +
      esc(TP.confirm.name) +
      ' phoned it in?</b> ' +
      esc(TP_STEP_WORDS[TP.confirm.step]) +
      ' on ' +
      esc(TP.confirm.taskName) +
      '.</p><div class="rs-add-acts"><button type="button" class="tdh-go" data-tp-tick-go' +
      (TP.working ? ' disabled' : '') +
      '>Tick it</button><button type="button" class="tdh-link" data-tp-tick-x>No</button></div></div>'
    : '';
  return (
    '<div class="page-progress tp">' +
    head +
    tpFormHTML(v) +
    confirmBox +
    (TP.err ? '<p class="rs-err" role="alert">' + esc(TP.err) + '</p>' : '') +
    (v.workers.length
      ? v.workers.map((w) => tpWorkerHTML(w, v)).join('')
      : '<section class="panel"><p class="tm-quiet">No workers in your team yet. Add them on Workers with +1 worker.</p></section>') +
    '</div>'
  );
}
/** operations.js render(): the view. */
export function tpView() {
  if (TP.host && !TP.data && !TP.busy) tpFetch();
  return tpPageHTML(TP.data);
}
// ---------------------------------------------------------------- listeners
function onClick(e) {
  const b = e.target?.closest?.(
    '[data-tp-day],[data-tp-tick],[data-tp-tick-go],[data-tp-tick-x],[data-tp-add],[data-tp-form-x],[data-tp-pri],[data-tp-list],[data-tp-swap]',
  );
  if (!b || !TP.host || TP.host.view() !== 'PROGRESS') return;
  const d = b.dataset;
  if (d.tpDay !== undefined) {
    tpOpenDay(d.tpDay);
    TP.host.redraw();
    tpFetch();
    return;
  }
  if (d.tpAdd !== undefined) {
    TP.form = { name: '', people: d.tpAdd ? { [d.tpAdd]: 1 } : {}, time: '', site: '', note: '', err: null };
    TP.host.redraw();
    requestAnimationFrame(() => document.querySelector('[data-tp-form] input[name=name]')?.focus());
    return;
  }
  if (d.tpFormX !== undefined) {
    TP.form = null;
    TP.host.redraw();
    return;
  }
  if (d.tpPri !== undefined && TP.form) {
    const n = Number(d.n);
    if (TP.form.people[d.tpPri] === n) delete TP.form.people[d.tpPri];
    else TP.form.people[d.tpPri] = n;
    TP.host.redraw();
    return;
  }
  if (d.tpTick !== undefined) {
    const w = TP.data?.workers.find((x) => x.person === d.person),
      t = w?.tasks.find((x) => x.id === d.tpTick);
    TP.confirm = {
      task: d.tpTick,
      person: d.person,
      step: d.step,
      name: w?.name ?? 'They',
      taskName: t?.name ?? 'the task',
    };
    TP.host.redraw();
    document.querySelector('.tp-confirm')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (d.tpTickX !== undefined) {
    TP.confirm = null;
    TP.host.redraw();
    return;
  }
  if (d.tpTickGo !== undefined && TP.confirm) {
    const c = TP.confirm;
    TP.working = true;
    TP.host.redraw();
    const p =
      c.step === 'DONE'
        ? TP.host.cmd('taskDone', { id: c.task, for: c.person })
        : TP.host.cmd('taskStep', { id: c.task, step: c.step, for: c.person });
    p.then((r) => TP.host.notify(r.message))
      .catch((err) => TP.host.notify(err.message))
      .finally(() => {
        TP.working = false;
        TP.confirm = null;
        TP.json = null;
        tpFetch();
        TP.host.redraw();
      });
    return;
  }
  if (d.tpSwap !== undefined) {
    // off this task (the office picks someone else with + Task or on the list)
    b.disabled = true;
    TP.host
      .cmd('taskUnassign', { id: d.tpSwap, person: d.person, reason: 'can’t make it' })
      .then((r) => TP.host.notify(r.message))
      .catch((err) => TP.host.notify(err.message))
      .finally(() => {
        TP.json = null;
        tpFetch();
      });
    return;
  }
  if (d.tpList !== undefined) TP.host.goItem(d.tpList, d.day);
}
function onInput(e) {
  const t = e.target;
  if (!TP.form || !t?.closest?.('[data-tp-form]') || !t.name) return;
  TP.form[t.name] = t.value;
}
async function onSubmit(e) {
  const f = e.target;
  if (!f?.matches?.('[data-tp-form]') || !TP.host || !TP.form) return;
  e.preventDefault();
  if (TP.working) return;
  const v = Object.fromEntries(new FormData(f)),
    workers = Object.entries(TP.form.people).map(([person, priority]) => ({ person, priority }));
  if (!workers.length) {
    TP.form.err = 'Pick who does it: tap P1, P2 or P3 beside a name.';
    TP.host.redraw();
    return;
  }
  TP.working = true;
  TP.host.redraw();
  try {
    const r = await TP.host.cmd('taskCreate', {
      kind: 'PLAIN',
      day: tpDay(),
      name: v.name,
      time: v.time || null,
      site: v.site || null,
      note: v.note || null,
      workers,
    });
    TP.host.notify(r.message);
    TP.form = null;
  } catch (err) {
    TP.form.err = err.message;
  } finally {
    TP.working = false;
    TP.json = null;
    tpFetch();
    TP.host.redraw();
  }
}
