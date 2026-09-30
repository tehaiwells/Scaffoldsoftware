// @ts-check
// The workers' roster (owner brief 30 September 2026, Phase 1A part 5 CREW). One record per person per day (kind 'rosterDay'): picked on the
// calendar by the office, or filled from a pattern (Mon–Fri / Mon–Sat, kind 'rosterPattern') never further than 14 days ahead (the fortnight
// rule: each day the clock extends the window by one day, so firing someone only ever undoes two weeks). The day before a rostered day at
// 3 pm company time the person is asked "You're on tomorrow, confirm or deny"; their answer (their phone, the office for them, or the
// Practice yard's simulated reply) sets the day CONFIRMED or DENIED at once. Rostering is record keeping: LIVE and DEMO behave the same, and
// the business clock only fills the window and sends the asks (the LIVE invariant: it never confirms or denies).
// Mixed into Simulation.prototype by installCrew (this = the Simulation). Also here: the message-kind registry every roster and task ask
// goes through (plan.js registerMessageKind when it exists; a local stub until the gear-list seam is merged, see installCrew).
import { requireRule } from './geometry.js';
import { AppError } from '../service.js';
import { cached, savepoint } from '../database.js';
import { bumpRevision } from '../repository.js';
import { addDays, dayLabel, weekdayOf } from './schedule.js';
import { DAY_START, SEND_BEFORE, DEFAULT_TIME, parseTime, timeWords } from './plantime.js';
import { DEMO_NAME } from './team.js';
import * as plan from './plan.js';
/** Office commands of this file (operations.manage). @type {string[]} */
export const ROSTER_OPS = ['rosterPick', 'rosterClear', 'rosterPattern', 'rosterPatternEnd'];
export const ROSTER_AHEAD = 14, // the fortnight rule: a pattern is never materialised further than today + 14
  ROSTER_MAX_DAYS = 400,
  ROSTER_PICK_MAX = 31;
