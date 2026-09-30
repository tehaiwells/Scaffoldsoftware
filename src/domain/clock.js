// @ts-check
// The business clock (ADR 0002, audit #32): the time rules that are true in real life, on their own timer, apart from the movement engine.
// It runs for LIVE companies (the real yard) every 30 s, on company time (companies.time_zone), and keeps three rules:
//   1. It never changes where anything is: no stock, stillage, truck or person moves; no ledger row is written.
//   2. It never records success: a day that ends with nothing confirmed is flagged "Not confirmed", never DONE.
//   3. It catches up in order after the computer was off, and does not send an ask that is now too late ("Not asked in time" instead).
// What it does: sends messages whose send time has come (the one delivery seam, planDeliver), asks drivers when a truck is booked, asks
// people for a Workers booking at 3 pm the day before, asks the yardsman to pack a list on its pack day, sends one reminder when an ask has
// no answer after two hours, flags "no answer yet", "can't make it", "not asked in time" and "not confirmed", and once a day says when
// paperwork needs looking at. The Practice yard keeps its simulated day (plan.js planPass, from the engine); it sends through the same
// clockDeliverDue.
import { savepoint, cached, atomic } from '../database.js';
import { zoneParts, zoneAt, DEFAULT_ZONE } from './zonetime.js';
import { addDays, dayLabel, weekdayOf, mondayOf } from './schedule.js';
import { DAY_START, SEND_BEFORE, DAY_END, timeWords } from './plantime.js';
import { paperState } from './paperwork.js';
/** @typedef {import('../repository.js').StoredObject} StoredObject */
const OPEN = ['PLANNED', 'ACTIVE'],
  REMIND_MS = 2 * 3600000,
  LATE_MS = 600000;
/** @type {(ms:number)=>string} */
const iso = (ms) => new Date(ms).toISOString();
/** @type {(n:number,one:string,many?:string)=>string} */
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
/** @type {(names:string[])=>string} */
const listWords = (names) =>
  names.length < 2 ? (names[0] ?? '') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
