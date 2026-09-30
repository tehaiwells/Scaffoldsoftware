// @ts-check
// Tasks (owner brief 30 September 2026, Phase 1A part 5 CREW). A task (stored kind 'workTask': 'task' is the engine's movement task) is a gear list to pack and load (kind LIST, linked to its
// MATERIALS plan item) or a plain job (kind PLAIN), on one day, with one or more workers each at a priority 1, 2 or 3 (a worker has at most
// one task per priority and three a day; their phone shows P1, then P2, then P3, no idle between). A LIST task's steps: every worker taps
// "Got the list" (RECEIVED), then any one of them "Packed and ready" (PACKED) and "Truck loaded" (LOADED), which makes it DONE. A PLAIN
// task is done when every worker on it has tapped Done (or the office marks it). Every mark carries who and how (PERSON from a phone,
// ON_BEHALF from the office, ENGINE or SIMULATED in the Practice yard, ADR 0003), like a trip's steps. The day before at 3 pm each worker
// gets one message listing their tasks (TASK_READY, Confirm / Can't make it); at 6 am on the day a notice (TASK_DAY, Got it). The
// business clock only sends, reminds and flags; it never marks a step (the LIVE invariant). The gear-list side calls taskListSync when the
// engine (Practice yard) or a trip step (real yard) packs or loads the list.
import { requireRule, integer } from './geometry.js';
import { AppError } from '../service.js';
import { cached } from '../database.js';
import { bumpRevision } from '../repository.js';
import { addDays, dayLabel } from './schedule.js';
import { DAY_START, SEND_BEFORE, DAY_END, DEFAULT_TIME, parseTime, timeWords } from './plantime.js';
import { ROLE_WORDS } from './team.js';
import {
  crewSend,
  firstName,
  noteOf,
  rosterMethods,
  registerMessageKind,
  seamReady,
  installMessageKindStub,
  installCrewPasses,
  installCrewTick,
  ROSTER_HOOKS,
} from './roster.js';
/** Office commands (operations.manage; taskCreate also a supervisor's for PLAIN tasks at their site). @type {string[]} */
export const TASK_OFFICE_OPS = ['taskCreate', 'taskUpdate', 'taskCancel', 'taskAssign', 'taskUnassign'];
/** Taps a worker makes on their own phone, or the office for them. @type {string[]} */
export const TASK_TAP_OPS = ['taskStep', 'taskDone'];
export const TASK_STEPS = ['RECEIVED', 'PACKED', 'LOADED'];
export const TASK_STEP_WORDS = {
  RECEIVED: 'Got the list',
  PACKED: 'Packed and ready',
  LOADED: 'Truck loaded',
  DONE: 'Done',
};
export const TASK_MAX_PER_DAY = 3,
  TASK_SIM_DONE_MS = 2 * 3600000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** @type {(ms:number)=>string} */
const iso = (ms) => new Date(ms).toISOString();
/** @type {(n:number,one:string,many?:string)=>string} */
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
/** @type {(names:string[])=>string} */
const listWords = (names) =>
  names.length < 2 ? (names[0] ?? '') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