export const ROSTER_STATUS_WORDS = {
  ROSTERED: 'Rostered',
  CONFIRMED: 'Confirmed',
  DENIED: 'Can’t work',
  REMOVED: 'Off',
};
export const PATTERN_WORDS = { MON_FRI: 'Mon–Fri', MON_SAT: 'Mon–Sat' };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** @type {(ms:number)=>string} */
const iso = (ms) => new Date(ms).toISOString();
/** @type {(n:number,one:string,many?:string)=>string} */
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
/** @type {(event:string,fields:Record<string,unknown>)=>void} */
const logError = (event, fields) => {
  try {
    console.error(JSON.stringify({ event, ...fields }));
  } catch {}
};
/** A first name for a message ("Hi Jo"), or "there" for a demo name. @param {string|null|undefined} name */
export const firstName = (name) => (!name || DEMO_NAME.test(name) ? 'there' : String(name).split(' ')[0]);
/** An optional note (at most 200 characters): null when empty. @type {(v:unknown)=>string|null} */
export const noteOf = (v) => {
  if (v === undefined || v === null) return null;
  requireRule(typeof v === 'string', 'A note must be text.');
  const s = v.trim();
  if (!s) return null;
  requireRule(s.length <= 200, 'A note can be at most 200 characters.');
  return s;
};
// ---------------------------------------------------------------- the message-kind registry (the seam shared with the gear-list builder)
// plan.js owns the registry once the gear-list work is merged (MESSAGE_KINDS / registerMessageKind). Until then a local map stands in and
// installCrew wraps messageAnswer / messageSeen / planAnswerMsg so an ask about a roster day or a task is answered the same way.
/** @type {Map<string,any>} */
const LOCAL_KINDS = new Map();
/** @type {any} */
const planModule = plan;
export const seamReady = () => typeof planModule.registerMessageKind === 'function';
export const MESSAGE_KINDS = /** @type {Map<string,any>} */ (planModule.MESSAGE_KINDS ?? LOCAL_KINDS);
/** @param {string} kind @param {any} hooks */
export function registerMessageKind(kind, hooks) {
  if (seamReady()) planModule.registerMessageKind(kind, hooks);
  else LOCAL_KINDS.set(kind, hooks);
}
/** The hooks of a message that is not about a plan item (null for a plan item's own messages). @param {any} m */
export const messageKindOf = (m) => {
  const k = m?.about?.kind;
  if (!k || k === 'planItem') return null;
  return MESSAGE_KINDS.get(k) ?? null;
};
const PERSON_MSGS =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='message' AND json_extract(data,'$.person')=? ORDER BY rowid";
// One ask or notice of one person about a roster day or a task: made and sent at once (its send time is now), the words from its kind's
// hooks. The one delivery seam stays planDeliver for plan items; a text-message provider would send these the same way.
/** @param {any} sim @param {{kind:string,id:string,person:string,subject:string,day:string,time:string,site?:string|null,needsAnswer:boolean,now:number,quiet?:boolean}} a */
export function crewSend(sim, { kind, id, person, subject, day, time, site = null, needsAnswer, now, quiet = false }) {
  const p = sim.teamPerson(person);
  if (!p) return null;
  const hook = MESSAGE_KINDS.get(kind);
  if (!hook) return null;
  const attempt =
    sim.planRows(PERSON_MSGS, person).filter((/** @type {any} */ m) => m.about?.id === id && m.subject === subject)
      .length + 1;
  const m = sim.repo.add('message', {
    person,
    personKind: p.kind === 'driver' ? 'driver' : 'worker',
    personName: p.name,
    item: null,
    itemType: kind === 'rosterDay' ? 'ROSTER' : 'TASK',
    about: { kind, id },
    day,
    time,
    site,
    subject,
    text: '',
    needsAnswer,
    status: 'WAITING_TO_SEND',
    sendAt: iso(now),
    sentAt: null,
    answeredAt: null,
    seenAt: null,
    answer: null,
    attempt,
    channel: 'IN_APP',
    outbound: { provider: null, ref: null },
    calledOffAt: null,
    calledOffWhy: null,
    closedAt: null,
    createdAt: iso(now),
  });
  m.text = hook.text(sim, m);
  m.status = 'SENT';
  m.sentAt = iso(now);
  sim.repo.save(m);
  if (!quiet) sim.notify('Message sent', hook.summary(sim, m), site);
  return m.id;
}
// The stub of the seam (only while plan.js has no registry): answers, "Got it" and the simulated replies reach the kind's hooks.
/** @param {any} proto */
export function installMessageKindStub(proto) {
  const answer = proto.messageAnswer,
    seen = proto.messageSeen,
    saveAnswer = proto.planAnswerMsg;
  const msgOf = (/** @type {any} */ sim, /** @type {unknown} */ id) => {
    if (typeof id !== 'string') return null;
    try {
      return sim.repo.get(id, 'message');
    } catch {
      return null;
    }
  };
  proto.messageAnswer = function (/** @type {any} */ input) {
    const m = msgOf(this, input?.id),
      hook = messageKindOf(m);
    if (!m || !hook) return answer.call(this, input);
    requireRule(typeof input.yes === 'boolean', 'Choose Confirm or Can’t make it.');
    const own = !!this.user.crew;
    if (own && m.person !== (this.user.crew.person ?? this.user.crew.driver))
      throw new AppError(404, 'Record not found in your company.');
    const via = own ? 'PHONE' : input.via === undefined || input.via === null ? 'OFFICE' : input.via;
    requireRule(['PHONE_VIEW', 'OFFICE', 'PHONE'].includes(via), 'Choose how the answer came in.');
    requireRule(m.status !== 'CALLED_OFF', 'This was called off.');
    requireRule(m.status !== 'WAITING_TO_SEND', "This hasn't been sent yet.");
    requireRule(m.needsAnswer, "This one doesn't need an answer. Tap Got it.");
    const now = this.planNow();
    requireRule(
      ['SENT', 'YES', 'NO'].includes(m.status) && !m.closedAt && hook.isOpen(this, m),
      'This is already finished.',
    );
    if (via !== 'OFFICE') requireRule(now < hook.deadline(this, m), 'Too late to answer, call the office.');
    const reason = input.yes ? null : noteOf(input.reason);
    if (this.repo.provenance && !own)
      this.repo.provenance = { ...this.repo.provenance, kind: 'ON_BEHALF', onBehalfOf: m.person };
    const stored = own ? 'PHONE' : this.live() ? 'OFFICE' : via;
    this.planAnswerMsg(m, { yes: input.yes, reason, by: this.user.id, via: stored }, now);
    return {
      ok: true,
      message: input.yes
        ? via === 'OFFICE'
          ? 'Marked as confirmed for ' + m.personName + '.'
          : 'Thanks. See you then.'
        : 'Got it. The office will sort it.',
      messageView: this.planMsgView(this.repo.get(m.id, 'message'), now),
      ...(hook.reply ? hook.reply(this, this.repo.get(m.id, 'message')) : {}),
    };
  };
  proto.messageSeen = function (/** @type {any} */ input) {
    const m = msgOf(this, input?.id),
      hook = messageKindOf(m);
    if (!m || !hook) return seen.call(this, input);
    if (this.user.crew && m.person !== (this.user.crew.person ?? this.user.crew.driver))
      throw new AppError(404, 'Record not found in your company.');
    requireRule(!m.needsAnswer, 'Answer this one with the two buttons.');
    requireRule(m.status !== 'CALLED_OFF', 'This was called off.');
    const now = this.planNow();
    if (!m.seenAt) {
      m.seenAt = iso(now);
      this.repo.save(m);
      hook.onSeen?.(this, m, now);
    }
    return { ok: true, message: 'Got it.', messageView: this.planMsgView(m, now) };
  };
  proto.planAnswerMsg = function (/** @type {any} */ m, /** @type {any} */ a, /** @type {number} */ at) {
    const hook = messageKindOf(m);
    if (!hook) return saveAnswer.call(this, m, a, at);
    m.status = a.yes ? 'YES' : 'NO';
    m.answeredAt = iso(at);
    m.answer = { yes: a.yes, reason: a.yes ? null : (a.reason ?? null), by: a.by ?? null, via: a.via };
    this.repo.save(m);
    hook.onAnswer(this, m, at);
    return m;
  };
}
// ---------------------------------------------------------------- queries (indexes in migration 010)
const ROSTER_RANGE =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='rosterDay' AND json_extract(data,'$.person')=? AND json_extract(data,'$.day') BETWEEN ? AND ? ORDER BY json_extract(data,'$.day'), rowid";
const ROSTER_ONE =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='rosterDay' AND json_extract(data,'$.person')=? AND json_extract(data,'$.day')=? ORDER BY rowid LIMIT 1";
const ROSTER_DAY =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='rosterDay' AND json_extract(data,'$.day')=? ORDER BY rowid";
const ROSTER_AHEAD_OF =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='rosterDay' AND json_extract(data,'$.person')=? AND json_extract(data,'$.day')>? ORDER BY json_extract(data,'$.day'), rowid";
const PATTERNS_OPEN =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='rosterPattern' AND coalesce(json_type(data,'$.endedAt'),'null')='null' ORDER BY rowid";
const PATTERN_OF =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='rosterPattern' AND json_extract(data,'$.person')=? AND coalesce(json_type(data,'$.endedAt'),'null')='null' ORDER BY rowid";
/** @type {Record<string,any> & ThisType<any>} */
export const rosterMethods = {
  // ---------- lookups ----------
  /** A worker on the team (rostering is for workers; drivers have their truck bookings). @param {unknown} id */
  rosterWorker(id) {
    requireRule(typeof id === 'string' && id, 'Choose someone in your team.');
    let w = null;
    try {
      w = this.repo.get(id, 'resource');
    } catch {}
    requireRule(w && w.type === 'WORKER' && w.enabled, 'Choose someone in your team.');
    return w;
  },
  /** The yard or an active site, by id (null: the yard). @param {unknown} id */
  rosterPlace(id) {
    if (id === undefined || id === null || id === '') {
      const yard = this.planYard();
      requireRule(yard, 'Set up your yard first.');
      return yard;
    }
    requireRule(typeof id === 'string', 'Choose the yard or a site.');
    let p = null;
    try {
      p = this.repo.get(id);
    } catch {}
    requireRule(p && (p.kind === 'yard' || (p.kind === 'site' && p.status === 'ACTIVE')), 'Choose the yard or a site.');
    return p;
  },
  /** Where a worker usually works: their `where` if set, else their home place. @param {any} w */
  rosterWhereOf(w) {
    const id = w.where ?? this.teamHome(w);
    try {
      const p = this.repo.get(id);
      if (p.kind === 'yard' || (p.kind === 'site' && p.status === 'ACTIVE')) return p.id;
    } catch {}
    return this.planYard()?.id ?? null;
  },
  /** A day string on the calendar (any day, past included). @param {unknown} v */
  rosterDayOf(v) {
    requireRule(typeof v === 'string' && DAY.test(v) && addDays(v, 0) === v, 'Choose a day on the calendar.');
    return v;
  },
  /** @param {string} person @param {string} day */
  rosterOf(person, day) {
    const row = cached(this.db, ROSTER_ONE).get(this.repo.company, person, day);
    return row ? this.repo.decode(row) : null;
  },
  /** @param {string} person @param {string} from @param {string} to */
  rosterRows(person, from, to) {
    return this.planRows(ROSTER_RANGE, person, from, to);
  },
  /** Everyone's rows for one day. @param {string} day */
  rosterDayRows(day) {
    return this.planRows(ROSTER_DAY, day);
  },
  /** @param {string} person */
  rosterPatternOf(person) {
    return this.planRows(PATTERN_OF, person)[0] ?? null;
  },
  // ---------- commands (operations.manage) ----------
  // Roster a person on the days tapped: a fresh day, or a removed or denied one picked again (asked again). Never a day that has gone.
  rosterPick(/** @type {any} */ input) {
    const w = this.rosterWorker(input?.person),
      cal = this.planNowCal(),
      now = this.planNow(),
      days = input?.days;
    requireRule(
      Array.isArray(days) && days.length >= 1 && days.length <= ROSTER_PICK_MAX,
      'Tap the days on the calendar.',
    );
    const where = input?.where === undefined || input?.where === null ? null : this.rosterPlace(input.where).id,
      time = input?.time === undefined || input?.time === null ? null : parseTime(input.time);
    let added = 0;
    for (const raw of new Set(days)) {
      const day = this.rosterDayOf(raw);
      requireRule(day >= cal.today, 'That day has gone.');
      requireRule(day <= addDays(cal.today, ROSTER_MAX_DAYS), 'Choose a day within the next year.');
      const row = this.rosterOf(w.id, day);
      if (row && ['ROSTERED', 'CONFIRMED'].includes(row.status)) {
        // already on: the place or time may change (a fresh ask goes out if one was answered for the old details)
        let changed = false;
        if (where && row.where !== where) ((row.where = where), (changed = true));
        if (time && row.time !== time) ((row.time = time), (changed = true));
        if (changed) this.repo.save(row);
        continue;
      }
      if (row) {
        Object.assign(row, {
          source: 'PICKED',
          status: 'ROSTERED',
          where: where ?? row.where ?? this.rosterWhereOf(w),
          time: time ?? row.time ?? DEFAULT_TIME,
          message: null,
          notAsked: null,
          answeredAt: null,
          answer: null,
          removedAt: null,
          removedWhy: null,
          pickedAt: iso(now),
          createdBy: this.user.id,
        });
        this.repo.save(row);
      } else
        this.repo.add('rosterDay', {
          person: w.id,
          day,
          source: 'PICKED',
          status: 'ROSTERED',
          where: where ?? this.rosterWhereOf(w),
          time: time ?? DEFAULT_TIME,
          message: null,
          notAsked: null,
          answeredAt: null,
          answer: null,
          createdAt: iso(now),
          createdBy: this.user.id,
          removedAt: null,
          removedWhy: null,
        });
      added++;
    }
    this.rosterAsks(now); // a day picked after 3 pm for tomorrow is asked at once
    bumpRevision(this.db, this.repo.company, 'plan');
    return {
      ...this.rosterNext(w.id, cal.today),
      message: added ? w.name + ' rostered on ' + plural(added, 'day') + '.' : w.name + ' was already on those days.',
    };
  },
  // Take a person off days: the day is kept as REMOVED (a pattern never fills it again), their ask is called off, and a task that day they
  // had not started yet loses them.
  rosterClear(/** @type {any} */ input) {
    const w = this.rosterWorker(input?.person),
      cal = this.planNowCal(),
      now = this.planNow(),
      days = input?.days;
    requireRule(Array.isArray(days) && days.length >= 1 && days.length <= ROSTER_PICK_MAX, 'Tap the days to clear.');
    let n = 0;
    for (const raw of new Set(days)) {
      const day = this.rosterDayOf(raw),
        row = this.rosterOf(w.id, day);
      if (!row || row.status === 'REMOVED') continue;
      this.rosterRemove(row, 'office', now);
      if (typeof this.taskRosterCleared === 'function') this.taskRosterCleared(w.id, day, now);
      n++;
    }
    bumpRevision(this.db, this.repo.company, 'plan');
    return {
      ...this.rosterNext(w.id, cal.today),
      message: n ? w.name + ' taken off ' + plural(n, 'day') + '.' : 'Nothing to clear.',
    };
  },
  /** @param {any} row @param {string} why @param {number} now */
  rosterRemove(row, why, now) {
    if (row.message) this.planCallOff(row.message, 'The roster changed', now);
    row.status = 'REMOVED';
    row.removedAt = iso(now);
    row.removedWhy = why;
    this.repo.save(row);
  },
  // Mon–Fri or Mon–Sat, filled a fortnight ahead (never today: the office picks today). One open pattern per person.
  rosterPattern(/** @type {any} */ input) {
    const w = this.rosterWorker(input?.person),
      kind = input?.kind,
      cal = this.planNowCal(),
      now = this.planNow();
    requireRule(kind === 'MON_FRI' || kind === 'MON_SAT', 'Choose Mon–Fri or Mon–Sat.');
    const where =
        input?.where === undefined || input?.where === null ? this.rosterWhereOf(w) : this.rosterPlace(input.where).id,
      time = input?.time === undefined || input?.time === null ? DEFAULT_TIME : parseTime(input.time);
    for (const p of this.planRows(PATTERN_OF, w.id)) {
      p.endedAt = iso(now);
      this.repo.save(p);
    }
    // stored as `type` (a stored object's `kind` is 'rosterPattern'); the views say `kind`
    const pattern = this.repo.add('rosterPattern', {
      person: w.id,
      type: kind,
      where,
      time,
      from: cal.today,
      until: null,
      createdAt: iso(now),
      createdBy: this.user.id,
      endedAt: null,
    });
    const filled = this.rosterFill(pattern, cal.today, this.user.id, now);
    this.rosterAsks(now);
    bumpRevision(this.db, this.repo.company, 'plan');
    return {
      ...this.rosterNext(w.id, cal.today),
      message:
        w.name + ' is on ' + PATTERN_WORDS[kind] + ': ' + plural(filled, 'day') + ' rostered, 14 days ahead at most.',
    };
  },
  // The pattern stops: its own future days go (picked days stay).
  rosterPatternEnd(/** @type {any} */ input) {
    const w = this.rosterWorker(input?.person),
      cal = this.planNowCal(),
      now = this.planNow();
    let n = 0;
    for (const p of this.planRows(PATTERN_OF, w.id)) {
      p.endedAt = iso(now);
      this.repo.save(p);
      n++;
    }
    let removed = 0;
    for (const row of this.planRows(ROSTER_AHEAD_OF, w.id, cal.today)) {
      if (row.source !== 'PATTERN' || row.status === 'REMOVED') continue;
      this.rosterRemove(row, 'pattern ended', now);
      if (typeof this.taskRosterCleared === 'function') this.taskRosterCleared(w.id, row.day, now);
      removed++;
    }
    bumpRevision(this.db, this.repo.company, 'plan');
    return {
      ...this.rosterNext(w.id, cal.today),
      message: n
        ? 'Pattern stopped for ' + w.name + ': ' + plural(removed, 'day') + ' ahead cleared.'
        : 'No pattern to stop.',
    };
  },
  // ---------- the clock's duties (LIVE clockPass and DEMO planPass both call these) ----------
  // Fill one pattern's window: today+1 … today+14, its weekdays, where no row exists yet (a removed day blocks re-fill). Returns how many.
  /** @param {any} pattern @param {string} today @param {string} by @param {number} now */
  rosterFill(pattern, today, by, now) {
    let n = 0;
    for (let d = 1; d <= ROSTER_AHEAD; d++) {
      const day = addDays(today, d),
        wd = weekdayOf(day);
      if (wd > (pattern.type === 'MON_SAT' ? 5 : 4)) continue;
      if (pattern.until && day > pattern.until) continue;
      if (this.rosterOf(pattern.person, day)) continue;
      this.repo.add('rosterDay', {
        person: pattern.person,
        day,
        source: 'PATTERN',
        status: 'ROSTERED',
        where: pattern.where,
        time: pattern.time,
        message: null,
        notAsked: null,
        answeredAt: null,
        answer: null,
        createdAt: iso(now),
        createdBy: by,
        removedAt: null,
        removedWhy: null,
      });
      n++;
    }
    return n;
  },
  // Once a company day: every open pattern gets its next day (the window stays 14 days ahead). Idempotent: a second pass writes nothing.
  /** @param {number} now */
  rosterFillDue(now) {
    const today = this.planToday(now),
      state = this.repo.all('clockState')[0] ?? null;
    if (state?.rosterFillDay === today) return 0;
    let n = 0;
    for (const p of this.planRows(PATTERNS_OPEN)) {
      if (!this.teamPerson(p.person)) {
        p.endedAt = iso(now);
        this.repo.save(p);
        continue;
      }
      n += this.rosterFill(p, today, 'clock', now);
    }
    const fresh = this.repo.all('clockState')[0] ?? null;
    if (fresh) this.repo.save({ ...fresh, rosterFillDay: today });
    else this.repo.add('clockState', { rosterFillDay: today });
    if (n) bumpRevision(this.db, this.repo.company, 'plan');
    return n;
  },
  // The day-before ask: at 3 pm for tomorrow's rostered people (at once when picked after that), and never once the day has begun
  // ("Not asked in time" instead, for the office to call). A reminder after two hours is the clock's clockRemind (it reads day and time).
  /** @param {number} now */
  rosterAsks(now) {
    const today = this.planToday(now),
      tomorrow = addDays(today, 1);
    let sent = 0;
    for (const day of [today, tomorrow]) {
      if (day === tomorrow && now < this.planAt(today, SEND_BEFORE)) continue;
      for (const row of this.rosterDayRows(day)) {
        if (row.status !== 'ROSTERED' || row.message || row.notAsked) continue;
        const p = this.teamPerson(row.person);
        if (!p) continue;
        if (now >= this.planAt(day, DAY_START)) {
          // the ask should have gone out and never did (the computer was off): said once. A day picked for today after it began is
          // simply not asked (the office knows: they picked it).
          row.notAsked = iso(now);
          this.repo.save(row);
          if (Date.parse(row.pickedAt ?? row.createdAt) < this.planAt(day, DAY_START))
            this.notify(
              'Not asked in time',
              p.name + " wasn't asked about " + (day === today ? 'today' : 'tomorrow') + '. Call them.',
              null,
            );
          continue;
        }
        row.message = this.rosterAskPerson(row, now);
        this.repo.save(row);
        if (row.message) sent++;
      }
    }
    return sent;
  },
  /** @param {any} row @param {number} now */
  rosterAskPerson(row, now) {
    let site = null;
    try {
      site = this.repo.get(row.where, 'site').id;
    } catch {}
    return crewSend(this, {
      kind: 'rosterDay',
      id: row.id,
      person: row.person,
      subject: 'ROSTER',
      day: row.day,
      time: row.time ?? DEFAULT_TIME,
      site,
      needsAnswer: true,
      now,
    });
  },
  // Someone left the team (team.js teamRemove): their days ahead go (at most a fortnight of pattern days plus any picked), their asks are
  // called off, their pattern ends. Today's row stays: they may already be on site.
  /** @param {string} id @param {number} now */
  rosterPersonGone(id, now) {
    const today = this.planToday(now);
    let n = 0;
    for (const row of this.planRows(ROSTER_AHEAD_OF, id, today)) {
      if (row.status === 'REMOVED') continue;
      this.rosterRemove(row, 'left the team', now);
      n++;
    }
    for (const p of this.planRows(PATTERN_OF, id)) {
      p.endedAt = iso(now);
      this.repo.save(p);
    }
    return n;
  },
  // ---------- views ----------
  /** @param {any} row @param {number} now */
  rosterRowView(row, now) {
    const m = row.message ? this.planMsg(row.message) : null,
      answer = m ? this.planAnswerOf(m, now) : row.notAsked ? 'NOT_ASKED' : 'NOT_SENT';
    return {
      id: row.id,
      person: row.person,
      day: row.day,
      dayLabel: dayLabel(row.day),
      status: row.status,
      statusWords: ROSTER_STATUS_WORDS[row.status] ?? row.status,
      source: row.source,
      where: row.where ?? null,
      whereName: row.where ? this.planName(row.where, 'the yard') : 'the yard',
      time: row.time ?? DEFAULT_TIME,
      timeWords: timeWords(row.time ?? DEFAULT_TIME),
      answer,
      reason: m?.answer?.reason ?? null,
      via: m?.answer?.via ?? null,
      answeredAt: m?.answeredAt ?? null,
      message: row.message ?? null,
      canAsk: row.status === 'ROSTERED' && now < this.planAt(row.day, DAY_START),
    };
  },
  /** The next fortnight of one person (the Workers page's row and the +1 form's reply). @param {string} person @param {string} today */
  rosterNext(person, today) {
    const now = this.planNow(),
      to = addDays(today, ROSTER_AHEAD);
    return {
      person,
      today,
      next14: this.rosterRows(person, today, to)
        .filter((r) => r.status !== 'REMOVED')
        .map((r) => ({ day: r.day, status: r.status, answer: this.rosterRowView(r, now).answer })),
      pattern: this.rosterPatternView(person),
    };
  },
  /** @param {string} person */
  rosterPatternView(person) {
    const p = this.rosterPatternOf(person);
    return p
      ? {
          id: p.id,
          kind: p.type,
          words: PATTERN_WORDS[p.type],
          where: p.where,
          whereName: this.planName(p.where, 'the yard'),
          time: p.time,
          timeWords: timeWords(p.time),
          from: p.from,
        }
      : null;
  },
  // GET /api/roster?person=&from=&to= (at most 62 days) and GET /api/roster?day= (everyone rostered that day). Office only.
  /** @param {{person?:string|null,from?:string|null,to?:string|null,day?:string|null}} q */
  rosterView({ person = null, from = null, to = null, day = null } = {}) {
    this.auth.require(this.user, 'operations.manage');
    const now = this.planNow(),
      cal = this.planNowCal();
    if (day) {
      const d = this.rosterDayOf(day);
      return {
        day: d,
        dayLabel: dayLabel(d),
        today: cal.today,
        people: this.rosterDayRows(d)
          .filter((r) => r.status !== 'REMOVED' && this.teamPerson(r.person))
          .map((r) => ({ ...this.rosterRowView(r, now), name: this.planName(r.person) }))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
      };
    }
    const w = this.rosterWorker(person);
    const f = from ? this.rosterDayOf(from) : cal.today,
      t = to ? this.rosterDayOf(to) : addDays(f, ROSTER_AHEAD);
    requireRule(t >= f && addDays(f, 62) >= t, 'Choose up to 62 days.');
    const places = [
      ...this.repo.all('yard').map((y) => ({ id: y.id, name: y.name, kind: 'yard' })),
      ...this.repo
        .all('site')
        .filter((s) => s.status === 'ACTIVE')
        .map((s) => ({ id: s.id, name: s.name, kind: 'site' }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    ];
    return {
      person: {
        id: w.id,
        name: w.name,
        where: this.rosterWhereOf(w),
        whereName: this.planName(this.rosterWhereOf(w), 'the yard'),
      },
      from: f,
      to: t,
      today: cal.today,
      ahead: ROSTER_AHEAD,
      days: this.rosterRows(w.id, f, t).map((r) => this.rosterRowView(r, now)),
      pattern: this.rosterPatternView(w.id),
      places,
      sendBefore: SEND_BEFORE,
    };
  },
  // A person's own roster for the phone: today's day and tomorrow's ask (crewMe and the Practice yard's phone view).
  /** @param {string} person @param {string} today */
  rosterMine(person, today) {
    const now = this.planNow(),
      tomorrow = addDays(today, 1),
      view = (/** @type {string} */ d) => {
        const r = this.rosterOf(person, d);
        return r && r.status !== 'REMOVED' ? this.rosterRowView(r, now) : null;
      };
    return { today: view(today), tomorrow: view(tomorrow) };
  },
};
// The hooks of a ROSTER ask (registered by installCrew). The words come from here, the state change from onAnswer: the person's own phone
// (PERSON), the office for them (ON_BEHALF) or the Practice yard's simulated reply (SIMULATED), never the clock.
export const ROSTER_HOOKS = {
  /** @param {any} sim @param {any} m */
  row(sim, m) {
    try {
      return sim.repo.get(m.about.id, 'rosterDay');
    } catch {
      return null;
    }
  },
  /** @param {any} sim @param {any} m */
  isOpen(sim, m) {
    const r = ROSTER_HOOKS.row(sim, m);
    return !!r && r.status !== 'REMOVED' && r.day >= sim.planToday(sim.planNow());
  },
  /** @param {any} sim @param {any} m */
  deadline(sim, m) {
    const r = ROSTER_HOOKS.row(sim, m);
    return sim.planAt(r?.day ?? m.day, r?.time ?? m.time ?? DEFAULT_TIME);
  },
  /** @param {any} sim @param {any} m */
  text(sim, m) {
    const r = ROSTER_HOOKS.row(sim, m),
      where = sim.planName(r?.where, 'the yard'),
      when =
        m.day === addDays(sim.planToday(sim.planNow()), 1)
          ? 'tomorrow (' + dayLabel(m.day) + ')'
          : 'on ' + dayLabel(m.day);
    return (
      'Hi ' +
      firstName(m.personName) +
      ", you're on " +
      when +
      ' at ' +
      where +
      ' from ' +
      timeWords(r?.time ?? m.time) +
      '. Please reply Confirm or Deny. – ' +
      sim.planCompany()
    );
  },
  /** @param {any} sim @param {any} m */
  summary(sim, m) {
    const r = ROSTER_HOOKS.row(sim, m);
    return (
      'Asked ' +
      (m.personName || 'someone') +
      ' about ' +
      dayLabel(m.day) +
      ' (' +
      sim.planName(r?.where, 'the yard') +
      ').'
    );
  },
  /** @param {any} sim @param {any} m @param {number} at */
  onAnswer(sim, m, at) {
    const r = ROSTER_HOOKS.row(sim, m);
    if (!r || r.status === 'REMOVED') return;
    if (r.message && r.message !== m.id) return; // an older ask answered after a new one went out: the newest ask counts
    r.status = m.answer?.yes ? 'CONFIRMED' : 'DENIED';
    r.answeredAt = iso(at);
    r.answer = {
      yes: !!m.answer?.yes,
      reason: m.answer?.reason ?? null,
      by: m.answer?.by ?? null,
      via: m.answer?.via ?? null,
    };
    sim.repo.save(r);
    bumpRevision(sim.db, sim.repo.company, 'plan');
    if (!m.answer?.yes)
      sim.notify(
        'Can’t work',
        (m.personName || 'Someone') +
          ' can’t work on ' +
          dayLabel(r.day) +
          (m.answer?.reason ? ': ' + m.answer.reason : '') +
          '. Roster someone else on Workers.',
        m.site ?? null,
      );
  },
  /** @param {any} sim @param {any} m */
  reply(sim, m) {
    const r = ROSTER_HOOKS.row(sim, m);
    return r ? { rosterDay: sim.rosterRowView(r, sim.planNow()) } : {};
  },
};
// The clock and the Practice yard's day both run these, after their own pass: the fortnight fill, the roster asks, the task asks (tasks.js).
// Each in its own savepoint, a failure logged and never thrown out of the pass. (Once plan.js/clock.js call the three by name, installCrew
// no longer wraps the passes: seamReady.)
/** @type {WeakMap<object,Map<string,number>>} */
const lastPass = new WeakMap();
/** @param {any} proto */
export function installCrewPasses(proto) {
  proto.crewPass = function (/** @type {number} */ now = this.planNow()) {
    for (const f of ['rosterFillDue', 'rosterAsks', 'taskAsks']) {
      if (typeof this[f] !== 'function') continue;
      try {
        savepoint(this.db, 'crew_' + f, () => this[f](now));
      } catch (/** @type {any} */ error) {
        logError('crew_pass_error', { step: f, message: error.message });
      }
    }
  };
  for (const name of ['planPass', 'clockPass']) {
    const run = proto[name];
    proto[name] = function (/** @type {number} */ now = this.planNow()) {
      const r = run.call(this, now);
      if (name === 'clockPass' ? this.live() : !this.live()) this.crewPass(now);
      return r;
    };
  }
  installCrewTick(proto);
}
// The Practice yard's engine tick only runs planPass while something is busy (a booking, an open message, someone away): a roster pattern
// and the day-before asks still need a look once a minute, so the fill and the asks run then (through plan.js's planPartFive once the seam
// is real, else crewPass). A real yard's business clock passes on its own timer and never comes through here.
/** @param {any} proto */
export function installCrewTick(proto) {
  if (typeof proto.crewPass !== 'function')
    proto.crewPass = function (/** @type {number} */ now = this.planNow()) {
      if (typeof this.planPartFive === 'function') return this.planPartFive(now);
    };
  const tick = proto.planTick;
  proto.planTick = function (/** @type {number} */ elapsed = 0) {
    const r = tick.call(this, elapsed);
    if (this.live()) return r;
    const now = this.planNow();
    let byCompany = lastPass.get(this.db);
    if (!byCompany) lastPass.set(this.db, (byCompany = new Map()));
    const last = byCompany.get(this.repo.company) ?? -Infinity;
    if (r || now - last < 60000) {
      if (r) byCompany.set(this.repo.company, now);
      return r;
    }
    byCompany.set(this.repo.company, now);
    try {
      savepoint(this.db, 'crew_tick', () => this.crewPass(now));
    } catch (/** @type {any} */ error) {
      logError('crew_tick_error', { message: error.message });
    }
    return r;
  };
}