const OPEN_ITEMS =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='planItem' AND json_extract(data,'$.status') IN ('PLANNED','ACTIVE') ORDER BY rowid";
const DUE_MSGS =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='message' AND json_extract(data,'$.status')='WAITING_TO_SEND' ORDER BY rowid";
const ASKED_MSGS =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='message' AND json_extract(data,'$.status')='SENT' AND coalesce(json_type(data,'$.closedAt'),'null')='null' ORDER BY rowid";
const logError = (/** @type {string} */ event, /** @type {Record<string,unknown>} */ fields) => {
  try {
    console.error(JSON.stringify({ event, ...fields }));
  } catch {}
};
/** @type {Record<string,any> & ThisType<any>} */
export const clockMethods = {
  // The company's time zone (set when the company is made; never guessed from the server).
  clockZone() {
    return (this.clockZoneMemo ??=
      cached(this.db, 'SELECT time_zone FROM companies WHERE id=?').get(this.repo.company)?.time_zone ?? DEFAULT_ZONE);
  },
  /** @param {string} day @param {string} hm */
  clockAt(day, hm) {
    return zoneAt(day, hm, this.clockZone());
  },
  /** @param {number} ms */
  clockDay(ms) {
    return zoneParts(ms, this.clockZone()).day;
  },
  // The calendar's today, tomorrow and next working day on company time (the same shape as schedule.js calendarNow).
  /** @param {number} now */
  clockCal(now) {
    const today = this.clockDay(now),
      wd = weekdayOf(today);
    return {
      today,
      tomorrow: addDays(today, 1),
      nextWorkday: addDays(today, wd === 4 ? 3 : wd === 5 ? 2 : 1),
      weekStart: mondayOf(today),
      timeZone: this.clockZone(),
    };
  },
  // Messages whose send time has come go out, in the order they were made; one for a plan that has since closed is called off instead.
  // The only sender in either mode: the Practice yard's planPass calls this too.
  /** @param {number} now */
  clockDeliverDue(now) {
    for (const m of this.planRows(DUE_MSGS)) {
      if (Date.parse(m.sendAt) > now) continue;
      let it = null;
      try {
        it = this.repo.get(m.item, 'planItem');
      } catch {}
      if (!it || !OPEN.includes(it.status)) {
        this.planCallOff(m.id, 'The plan changed', now);
        continue;
      }
      this.planDeliver(m, it, now);
    }
  },
  // One pass for a real yard. Each item in its own savepoint, as the Practice yard's planPass does: one that fails says so on the item.
  /** @param {number} [now] */
  clockPass(now = this.planNow()) {
    if (!this.live()) return false;
    savepoint(this.db, 'clock_pass', () => {
      this.clockDeliverDue(now);
      const today = this.clockDay(now);
      const items = this.planRows(OPEN_ITEMS).sort(
        (/** @type {any} */ a, /** @type {any} */ b) =>
          a.day.localeCompare(b.day) ||
          a.time.localeCompare(b.time) ||
          String(a.createdAt).localeCompare(String(b.createdAt)),
      );
      for (const it of items) {
        try {
          savepoint(this.db, 'clock_item', () =>
            this.planEdit(it.id, (/** @type {any} */ x) => this.clockStep(x, now, today)),
          );
        } catch (/** @type {any} */ error) {
          if (!error.status) logError('clock_item_error', { item: it.id, message: error.message });
          try {
            savepoint(this.db, 'clock_item_problem', () =>
              this.planEdit(it.id, (/** @type {any} */ x) => {
                x.problem = error.status ? error.message : 'Something went wrong. It tries again in a moment.';
              }),
            );
          } catch {}
        }
      }
      this.clockRemind(now);
      this.clockPaperwork(now, today);
    });
    return true;
  },
  // One item of a real yard: asks and flags only.
  /** @param {any} it @param {number} now @param {string} today */
  clockStep(it, now, today) {
    if (!OPEN.includes(it.status) || it.stage === 'UNCONFIRMED') return;
    if (it.type === 'TRUCK') this.clockTruck(it, now, today);
    else if (it.type === 'WORKERS') this.clockWorkers(it, now, today);
    else if (it.type === 'MATERIALS') this.clockMaterials(it, now, today);
    else it.problem = 'This runs only in the Practice yard. Cancel it here.';
  },
  // The day has begun (6 am on its day, company time): an open item is under way. Only a label: nothing moves.
  /** @param {any} it @param {number} now */
  clockBegun(it, now) {
    return now >= this.clockAt(it.day, DAY_START);
  },
  /** @param {any} it @param {number} now */
  clockOver(it, now) {
    return now >= this.clockAt(it.day, DAY_END);
  },
  // The day ended and nobody confirmed what happened: flagged, never done. It stays on the calendar until someone confirms it (comes next) or
  // the office cancels it; its asks can no longer be answered.
  /** @param {any} it @param {number} now @param {string} why */
  clockUnconfirmed(it, now, why) {
    it.status = 'ACTIVE';
    it.stage = 'UNCONFIRMED';
    it.unconfirmedAt = iso(now);
    it.why = why;
    it.problem = 'Not confirmed: ' + why + '. Nothing is marked done until someone confirms it.';
    this.planLog(it, 'Not confirmed: ' + why + '.', now);
    this.planCloseMsgs(it, now);
  },
  // Too late to ask: the time the ask was for has come and gone without it being sent (the computer was off). Said, never sent late.
  /** @param {any} it @param {number} now */
  clockTooLate(it, now) {
    return now >= this.clockAt(it.day, it.time);
  },
  // ----- TRUCK: the driver is asked when the truck is booked (or picked); the answer is the office's to act on -----
  /** @param {any} it @param {number} now @param {string} today */
  clockTruck(it, now, today) {
    const driver = it.driver ? this.teamPerson(it.driver) : null,
      name = driver?.name ?? 'The driver',
      over = this.clockOver(it, now);
    if (it.driver && !it.message && !over) {
      if (this.clockTooLate(it, now)) {
        if (!it.notAsked) {
          it.notAsked = iso(now);
          this.planLog(
            it,
            'Not asked in time: ' + name + ' was not sent the ask before ' + timeWords(it.time) + '.',
            now,
          );
        }
      } else {
        it.message = this.planAskPerson(it, it.driver, 'driver', 'DRIVE', now);
        if (it.message) it.stage = this.clockBegun(it, now) ? 'ON' : 'ASKING';
      }
    }
    const m = this.planMsg(it.message);
    let problem = null;
    if (m?.status === 'YES') {
      if (it.stage === 'ASKING') it.stage = 'READY';
      if (it.heard !== m.id + ':YES') {
        it.heard = m.id + ':YES';
        this.planLog(it, name + ' said yes.', now);
      }
    } else if (m?.status === 'NO') {
      problem = name + " can't make it" + (m.answer?.reason ? ': ' + m.answer.reason : '') + '. Pick another driver.';
      if (it.heard !== m.id + ':NO') {
        it.heard = m.id + ':NO';
        this.planLog(it, name + " can't make it.", now);
      }
    } else if (m?.status === 'SENT' && this.clockTooLate(it, now)) problem = 'No answer yet from ' + name + '.';
    if (it.notAsked && !it.message) problem = 'Not asked in time: ' + name + " wasn't sent the ask. Call them.";
    if (!it.driver && it.needsDriver) problem = 'Needs a driver. Pick one.';
    if (!it.truck && !it.hire)
      problem = (it.truckGone ? it.truckGone + ' was removed. ' : '') + 'Cancel it and book another truck.';
    if (it.status === 'PLANNED' && this.clockBegun(it, now) && today >= it.day) it.status = 'ACTIVE';
    if (over) {
      const why =
        !it.truck && !it.hire
          ? (it.truckGone ?? 'the truck') + ' was removed'
          : it.driver && m?.status === 'NO'
            ? name + " couldn't drive"
            : it.driver && m?.status !== 'YES'
              ? name + ' never said yes'
              : 'nobody recorded that it went';
      this.clockUnconfirmed(it, now, why);
      return;
    }
    it.problem = problem;
  },
  // ----- WORKERS: each person is asked the day before at 3 pm (at once when booked after that, while it is still ahead) -----
  /** @param {any} it @param {number} now @param {string} today */
  clockWorkers(it, now, today) {
    const sendAt = this.clockAt(addDays(it.day, -1), SEND_BEFORE),
      siteName = this.planSiteName(it.site);
    if (this.clockOver(it, now)) {
      const yes = it.people.filter((/** @type {any} */ p) => this.planMsg(p.message)?.status === 'YES');
      this.clockUnconfirmed(
        it,
        now,
        !it.people.length
          ? 'nobody was booked'
          : !yes.length
            ? 'nobody said they were coming'
            : 'nobody recorded who went to ' + siteName,
      );
      return;
    }
    if (now >= sendAt) this.clockAskWorkers(it, now, sendAt, siteName);
    if (it.status === 'PLANNED' && this.clockBegun(it, now) && today >= it.day) it.status = 'ACTIVE';
    const late = this.clockTooLate(it, now),
      names = (/** @type {(p:any)=>boolean} */ f) =>
        it.people.filter(f).map((/** @type {any} */ p) => this.planName(p.person));
    const notAsked = names((p) => !p.message && !!p.notAsked),
      no = names((p) => this.planMsg(p.message)?.status === 'NO'),
      silent = late ? names((p) => this.planMsg(p.message)?.status === 'SENT') : [],
      gaps = it.count - it.people.length;
    it.problem = notAsked.length
      ? 'Not asked in time: ' +
        listWords(notAsked) +
        (notAsked.length === 1 ? " wasn't" : " weren't") +
        ' sent the ask. Call them.'
      : no.length
        ? listWords(no) + " can't make it. Ask someone else."
        : silent.length
          ? 'No answer yet from ' + listWords(silent) + '.'
          : gaps > 0
            ? 'Short by ' + gaps + ': nobody else is free that day. Tap Ask someone.'
            : null;
  },
  // The 3 pm ask of every person on a Workers booking who has not been asked yet. After downtime it goes out late (said on the booking), but
  // never once the work has started: then each one is flagged "not asked in time" for the office to call.
  /** @param {any} it @param {number} now @param {number} sendAt @param {string} siteName */
  clockAskWorkers(it, now, sendAt, siteName) {
    const late = this.clockTooLate(it, now);
    let sent = 0,
      missed = 0;
    for (const p of it.people) {
      if (p.message || p.notAsked) continue;
      if (late) {
        p.notAsked = iso(now);
        missed++;
        continue;
      }
      p.message = this.planAskPerson(it, p.person, 'worker', 'WORK', now, { quiet: true });
      if (p.message) sent++;
    }
    if (sent) {
      if (Date.parse(it.createdAt) < sendAt && now - sendAt > LATE_MS)
        this.planLog(it, 'Sent late: the computer was off at 3 pm.', now);
      this.planLog(it, 'Asked ' + plural(sent, 'person', 'people') + ' to come to ' + siteName + '.', now);
      this.notify(
        'Message sent',
        'Asked ' + plural(sent, 'person', 'people') + ' to work at ' + siteName + ' on ' + dayLabel(it.day) + '.',
        it.site,
      );
    }
    if (missed)
      this.planLog(it, 'Not asked in time: ' + plural(missed, 'person', 'people') + ' never got the ask.', now);
    if (it.stage === 'BOOKED' && (sent || missed)) it.stage = 'ASKING';
  },
  // ----- MATERIALS: the yardsman is asked to pack it on its pack day; packing, loading and delivering are people's to confirm (comes next) -----
  /** @param {any} it @param {number} now @param {string} today */
  clockMaterials(it, now, today) {
    let site = null;
    try {
      site = this.repo.get(it.site, 'site');
    } catch {}
    if (!site || site.status !== 'ACTIVE') {
      this.planCallOffAll(it, 'The site was removed', now);
      it.status = 'CANCELLED';
      it.cancelledAt = iso(now);
      it.cancelReason = 'Site removed';
      it.problem = null;
      this.planLog(it, 'Cancelled: ' + (site?.name ?? 'the site') + ' was removed.', now);
      return;
    }
    if (this.clockOver(it, now)) {
      this.clockUnconfirmed(it, now, 'nobody recorded that it was packed and delivered');
      return;
    }
    if (it.stage === 'WAITING' && now >= this.clockAt(it.packDay ?? it.day, DAY_START)) {
      const packer = this.planPacker(it);
      if (packer) {
        it.packer = packer.id;
        it.packMessage = this.planAskPerson(it, packer.id, 'worker', 'PACK', now);
        this.planLog(it, packer.name + ' has been asked to pack it.', now);
      } else this.planLog(it, 'No yardsman in the team, so nobody was sent a message.', now);
      it.stage = 'PACKING';
    }
    if (it.status === 'PLANNED' && it.stage !== 'WAITING') it.status = 'ACTIVE';
    it.problem =
      it.stage === 'PACKING' && !it.packer ? 'Nobody was asked to pack it: add a yardsman to the team.' : null;
  },
  // One reminder for an ask that has had no answer for two hours, while its time is still ahead. In the app only (a text message later).
  /** @param {number} now */
  clockRemind(now) {
    for (const m of this.planRows(ASKED_MSGS)) {
      if (!m.needsAnswer || m.remindedAt || now - Date.parse(m.sentAt) < REMIND_MS) continue;
      if (now >= this.clockAt(m.day, m.time)) continue;
      m.remindedAt = iso(now);
      m.reminders = 1;
      this.repo.save(m);
      this.notify(
        'Reminder sent',
        'Reminded ' + (m.personName || 'someone') + ': no answer yet about ' + dayLabel(m.day) + '.',
        m.site,
      );
    }
  },
  // Once a company day: paperwork that has expired, expires within two weeks or is due for review, said in one line.
  /** @param {number} now @param {string} today */
  clockPaperwork(now, today) {
    const state = this.repo.all('clockState')[0] ?? null;
    if (state?.paperworkDay === today) return;
    const months = this.paperMonths?.(),
      due = this.repo
        .all('paperwork')
        .map((/** @type {any} */ p) => paperState(p, today, months).status)
        .filter((/** @type {string} */ s) => s === 'EXPIRED' || s === 'SOON').length;
    if (due)
      this.notify(
        'Paperwork',
        plural(due, 'paper', 'papers') + ' need looking at: expired, expiring or due for review.',
        null,
      );
    if (state) this.repo.save({ ...state, paperworkDay: today });
    else this.repo.add('clockState', { paperworkDay: today });
  },
};
// The clock's own timer: every 30 s, each LIVE company in its own transaction, as an owner of it (the clock writes no ledger rows). It does not
// use the engine lease: every step writes only when something changed and a message is sent once (its status), so two servers on one database
// would still send each ask once. Returns stop().
/** @param {import('node:sqlite').DatabaseSync} db @param {{Simulation:any,intervalMs?:number,now?:()=>number}} options */
export function startClock(db, { Simulation, intervalMs = 30000, now = Date.now }) {
  let stopped = false,
    timer = null;
  const round = () => {
    try {
      clockRound(db, Simulation, now());
    } catch (/** @type {any} */ error) {
      logError('clock_error', { message: error.message });
    } finally {
      if (!stopped) {
        timer = setTimeout(round, intervalMs);
        timer.unref?.();
      }
    }
  };
  timer = setTimeout(round, Math.min(intervalMs, 1000));
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
// One round of the clock for every LIVE company (also run by tests and the catch-up after a restart).
/** @param {import('node:sqlite').DatabaseSync} db @param {any} Simulation @param {number} at */
export function clockRound(db, Simulation, at) {
  let n = 0;
  for (const row of cached(
    db,
    "SELECT ur.company_id,ur.user_id id FROM companies c JOIN user_roles ur ON ur.company_id=c.id AND ur.role='OWNER' WHERE c.mode='LIVE' GROUP BY ur.company_id",
  ).all()) {
    try {
      atomic(db, () => new Simulation(db, row).clockPass(at));
      n++;
    } catch (/** @type {any} */ error) {
      logError('clock_company_error', { company: row.company_id, message: error.message });
    }
  }
  return n;
}