/** @type {(v:unknown)=>string} */
const nameOf = (v) => {
  requireRule(
    typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 60,
    'Give the task a name (up to 60 letters).',
  );
  return String(v).trim().replace(/\s+/g, ' ');
};
const TASK_DAYQ =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='workTask' AND json_extract(data,'$.day')=? ORDER BY rowid";
const TASK_RANGEQ =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='workTask' AND json_extract(data,'$.day') BETWEEN ? AND ? ORDER BY json_extract(data,'$.day'), rowid";
const TASK_LISTQ =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='workTask' AND json_extract(data,'$.list')=? ORDER BY rowid";
const TASK_OPEN_FROM =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='workTask' AND json_extract(data,'$.status')='OPEN' AND json_extract(data,'$.day')>=? ORDER BY json_extract(data,'$.day'), rowid";
const TASK_OPEN_UNTIL =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='workTask' AND json_extract(data,'$.status')='OPEN' AND json_extract(data,'$.day')<=? ORDER BY json_extract(data,'$.day'), rowid";
/** @type {Record<string,any> & ThisType<any>} */
export const taskMethods = {
  // ---------- lookups ----------
  /** @param {unknown} id */
  taskFor(id) {
    requireRule(typeof id === 'string' && id, 'Choose a task.');
    let t = null;
    try {
      t = this.repo.get(id, 'workTask');
    } catch {}
    requireRule(t, 'That task is no longer there.');
    return t;
  },
  /** @param {string} day */
  taskDayRows(day) {
    return this.planRows(TASK_DAYQ, day);
  },
  /** The tasks between two days (the calendar's grid), open or done; cancelled ones left out. @param {string} from @param {string} to */
  taskRangeRows(from, to) {
    return this.planRows(TASK_RANGEQ, from, to).filter((t) => t.status !== 'CANCELLED');
  },
  // The Daily activities calendar's tasks (GET /api/plan, through planMonth): every task on the grid's days as its view, in day, priority
  // and time order. The office sees them all; a supervisor those at their sites (a task with no site is the yard's).
  /** @param {string} from @param {string} to @param {any} ctx */
  taskCalendar(from, to, ctx) {
    const pri = (/** @type {any} */ t) => Math.min(3, ...t.workers.map((/** @type {any} */ w) => w.priority ?? 3));
    return this.taskRangeRows(from, to)
      .filter((t) => ctx.ops || (t.site && ctx.mine.has(t.site)))
      .map((t) => this.taskView(t))
      .sort(
        (a, b) =>
          a.day.localeCompare(b.day) ||
          pri(a) - pri(b) ||
          (a.time ?? '99').localeCompare(b.time ?? '99') ||
          a.name.localeCompare(b.name),
      );
  },
  /** The task of a gear list (its MATERIALS plan item), open first, else the latest; null when none. @param {string} planItemId */
  taskForList(planItemId) {
    const rows = this.planRows(TASK_LISTQ, planItemId);
    return rows.find((t) => t.status === 'OPEN') ?? rows.at(-1) ?? null;
  },
  /** @param {unknown} id */
  taskWorker(id) {
    requireRule(typeof id === 'string' && id, 'Choose someone in your team.');
    let w = null;
    try {
      w = this.repo.get(id, 'resource');
    } catch {}
    requireRule(w && w.type === 'WORKER' && w.enabled, 'Choose someone in your team.');
    return w;
  },
  /** The yard or an active site, or null when none given. @param {unknown} id */
  taskPlace(id) {
    if (id === undefined || id === null || id === '') return null;
    return this.rosterPlace(id).id;
  },
  /** @param {unknown} v */
  taskPriorityOf(v) {
    return integer(v, 'Priority', 1, 3);
  },
  // The clash rules: one task per priority per day, at most three a day.
  /** @param {any} w @param {string} day @param {number} priority @param {string|null} except */
  taskClash(w, day, priority, except) {
    const mine = this.taskDayRows(day).filter(
      (t) => t.status === 'OPEN' && t.id !== except && t.workers.some((/** @type {any} */ x) => x.person === w.id),
    );
    const same = mine.find((t) =>
      t.workers.some((/** @type {any} */ x) => x.person === w.id && x.priority === priority),
    );
    if (same) throw new AppError(409, w.name + ' already has a P' + priority + ' that day: ' + same.name + '.');
    requireRule(mine.length < TASK_MAX_PER_DAY, w.name + ' already has three tasks that day.');
  },
  /** @param {string|null} forPerson */
  taskWho(forPerson) {
    const who = this.dispatchWho(forPerson);
    return {
      at: iso(this.planNow()),
      by: this.user.id,
      byName: who.byName,
      kind: who.kind,
      onBehalfOf: who.onBehalfOf,
    };
  },
  /** A worker row as stored. @param {string} person @param {number} priority */
  taskWorkerRow(person, priority) {
    return { person, priority, steps: {}, message: null, notice: null, notAsked: null, addedAt: iso(this.planNow()) };
  },
  /** The list behind a LIST task (its MATERIALS plan item), or null. @param {any} t */
  taskList(t) {
    if (t.type !== 'LIST' || !t.list) return null;
    try {
      return this.repo.get(t.list, 'planItem');
    } catch {
      return null;
    }
  },
  /** The name a list goes by: its own name (a gear list), else "<site> gear". @param {any} it */
  taskListName(it) {
    return it.name ?? this.planSiteName(it.site) + ' gear';
  },
  // ---------- commands ----------
  // A task on a day for one or more workers: a gear list (its lines, site, time and name come from the list) or a plain job.
  taskCreate(/** @type {any} */ input) {
    requireRule(input && typeof input === 'object', 'Choose a day, a task and who does it.');
    const cal = this.planNowCal(),
      now = this.planNow(),
      ops = this.auth.permissions(this.user).includes('operations.manage'),
      kind = input.kind ?? (input.list ? 'LIST' : 'PLAIN');
    requireRule(kind === 'LIST' || kind === 'PLAIN', 'A task is a gear list or a plain job.');
    const workers = input.workers;
    requireRule(Array.isArray(workers) && workers.length >= 1 && workers.length <= 20, 'Pick who does it.');
    let day,
      name,
      site,
      time,
      list = null;
    if (kind === 'LIST') {
      requireRule(ops, 'Only the office allocates gear lists.');
      const it = this.planItemFor(input.list);
      requireRule(it.type === 'MATERIALS', 'Choose a gear list on the calendar.');
      requireRule(
        !['CANCELLED', 'DONE', 'CALLED_OFF'].includes(it.status),
        'That list is already ' + String(it.status).toLowerCase() + '.',
      );
      day = input.day === undefined || input.day === null ? it.day : this.planDay(input.day, cal);
      requireRule(day === it.day, 'The list is on ' + dayLabel(it.day) + '. Its task goes on that day.');
      list = it.id;
      name = this.taskListName(it);
      site = it.site ?? null;
      time = it.time;
      const had = this.taskForList(it.id);
      if (had && had.status === 'OPEN') {
        // one task per list: a second call adds workers to it
        const names = [];
        for (const x of workers) {
          const w = this.taskWorker(x?.person);
          if (had.workers.some((/** @type {any} */ r) => r.person === w.id)) continue;
          this.taskClash(w, had.day, this.taskPriorityOf(x.priority), had.id);
          had.workers.push(this.taskWorkerRow(w.id, x.priority));
          names.push(w.name);
        }
        this.repo.save(had);
        this.taskAsks(now);
        bumpRevision(this.db, this.repo.company, 'plan');
        return {
          task: this.taskView(this.repo.get(had.id, 'workTask')),
          message: names.length ? listWords(names) + ' added.' : 'Already on it.',
        };
      }
    } else {
      day = this.planDay(input.day, cal);
      name = nameOf(input.name);
      site = this.taskPlace(input.site);
      time = input.time === undefined || input.time === null || input.time === '' ? null : parseTime(input.time);
      if (!ops) {
        // a supervisor: a plain task at one of their own sites, for that site's workers
        requireRule(site, 'Choose your site.');
        this.assertSite(site);
      }
    }
    const rows = [],
      seen = new Set();
    for (const x of workers) {
      const w = this.taskWorker(x?.person);
      requireRule(!seen.has(w.id), w.name + ' is on this twice.');
      seen.add(w.id);
      if (!ops) requireRule(this.teamHome(w) === site, w.name + ' is not at your site.');
      const priority = this.taskPriorityOf(x?.priority);
      this.taskClash(w, day, priority, null);
      rows.push(this.taskWorkerRow(w.id, priority));
    }
    // stored as `type` (a stored object's `kind` is 'workTask'); the views say `kind`
    const t = this.repo.add('workTask', {
      day,
      name,
      type: kind,
      list,
      site,
      time,
      note: noteOf(input.note),
      workers: rows,
      steps: {},
      status: 'OPEN',
      done: null,
      doneAt: null,
      flag: null,
      createdAt: iso(now),
      createdBy: this.user.id,
      cancelledAt: null,
      cancelReason: null,
      log: [{ at: iso(now), text: 'Made by ' + this.user.name + '.' }],
    });
    this.taskAsks(now); // a task made after 3 pm for tomorrow: asked at once
    bumpRevision(this.db, this.repo.company, 'plan');
    const fresh = this.repo.get(t.id, 'workTask');
    return {
      task: this.taskView(fresh),
      message:
        name +
        ' on ' +
        dayLabel(day) +
        (time ? ' at ' + timeWords(time) : '') +
        ': ' +
        listWords(rows.map((r) => this.planName(r.person))) +
        (rows.length === 1 ? ' is' : ' are') +
        ' on it.',
    };
  },
  // A plain task's name, time, site or note (a gear list's follow its list).
  taskUpdate(/** @type {any} */ input) {
    const t = this.taskFor(input?.id),
      now = this.planNow();
    requireRule(t.status === 'OPEN', 'This task is ' + String(t.status).toLowerCase() + '.');
    let changed = false;
    if (t.type === 'PLAIN') {
      if (input.name !== undefined && input.name !== null) {
        const n = nameOf(input.name);
        if (n !== t.name) ((t.name = n), (changed = true));
      }
      if (input.time !== undefined) {
        const tm = input.time === null || input.time === '' ? null : parseTime(input.time);
        if (tm !== t.time) ((t.time = tm), (changed = true));
      }
      if (input.site !== undefined) {
        const s = this.taskPlace(input.site);
        if (s !== t.site) ((t.site = s), (changed = true));
      }
    } else
      requireRule(
        input.name === undefined && input.time === undefined && input.site === undefined,
        'A gear list’s task follows its list. Change the list on Daily activities.',
      );
    if (input.note !== undefined) {
      const n = noteOf(input.note);
      if (n !== t.note) ((t.note = n), (changed = true));
    }
    if (changed) {
      this.taskLog(t, 'Changed by ' + this.user.name + '.', now);
      this.repo.save(t);
      bumpRevision(this.db, this.repo.company, 'plan');
    }
    return {
      task: this.taskView(this.repo.get(t.id, 'workTask')),
      changed,
      message: changed ? 'Saved.' : 'Nothing changed.',
    };
  },
  taskAssign(/** @type {any} */ input) {
    const t = this.taskFor(input?.id),
      w = this.taskWorker(input?.person),
      priority = this.taskPriorityOf(input?.priority),
      now = this.planNow();
    requireRule(t.status === 'OPEN', 'This task is ' + String(t.status).toLowerCase() + '.');
    requireRule(!t.workers.some((/** @type {any} */ r) => r.person === w.id), w.name + ' is already on it.');
    this.taskClash(w, t.day, priority, t.id);
    t.workers.push(this.taskWorkerRow(w.id, priority));
    this.taskLog(t, w.name + ' added (P' + priority + ').', now);
    this.repo.save(t);
    this.taskAsks(now);
    bumpRevision(this.db, this.repo.company, 'plan');
    return { task: this.taskView(this.repo.get(t.id, 'workTask')), message: w.name + ' is on it.' };
  },
  // Off a task: refused once they have tapped a step (force: true from the office overrides).
  taskUnassign(/** @type {any} */ input) {
    const t = this.taskFor(input?.id),
      now = this.planNow(),
      row = t.workers.find((/** @type {any} */ r) => r.person === input?.person);
    requireRule(row, 'They are not on this task.');
    requireRule(t.status === 'OPEN', 'This task is ' + String(t.status).toLowerCase() + '.');
    requireRule(
      input.force === true || !Object.keys(row.steps ?? {}).length,
      this.planName(row.person) + ' has already started it.',
    );
    this.taskDrop(t, row, input.reason ?? 'taken off by ' + this.user.name, now);
    this.repo.save(t);
    bumpRevision(this.db, this.repo.company, 'plan');
    return { task: this.taskView(this.repo.get(t.id, 'workTask')), message: this.planName(row.person) + ' taken off.' };
  },
  /** @param {any} t @param {any} row @param {string} why @param {number} now */
  taskDrop(t, row, why, now) {
    if (row.message) this.planCallOff(row.message, 'Taken off the task', now);
    t.workers = t.workers.filter((/** @type {any} */ r) => r !== row);
    this.taskLog(t, this.planName(row.person) + ' off: ' + why + '.', now);
  },
  taskCancel(/** @type {any} */ input) {
    const t = this.taskFor(input?.id),
      now = this.planNow();
    requireRule(t.status === 'OPEN', 'This task is already ' + String(t.status).toLowerCase() + '.');
    if (t.type === 'LIST') {
      const it = this.taskList(t);
      requireRule(
        !it || ['CANCELLED', 'DONE'].includes(it.status),
        'Cancel the gear list on Daily activities: its task goes with it.',
      );
    }
    this.taskClose(t, 'CANCELLED', noteOf(input.reason) ?? 'Cancelled by ' + this.user.name, now);
    this.repo.save(t);
    bumpRevision(this.db, this.repo.company, 'plan');
    return { task: this.taskView(this.repo.get(t.id, 'workTask')), message: 'Cancelled: ' + t.name + '.' };
  },
  /** @param {any} t @param {string} status @param {string} why @param {number} now */
  taskClose(t, status, why, now) {
    for (const r of t.workers) {
      if (r.message) this.planCallOff(r.message, why, now);
      if (r.notice) this.planCallOff(r.notice, why, now);
    }
    t.status = status;
    t.cancelledAt = iso(now);
    t.cancelReason = why;
    t.flag = null;
    this.taskLog(t, 'Cancelled: ' + why + '.', now);
  },
  // A step of a gear-list task: Got the list (each worker), Packed and ready (once, by anyone on it), Truck loaded (once; the task is done).
  // From a phone the tapping worker's own; from the office `for` the worker (ON_BEHALF). Order enforced; a step already there is 409 with its time.
  taskStep(/** @type {any} */ input) {
    let t = this.taskFor(input?.id);
    const step = input?.step,
      now = this.planNow(),
      today = this.planToday(now);
    requireRule(TASK_STEPS.includes(step), 'Choose Got the list, Packed and ready or Truck loaded.');
    requireRule(t.type === 'LIST', 'A plain task has one Done.');
    requireRule(t.status === 'OPEN', 'This task is already ' + String(t.status).toLowerCase() + '.');
    requireRule(t.day <= today, 'Not today yet.');
    const it = this.taskList(t);
    requireRule(!it || it.status !== 'CANCELLED', 'The list was cancelled.');
    const { row, mark } = this.taskTapper(t, input.for ?? null);
    if (step === 'RECEIVED') {
      this.taskNotYet(row.steps.RECEIVED, 'Got the list');
      row.steps.RECEIVED = mark;
      this.taskLog(t, this.planName(row.person) + ' got the list.', now);
    } else if (step === 'PACKED') {
      requireRule(row.steps.RECEIVED, 'Tap Got the list first.');
      this.taskNotYet(t.steps.PACKED, 'Packed and ready');
      t.steps.PACKED = mark;
      this.taskLog(t, 'Packed and ready (' + mark.byName + ').', now);
      // saved before the trip hears of it: the trip's pack tells the task again through taskListSync (which keeps this mark), so the
      // row is read fresh after that, never saved stale
      this.repo.save(t);
      this.taskPackTrip(t, it, input, now);
      t = this.repo.get(t.id, 'workTask');
    } else {
      requireRule(row.steps.RECEIVED, 'Tap Got the list first.');
      requireRule(t.steps.PACKED, 'Tap Packed and ready first.');
      this.taskNotYet(t.steps.LOADED, 'Truck loaded');
      t.steps.LOADED = mark;
      this.taskFinish(t, mark, now, 'Truck loaded (' + mark.byName + ').');
    }
    this.repo.save(t);
    bumpRevision(this.db, this.repo.company, 'plan');
    return {
      task: this.taskView(this.repo.get(t.id, 'workTask')),
      message: step === 'LOADED' ? 'Truck loaded. Done.' : TASK_STEP_WORDS[step] + '.',
    };
  },
  /** @param {any} mark @param {string} words */
  taskNotYet(mark, words) {
    if (!mark) return;
    throw Object.assign(new AppError(409, words + ': already done at ' + this.tripHm(Date.parse(mark.at)) + '.'), {
      code: 'ALREADY_DONE',
      detail: { at: mark.at, byName: mark.byName },
    });
  },
  // Who is tapping: the phone's own person (must be on the task), or the office for a named worker on it.
  /** @param {any} t @param {string|null} forPerson */
  taskTapper(t, forPerson) {
    const phone = this.dispatchPhone();
    const person = phone ? phone.id : forPerson;
    requireRule(typeof person === 'string' && person, 'Say who did it.');
    const row = t.workers.find((/** @type {any} */ r) => r.person === person);
    if (!row)
      throw new AppError(
        404,
        phone ? 'Record not found in your company.' : this.planName(person) + ' is not on this task.',
      );
    return { row, mark: this.taskWho(phone ? null : person) };
  },
  // Packed and ready by a yard hand's phone (packs.confirm) in a real yard also records the pack on the list's trip, as the phone's own
  // Packed tap would; a pack already confirmed keeps the task's mark.
  /** @param {any} t @param {any} it @param {any} input @param {number} now */
  taskPackTrip(t, it, input, now) {
    if (!this.live() || !it?.order) return;
    if (!this.auth.permissions(this.user).includes('packs.confirm')) return;
    let trip = null;
    try {
      const o = this.repo.get(it.order, 'order');
      trip = o.trip ? this.repo.get(o.trip, 'trip') : null;
    } catch {}
    if (!trip || trip.state !== 'BOOKED') return;
    let words;
    try {
      this.packConfirmed({ trip: trip.id, ...(Array.isArray(input.lines) ? { lines: input.lines } : {}) });
      words = 'Pack recorded on ' + this.tripLabel(trip) + '.';
    } catch (/** @type {any} */ e) {
      if (!e?.status) throw e;
      if (e.code !== 'ALREADY_CONFIRMED') words = 'Pack not recorded on the trip: ' + e.message;
    }
    if (!words) return;
    const fresh = this.repo.get(t.id, 'workTask'); // the trip's pack came back through taskListSync: log on the row as it is now
    this.taskLog(fresh, words, now);
    this.repo.save(fresh);
  },
  /** @param {any} t @param {any} mark @param {number} now @param {string} words */
  taskFinish(t, mark, now, words) {
    t.status = 'DONE';
    t.done = mark;
    t.doneAt = iso(now);
    t.flag = null;
    this.taskLog(t, words, now);
    for (const r of t.workers) this.taskCloseMsg(r.notice, now);
  },
  /** A notice that no longer needs a Got it. @param {string|null} id @param {number} now */
  taskCloseMsg(id, now) {
    const m = id ? this.planMsg(id) : null;
    if (!m || m.closedAt || !['SENT', 'YES', 'NO'].includes(m.status)) return;
    m.closedAt = iso(now);
    this.repo.save(m);
  },
  // Done: a plain task's worker (their own tap, or the office for them, or all: true for everyone), or a gear-list task phoned in to the office.
  taskDone(/** @type {any} */ input) {
    const t = this.taskFor(input?.id),
      now = this.planNow(),
      today = this.planToday(now),
      phone = this.dispatchPhone();
    requireRule(t.status === 'OPEN', 'This task is already ' + String(t.status).toLowerCase() + '.');
    requireRule(t.day <= today, 'Not today yet.');
    const note = noteOf(input.note);
    if (t.type === 'LIST') {
      requireRule(!phone, 'Tap the steps: Got the list, Packed and ready, Truck loaded.');
      const forPerson = typeof input.for === 'string' ? input.for : (t.workers[0]?.person ?? null),
        mark = this.taskWho(forPerson);
      for (const r of t.workers) r.steps.RECEIVED ??= mark;
      t.steps.PACKED ??= mark;
      t.steps.LOADED ??= mark;
      this.taskFinish(t, { ...mark, note }, now, 'Phoned in as done (' + mark.byName + ').');
    } else if (phone || (typeof input.for === 'string' && input.for)) {
      const { row, mark } = this.taskTapper(t, input.for ?? null);
      this.taskNotYet(row.steps.DONE, 'Done');
      row.steps.DONE = { ...mark, note };
      this.taskLog(t, this.planName(row.person) + ' done.', now);
      if (t.workers.every((/** @type {any} */ r) => r.steps.DONE))
        this.taskFinish(t, mark, now, 'Done: everyone on it.');
    } else {
      requireRule(input.all === true, 'Say who did it, or tick All done.');
      const mark = this.taskWho(null);
      for (const r of t.workers) r.steps.DONE ??= { ...mark, note };
      this.taskFinish(t, { ...mark, note }, now, 'Marked done by ' + mark.byName + '.');
    }
    this.repo.save(t);
    bumpRevision(this.db, this.repo.company, 'plan');
    return {
      task: this.taskView(this.repo.get(t.id, 'workTask')),
      message: t.status === 'DONE' ? t.name + ' is done.' : 'Done. Waiting for the others on it.',
    };
  },
  /** @param {any} t @param {string} text @param {number} now */
  taskLog(t, text, now) {
    const log = t.log ?? [];
    if (log.at(-1)?.text === text) return;
    t.log = [...log, { at: iso(now), text }].slice(-20);
  },
  // ---------- the gear list's hooks (the engine in the Practice yard, a trip's steps in a real yard, cancel and move) ----------
  /** @param {string} planItemId @param {'RECEIVED'|'PACKED'|'LOADED'|'CANCELLED'|'MOVED'} step @param {number} now @param {any} [mark] */
  taskListSync(planItemId, step, now, mark = null) {
    const t = this.taskForList(planItemId);
    if (!t || t.status !== 'OPEN') return null;
    const m = mark ?? { at: iso(now), by: null, byName: 'The yard', kind: 'ENGINE', onBehalfOf: null };
    if (step === 'RECEIVED') for (const r of t.workers) r.steps.RECEIVED ??= m;
    else if (step === 'PACKED') {
      for (const r of t.workers) r.steps.RECEIVED ??= m;
      t.steps.PACKED ??= m;
      this.taskLog(t, 'Packed (' + m.byName + ').', now);
    } else if (step === 'LOADED') {
      for (const r of t.workers) r.steps.RECEIVED ??= m;
      t.steps.PACKED ??= m;
      t.steps.LOADED ??= m;
      this.taskFinish(t, m, now, 'Truck loaded (' + m.byName + ').');
    } else if (step === 'CANCELLED') this.taskClose(t, 'CANCELLED', 'The list was cancelled', now);
    else if (step === 'MOVED') {
      const it = this.taskList(t);
      if (it) {
        for (const r of t.workers) {
          if (r.message) this.planCallOff(r.message, 'The list moved to ' + dayLabel(it.day), now);
          r.message = null;
          r.notAsked = null;
          if (r.notice && it.day !== t.day) {
            this.planCallOff(r.notice, 'The list moved', now);
            r.notice = null;
          }
        }
        t.day = it.day;
        t.time = it.time;
        t.site = it.site ?? null;
        t.name = this.taskListName(it);
        t.flag = null;
        this.taskLog(t, 'Follows the list: ' + dayLabel(it.day) + ' at ' + timeWords(it.time) + '.', now);
      }
    }
    this.repo.save(t);
    bumpRevision(this.db, this.repo.company, 'plan');
    return t;
  },
  // Someone left the team: off every open task from today where they had not started; their asks called off. A task left with nobody stays open.
  /** @param {string} id @param {number} now */
  taskPersonGone(id, now) {
    const today = this.planToday(now);
    let n = 0;
    for (const t of this.planRows(TASK_OPEN_FROM, today)) {
      const row = t.workers.find((/** @type {any} */ r) => r.person === id);
      if (!row || Object.keys(row.steps ?? {}).length) continue;
      this.taskDrop(t, row, 'left the team', now);
      this.repo.save(t);
      n++;
    }
    return n;
  },
  // Taken off the roster that day: off the tasks that day they had not started.
  /** @param {string} person @param {string} day @param {number} now */
  taskRosterCleared(person, day, now) {
    for (const t of this.taskDayRows(day)) {
      if (t.status !== 'OPEN') continue;
      const row = t.workers.find((/** @type {any} */ r) => r.person === person);
      if (!row || Object.keys(row.steps ?? {}).length) continue;
      this.taskDrop(t, row, 'not rostered', now);
      this.repo.save(t);
    }
  },
  // ---------- the clock's duties: one day-before ask and one day-of notice per worker per day, the day-end flag ----------
  /** @param {number} now */
  taskAsks(now) {
    const today = this.planToday(now),
      tomorrow = addDays(today, 1),
      sendAt = this.planAt(today, SEND_BEFORE);
    let sent = 0;
    for (const day of [today, tomorrow]) {
      if (day === tomorrow && now < sendAt) continue;
      const tasks = this.taskDayRows(day).filter((t) => t.status === 'OPEN'),
        begun = now >= this.planAt(day, DAY_START);
      // the day-before ask (TASK_READY): one message per person listing every task of theirs that day
      const people = new Map();
      for (const t of tasks)
        for (const r of t.workers) {
          if (r.message || r.notAsked) continue;
          if (!people.has(r.person)) people.set(r.person, []);
          people.get(r.person).push([t, r]);
        }
      for (const [person, rows] of people) {
        const p = this.teamPerson(person);
        if (!p) continue;
        if (begun) {
          for (const [t, r] of rows) {
            r.notAsked = iso(now);
            this.repo.save(t);
          }
          if (rows.some(([, r]) => Date.parse(r.addedAt ?? 0) < this.planAt(day, DAY_START)))
            this.notify(
              'Not asked in time',
              p.name + " wasn't asked about " + (day === today ? "today's" : "tomorrow's") + ' tasks. Call them.',
              null,
            );
          continue;
        }
        const first = rows.sort((a, b) => a[1].priority - b[1].priority)[0][0];
        const id = crewSend(this, {
          kind: 'task',
          id: first.id,
          person,
          subject: 'TASK_READY',
          day,
          time: first.time ?? DEFAULT_TIME,
          site: this.taskSiteOf(first),
          needsAnswer: true,
          now,
        });
        for (const [t, r] of rows) {
          r.message = id;
          this.repo.save(t);
        }
        if (id) sent++;
      }
      // the day-of notice (TASK_DAY) once the day has begun
      if (day === today && begun) {
        const noticed = new Map();
        for (const t of tasks)
          for (const r of t.workers) {
            if (r.notice) continue;
            if (!noticed.has(r.person)) noticed.set(r.person, []);
            noticed.get(r.person).push([t, r]);
          }
        for (const [person, rows] of noticed) {
          if (!this.teamPerson(person)) continue;
          const first = rows.sort((a, b) => a[1].priority - b[1].priority)[0][0];
          const id = crewSend(this, {
            kind: 'task',
            id: first.id,
            person,
            subject: 'TASK_DAY',
            day,
            time: first.time ?? DEFAULT_TIME,
            site: this.taskSiteOf(first),
            needsAnswer: false,
            now,
            quiet: true,
          });
          for (const [t, r] of rows) {
            r.notice = id;
            this.repo.save(t);
          }
        }
      }
    }
    this.taskFlags(now, today);
    if (!this.live()) this.taskSimDone(now, today);
    return sent;
  },
  /** The site of a task for a message (null at the yard). @param {any} t */
  taskSiteOf(t) {
    if (!t.site) return null;
    try {
      return this.repo.get(t.site, 'site').id;
    } catch {
      return null;
    }
  },
  // The day ended and the task is still open: flagged "not confirmed", said once, never done.
  /** @param {number} now @param {string} today */
  taskFlags(now, today) {
    for (const t of this.planRows(TASK_OPEN_UNTIL, today)) {
      if (t.flag || now < this.planAt(t.day, DAY_END)) continue;
      t.flag = { code: 'NOT_CONFIRMED', since: iso(now), words: 'not confirmed by the end of the day' };
      this.taskLog(t, 'Not confirmed by the end of the day.', now);
      this.repo.save(t);
      this.notify(
        'Not confirmed',
        t.name + ' on ' + dayLabel(t.day) + ': nobody confirmed it was done. See Task progress.',
        this.taskSiteOf(t),
      );
    }
  },
  // The Practice yard: simulated workers tap Done on a plain task two hours after its time (deterministic; off with the demo answers switch).
  /** @param {number} now @param {string} today */
  taskSimDone(now, today) {
    if (this.live()) return;
    const cfg = this.repo.all('config')[0];
    if (cfg?.planReplies === false) return;
    for (const t of this.taskDayRows(today)) {
      if (t.status !== 'OPEN' || t.type !== 'PLAIN' || t.flag || !t.time) continue; // no time: left for a person
      const at = this.planAt(t.day, t.time) + TASK_SIM_DONE_MS;
      if (now < at || Date.parse(t.createdAt) >= at) continue; // a task made after that moment waits for a person
      const mark = { at: iso(at), by: null, byName: 'the crew (simulated)', kind: 'SIMULATED', onBehalfOf: null };
      for (const r of t.workers) r.steps.DONE ??= { ...mark, byName: this.planName(r.person) + ' (simulated)' };
      this.taskFinish(t, mark, at, 'Done (simulated).');
      this.repo.save(t);
    }
  },
  // ---------- views ----------
  /** The answer a worker's day-before ask stands at: YES, NO, WAITING, NO_ANSWER, NOT_ASKED or null (not sent yet). @param {any} r @param {number} now */
  taskAnswer(r, now) {
    if (r.notAsked) return 'NOT_ASKED';
    const m = r.message ? this.planMsg(r.message) : null;
    if (!m) return null;
    const a = this.planAnswerOf(m, now);
    return a === 'NOT_SENT' ? null : a;
  },
  /** The next step this worker taps, or null when their part is done. @param {any} t @param {any} r */
  taskNext(t, r) {
    if (t.status !== 'OPEN') return null;
    if (t.type === 'PLAIN') return r.steps.DONE ? null : 'DONE';
    if (!r.steps.RECEIVED) return 'RECEIVED';
    if (!t.steps.PACKED) return 'PACKED';
    if (!t.steps.LOADED) return 'LOADED';
    return null;
  },
  /** @param {any} t */
  taskView(t) {
    const now = this.planNow(),
      today = this.planToday(now),
      it = this.taskList(t),
      lines = it
        ? (it.lines ?? []).map((/** @type {any} */ l) => ({
            product: l.product,
            name: this.planName(l.product, 'material'),
            quantity: l.quantity,
          }))
        : [];
    const workers = t.workers.map((/** @type {any} */ r) => {
      const steps =
        t.type === 'LIST'
          ? {
              RECEIVED: r.steps.RECEIVED ?? null,
              PACKED: t.steps.PACKED ?? null,
              LOADED: t.steps.LOADED ?? null,
              DONE: t.done ?? null,
            }
          : { DONE: r.steps.DONE ?? null };
      const next = this.taskNext(t, r);
      return {
        person: r.person,
        name: this.planName(r.person),
        priority: r.priority,
        steps,
        next,
        nextWords: next ? TASK_STEP_WORDS[next] : null,
        done: !next,
        answer: this.taskAnswer(r, now),
        reason: r.message ? (this.planMsg(r.message)?.answer?.reason ?? null) : null,
        message: r.message ?? null,
        notice: r.notice ?? null,
        noticeSeen: r.notice ? !!this.planMsg(r.notice)?.seenAt : false,
        canTap: t.status === 'OPEN' && t.day <= today && !!next,
      };
    });
    const total = t.type === 'LIST' ? t.workers.length + 2 : t.workers.length,
      done =
        t.type === 'LIST'
          ? t.workers.filter((/** @type {any} */ r) => r.steps.RECEIVED).length +
            (t.steps.PACKED ? 1 : 0) +
            (t.steps.LOADED ? 1 : 0)
          : t.workers.filter((/** @type {any} */ r) => r.steps.DONE).length;
    return {
      id: t.id,
      day: t.day,
      dayLabel: dayLabel(t.day),
      name: t.name,
      kind: t.type,
      kindWords: t.type === 'LIST' ? 'pack + load' : 'task',
      list: t.list ?? null,
      listWords: it ? this.taskListName(it) + ' · ' + this.taskListRoute(it) : null,
      listStatus: it?.status ?? null,
      site: t.site ?? null,
      siteName: t.site ? this.planName(t.site, 'the yard') : 'the yard',
      time: t.time ?? null,
      timeWords: t.time ? timeWords(t.time) : null,
      note: t.note ?? null,
      status: t.status,
      workers,
      steps: t.type === 'LIST' ? { PACKED: t.steps.PACKED ?? null, LOADED: t.steps.LOADED ?? null } : {},
      done: t.done ?? null,
      doneAt: t.doneAt ?? null,
      flag: t.flag ?? null,
      lines,
      progress: { done, total },
      log: t.log ?? [],
    };
  },
  /** "the yard → Bondi" for a list (a gear list's from/to when it has them, else yard → site). @param {any} it */
  taskListRoute(it) {
    const from =
        it.direction === 'BACK'
          ? this.planSiteName(it.site)
          : it.fromSite
            ? this.planSiteName(it.fromSite)
            : 'the yard',
      to = it.direction === 'BACK' ? 'the yard' : this.planSiteName(it.site);
    return from + ' → ' + to;
  },
  // GET /api/tasks?day=: every worker with their tasks that day in priority order (the Task progress page; polled every second, so it reads
  // one day's tasks by index). A supervisor sees their sites' workers only, read-only.
  /** @param {{day?:string|null}} q */
  tasksView({ day = null } = {}) {
    this.planScopeCheck();
    const ctx = this.planCtx(),
      d = day && DAY.test(day) ? day : ctx.today,
      now = ctx.now;
    const tasks = this.taskDayRows(d)
      .filter((t) => t.status !== 'CANCELLED')
      .map((t) => this.taskView(t));
    const kinds = this.placeKinds(),
      team = this.teamWorkers(kinds).filter((w) => ctx.ops || ctx.mine.has(this.teamHome(w)));
    const byPerson = new Map(team.map((w) => [w.id, w]));
    for (const t of tasks)
      for (const x of t.workers)
        if (!byPerson.has(x.person) && (ctx.ops || ctx.mine.has(t.site)))
          byPerson.set(x.person, this.teamPerson(x.person) ?? { id: x.person, name: x.name, gone: true });
    const roster = new Map(this.rosterDayRows(d).map((r) => [r.person, r]));
    const workers = [...byPerson.values()]
      .map((w) => {
        const mine = tasks
          .filter((t) => t.workers.some((x) => x.person === w.id))
          .sort(
            (a, b) =>
              a.workers.find((x) => x.person === w.id).priority - b.workers.find((x) => x.person === w.id).priority,
          );
        const r = roster.get(w.id),
          role = w.gone ? null : this.roleOf(w, kinds);
        return {
          person: w.id,
          name: w.name,
          role,
          roleWords: role ? ROLE_WORDS[role] : 'Left the team',
          where: w.gone ? null : this.rosterWhereOf(w),
          whereName: w.gone ? null : this.planName(this.rosterWhereOf(w), 'the yard'),
          mobile: ctx.ops ? (w.mobile ?? null) : null,
          rostered: r && r.status !== 'REMOVED' ? r.status : null,
          rosterAnswer: r && r.status !== 'REMOVED' ? this.rosterRowView(r, now).answer : null,
          answer: mine.map((t) => t.workers.find((x) => x.person === w.id).answer).find((a) => a) ?? null,
          tasks: mine,
          done: mine.filter((t) => t.status === 'DONE').length,
        };
      })
      .sort(
        (a, b) =>
          Number(!a.tasks.length) - Number(!b.tasks.length) ||
          a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
    return {
      day: d,
      dayLabel: dayLabel(d),
      today: ctx.today,
      now: iso(now),
      dayOver: now >= this.planAt(d, DAY_END),
      workers,
      summary: { done: tasks.filter((t) => t.status === 'DONE').length, total: tasks.length },
      canPlan: ctx.ops,
      canTask: ctx.perms.includes('requests.create') || ctx.ops,
      places: ctx.ops
        ? [
            ...this.repo.all('yard').map((y) => ({ id: y.id, name: y.name, kind: 'yard' })),
            ...[...ctx.sites.values()]
              .filter((s) => s.status === 'ACTIVE')
              .map((s) => ({ id: s.id, name: s.name, kind: 'site' }))
              .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
          ]
        : [],
      team: team
        .map((w) => ({ id: w.id, name: w.name, role: this.roleOf(w, kinds) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
      lists: ctx.ops
        ? this.planDayItems(d, 'MATERIALS')
            .filter((it) => !['CANCELLED', 'DONE'].includes(it.status))
            .map((it) => ({
              id: it.id,
              name: this.taskListName(it),
              route: this.taskListRoute(it),
              time: it.time,
              task: this.taskForList(it.id)?.id ?? null,
            }))
        : [],
    };
  },
  // A person's own day for their phone: today's tasks in priority order (the first not done is "now"), and tomorrow's.
  /** @param {string} person @param {string} today */
  taskMyDay(person, today) {
    const mine = (/** @type {string} */ day) =>
      this.taskDayRows(day)
        .filter((t) => t.status !== 'CANCELLED' && t.workers.some((/** @type {any} */ r) => r.person === person))
        .map((t) => {
          const v = this.taskView(t),
            me = v.workers.find((x) => x.person === person);
          return { ...v, mine: me, priority: me.priority, now: false };
        })
        .sort((a, b) => a.priority - b.priority);
    const tasks = mine(today),
      first = tasks.find((t) => !t.mine.done);
    if (first) first.now = true;
    return { today, tasks, tomorrow: mine(addDays(today, 1)) };
  },
  // GET /api/prestart?day=: the printable sheet's data. Every rostered or tasked worker with their day in order, then the drivers' trips.
  /** @param {{day?:string|null}} q */
  prestartView({ day = null } = {}) {
    this.planScopeCheck();
    const ctx = this.planCtx(),
      d = day && DAY.test(day) ? day : ctx.today,
      now = ctx.now,
      kinds = this.placeKinds();
    const tasks = this.taskDayRows(d)
      .filter((t) => t.status !== 'CANCELLED')
      .map((t) => this.taskView(t));
    const roster = new Map(
      this.rosterDayRows(d)
        .filter((r) => r.status !== 'REMOVED')
        .map((r) => [r.person, r]),
    );
    const ids = new Set([...roster.keys(), ...tasks.flatMap((t) => t.workers.map((x) => x.person))]);
    const workers = [...ids]
      .map((id) => {
        const w = this.teamPerson(id);
        if (!w || w.kind === 'driver') return null;
        if (!ctx.ops && !ctx.mine.has(this.teamHome(w))) return null;
        const r = roster.get(id),
          role = this.roleOf(w, kinds),
          mine = tasks
            .filter((t) => t.workers.some((x) => x.person === id))
            .sort(
              (a, b) =>
                a.workers.find((x) => x.person === id).priority - b.workers.find((x) => x.person === id).priority,
            );
        return {
          person: id,
          name: w.name,
          role,
          roleWords: ROLE_WORDS[role],
          where: r ? this.planName(r.where, 'the yard') : this.planName(this.rosterWhereOf(w), 'the yard'),
          time: r ? (r.time ?? DEFAULT_TIME) : null,
          timeWords: r ? timeWords(r.time ?? DEFAULT_TIME) : null,
          rostered: r ? r.status : null,
          rosteredWords: r
            ? r.status === 'CONFIRMED'
              ? 'Confirmed'
              : r.status === 'DENIED'
                ? 'Can’t work'
                : 'Rostered'
            : 'Not rostered',
          answer: r ? this.rosterRowView(r, now).answer : null,
          tasks: mine.map((t) => {
            const me = t.workers.find((x) => x.person === id);
            return {
              id: t.id,
              priority: me.priority,
              name: t.name,
              kind: t.type,
              kindWords: t.kindWords,
              time: t.time,
              timeWords: t.timeWords,
              where: t.siteName,
              lines: t.lines,
              note: t.note,
              status: t.status,
              workersWith: t.workers.filter((x) => x.person !== id).map((x) => x.name),
            };
          }),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const drivers = ctx.ops
      ? this.planDayItems(d, 'TRUCK')
          .filter((b) => !['CANCELLED', 'DRAFT'].includes(b.status) && b.driver)
          .map((b) => {
            const trips = this.live()
              ? this.tripRows(
                  'trip',
                  "json_extract(data,'$.truckPlan')=? AND json_extract(data,'$.state')<>'CANCELLED'",
                  b.id,
                )
                  .sort(
                    (x, y) => String(x.time ?? b.time).localeCompare(String(y.time ?? b.time)) || x.number - y.number,
                  )
                  .map((t) => ({
                    time: t.time ?? b.time,
                    timeWords: timeWords(t.time ?? b.time),
                    words:
                      (t.direction === 'BACK'
                        ? 'Bring back from '
                        : t.direction === 'MOVE'
                          ? 'Move to '
                          : 'Deliver to ') + this.planSiteName(t.site),
                    siteName: this.planSiteName(t.site),
                  }))
              : this.planDayItems(d, 'MATERIALS')
                  .filter((it) => it.truckPlan === b.id && it.status !== 'CANCELLED')
                  .sort((x, y) => String(x.time).localeCompare(String(y.time)))
                  .map((it) => ({
                    time: it.time,
                    timeWords: timeWords(it.time),
                    words: (it.direction === 'BACK' ? 'Bring back from ' : 'Deliver to ') + this.planSiteName(it.site),
                    siteName: this.planSiteName(it.site),
                  }));
            return {
              person: b.driver,
              name: this.planName(b.driver, 'Driver'),
              truck: b.truck ? this.planName(b.truck, 'Truck') : 'Hire truck',
              time: b.time,
              timeWords: timeWords(b.time),
              answer: this.planAnswerOf(this.planMsg(b.message), now),
              trips,
            };
          })
          .sort((a, b) => a.time.localeCompare(b.time))
      : [];
    return {
      day: d,
      dayLabel: dayLabel(d),
      today: ctx.today,
      company: this.planCompany(),
      printedAt: iso(now),
      printedBy: this.user.name ?? null,
      workers,
      drivers,
      summary: { workers: workers.length, tasks: tasks.length, done: tasks.filter((t) => t.status === 'DONE').length },
    };
  },
};
// The hooks of the TASK_READY ask and the TASK_DAY notice (registered by installCrew).
export const TASK_HOOKS = {
  /** @param {any} sim @param {any} m */
  rows(sim, m) {
    return sim
      .taskDayRows(m.day)
      .filter(
        (/** @type {any} */ t) =>
          t.status === 'OPEN' && t.workers.some((/** @type {any} */ r) => r.person === m.person),
      )
      .map((/** @type {any} */ t) => [t, t.workers.find((/** @type {any} */ r) => r.person === m.person)])
      .sort((/** @type {any} */ a, /** @type {any} */ b) => a[1].priority - b[1].priority);
  },
  /** @param {any} sim @param {any} m */
  isOpen(sim, m) {
    return m.day >= sim.planToday(sim.planNow()) && TASK_HOOKS.rows(sim, m).length > 0;
  },
  /** @param {any} sim @param {any} m */
  deadline(sim, m) {
    const rows = TASK_HOOKS.rows(sim, m),
      first = rows.find(([t]) => t.time)?.[0];
    return sim.planAt(m.day, first?.time ?? DAY_START);
  },
  /** "P1 pack Bondi gear (7:00 am, the yard), P2 Sweep the racks (9:00 am)". @param {any} sim @param {any} m */
  list(sim, m) {
    return TASK_HOOKS.rows(sim, m)
      .map(
        ([t, r]) =>
          'P' +
          r.priority +
          ' ' +
          (t.type === 'LIST' ? 'pack ' : '') +
          t.name +
          (t.time || t.site
            ? ' (' +
              [t.time ? timeWords(t.time) : '', t.site ? sim.planName(t.site, 'the yard') : 'the yard']
                .filter(Boolean)
                .join(', ') +
              ')'
            : ''),
      )
      .join(', ');
  },
  /** @param {any} sim @param {any} m */
  text(sim, m) {
    const tomorrow = m.day === addDays(sim.planToday(sim.planNow()), 1);
    if (m.subject === 'TASK_DAY')
      return 'Today: ' + TASK_HOOKS.list(sim, m) + '. Tap each step on your phone as you go. – ' + sim.planCompany();
    return (
      'Hi ' +
      firstName(m.personName) +
      ', ' +
      (tomorrow ? 'tomorrow' : dayLabel(m.day)) +
      ': ' +
      TASK_HOOKS.list(sim, m) +
      '. Ready? Please reply Confirm or Can’t make it. – ' +
      sim.planCompany()
    );
  },
  /** @param {any} sim @param {any} m */
  summary(sim, m) {
    const n = TASK_HOOKS.rows(sim, m).length;
    return (
      (m.subject === 'TASK_DAY' ? 'Told ' : 'Asked ') +
      (m.personName || 'someone') +
      ' about ' +
      plural(n, 'task') +
      ' on ' +
      dayLabel(m.day) +
      '.'
    );
  },
  /** @param {any} sim @param {any} m @param {number} at */
  onAnswer(sim, m, at) {
    bumpRevision(sim.db, sim.repo.company, 'plan');
    if (m.answer?.yes) return;
    sim.notify(
      'Can’t make it',
      (m.personName || 'Someone') +
        ' can’t make it on ' +
        dayLabel(m.day) +
        (m.answer?.reason ? ': ' + m.answer.reason : '') +
        '. Swap them on Task progress.',
      m.site ?? null,
    );
  },
};
// Mixes the roster and the tasks into the Simulation and registers their message kinds. While plan.js has no message-kind registry yet
// (the gear-list seam), the stub answers roster and task asks and the passes run the fill and the asks after the clock's own pass.
/** @param {any} proto */
export function installCrew(proto) {
  Object.assign(proto, rosterMethods, taskMethods);
  registerMessageKind('rosterDay', ROSTER_HOOKS);
  registerMessageKind('task', TASK_HOOKS);
  if (!seamReady()) {
    installMessageKindStub(proto);
    installCrewPasses(proto);
  } else installCrewTick(proto);
}
