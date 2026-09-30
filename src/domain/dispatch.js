// @ts-check
// Today as a real yard's dispatch tool (ADR 0010, audit #33 and §7.3). Mixed into Simulation.prototype (this = the Simulation).
// A booking here is an instruction that waits for people: the driver's own yes (their phone) or the office's for them; the yard's pack;
// a leading hand's or the office's "On site" tap; a Done tap on a yard task. Nothing in this file runs by itself: the business clock only
// sends asks and flags (clockRestack is the one clock branch here, and it flags). Views: the Dispatch lanes of Today, the driver's run
// sheet, and what each person's phone shows (crewMe). The Practice yard never reaches any of it (requireLive).
import { requireRule } from './geometry.js';
import { AppError } from '../service.js';
import { requireLive } from './mode.js';
import { addDays, dayLabel } from './schedule.js';
import { DAY_END, timeWords } from './plantime.js';
import { PLAN_OPEN, PLAN_FIXABLE } from './plan.js';
import { TRIP_CONFIRM_OPS, PACK_OPS } from './trips.js';
import { mobileWords } from './team.js';
/** Office commands of this file (operations.manage). @type {string[]} */
export const DISPATCH_OPS = ['planSend', 'planMoveDay', 'planCopyCrews'];
/** Taps a person may make from their own phone as well as the office (asks.answer; scoped inside each command). @type {string[]} */
export const PHONE_TAP_OPS = ['messageAnswer', 'messageSeen', 'crewSignOn', 'planDone', 'taskStep', 'taskDone'];
/** Everything /api/crew/commands/<action> accepts (server.js): the trip confirmations, the yard's packs and counts, and the taps. */
export const CREW_PHONE_OPS = new Set([...TRIP_CONFIRM_OPS, ...PACK_OPS, ...PHONE_TAP_OPS]);
/** A trip's one state dot on the lanes: derived from the records, never from a timer. */
export const DOTS = ['DRAFT', 'BOOKED', 'ASKED', 'YES', 'ARRIVED', 'PACKED', 'LOADED', 'AT_SITE', 'DELIVERED', 'BACK'];
export const DOT_WORDS = {
  DRAFT: 'Draft',
  BOOKED: 'Booked',
  ASKED: 'Asked',
  YES: 'Yes',
  ARRIVED: 'At yard', // the driver's arrival at the pickup (ADR 0012), a light step before Packed / Loaded
  PACKED: 'Packed',
  LOADED: 'Loaded',
  AT_SITE: 'At site', // arrived at the drop, before Delivered
  DELIVERED: 'Delivered',
  BACK: 'Back',
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** @type {(ms:number)=>string} */
const iso = (ms) => new Date(ms).toISOString();
/** @type {(n:number,one:string,many?:string)=>string} */
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
/** @type {(v:unknown)=>string|null} */
const note = (v) => {
  if (v === undefined || v === null) return null;
  requireRule(typeof v === 'string', 'A reason must be text.');
  const s = v.trim();
  if (!s) return null;
  requireRule(s.length <= 200, 'A reason can be at most 200 characters.');
  return s;
};
const TYPE_ORDER = { TRUCK: 0, MATERIALS: 1, WORKERS: 2, RESTACK: 3 };

/** @type {Record<string,any> & ThisType<any>} */
export const dispatchMethods = {
  // ---------- who is tapping ----------
  // The person a phone belongs to (a crew device sign-in), with their kind and role; null for the office.
  dispatchPhone() {
    const c = this.user.crew;
    if (!c) return null;
    const id = c.person ?? c.driver,
      p = this.teamPerson(id);
    if (!p) throw new AppError(401, 'This phone is not signed in. Ask the office for a link.');
    return {
      id,
      kind: p.kind === 'driver' ? 'driver' : 'worker',
      role: p.kind === 'driver' ? 'DRIVER' : this.roleOf(p),
      person: p,
    };
  },
  // Provenance of a tap: the person's own (PERSON) from their phone, the office's for them (ON_BEHALF of that person).
  /** @param {string|null} forPerson */
  dispatchWho(forPerson) {
    const phone = this.dispatchPhone();
    if (phone) return { kind: 'PERSON', onBehalfOf: null, byName: phone.person.name, phone };
    return { kind: 'ON_BEHALF', onBehalfOf: forPerson, byName: this.user.name ?? 'The office', phone: null };
  },
  // ---------- DRAFT -> booked ----------
  // A draft becomes a booking: the asks go out now (the clock's step), a Materials draft makes its order (holding exact pieces) and its trip.
  planSend(/** @type {any} */ input) {
    requireLive(this);
    const it = this.planItemFor(input?.id),
      now = this.planNow();
    requireRule(it.status === 'DRAFT', 'This is already sent.');
    let tp = null;
    if (it.type === 'MATERIALS') {
      const site = this.planSite(it.site);
      if (it.truckPlan) {
        tp = this.repo.get(it.truckPlan, 'planItem');
        requireRule(tp.status !== 'DRAFT', this.planWhat(tp) + "'s booking is still a draft. Send it first.");
        requireRule(PLAN_OPEN.includes(tp.status) && tp.day === it.day, 'Choose a truck booked that day.');
      }
      // a gear list's draft keeps its direction (ADR 0012): a move holds at site A, a bring-back at the site
      const made = this.orderMake(
        it.direction ?? 'OUT',
        {
          site: site.id,
          fromSite: it.fromSite ?? null,
          lines: it.lines,
          neededOn: it.day,
          time: it.time,
          note: it.note,
        },
        { source: 'today', planItem: it.id },
      );
      this.planEdit(it.id, (/** @type {any} */ x) => {
        x.order = made.order.id;
      });
      if (tp) this.tripBook({ orders: [made.order.id], truckPlan: tp.id });
    }
    this.planEdit(it.id, (/** @type {any} */ x) => {
      x.status = 'PLANNED';
      x.stage =
        x.type === 'TRUCK'
          ? x.driver
            ? 'ASKING'
            : 'READY'
          : x.type === 'MATERIALS'
            ? 'WAITING'
            : x.type === 'WORKERS'
              ? 'BOOKED'
              : 'WAITING';
      x.sentAt = iso(now);
      this.planLog(x, 'Sent by ' + this.user.name + '.', now);
    });
    this.planStep(it.id);
    return this.planReply(
      it,
      this.planWhat(it) + ' is booked. ' + this.dispatchSentWords(this.repo.get(it.id, 'planItem')),
    );
  },
  /** @param {any} it */
  dispatchSentWords(it) {
    if (it.type === 'TRUCK') return it.driver ? this.planName(it.driver) + ' has been asked.' : 'No driver named.';
    if (it.type === 'WORKERS')
      return it.stage === 'ASKING'
        ? "They've been sent a message."
        : 'They get a message ' + dayLabel(addDays(it.day, -1)) + ' at 3:00 pm.';
    if (it.type === 'MATERIALS') return 'Its order holds the pieces now.';
    return 'The yard sees it on the day.';
  },
  // ---------- taps ----------
  // "On site": the arrival record of a Workers booking. A leading hand on the booking taps it on their phone (the person's own), or the
  // office taps it for them. Never the clock. people: who arrived (default: everyone on it who said yes and is not on site yet).
  crewSignOn(/** @type {any} */ input) {
    requireLive(this);
    const it = this.planItemFor(input?.item),
      now = this.planNow(),
      today = this.planToday(now);
    requireRule(it.type === 'WORKERS', 'Only a Workers booking is signed on.');
    requireRule(
      PLAN_OPEN.includes(it.status),
      it.status === 'DRAFT' ? 'Send this booking first.' : 'This is already finished.',
    );
    requireRule(it.day === today, it.day > today ? 'That day has not come yet.' : 'That day is over. Ask the office.');
    const phone = this.dispatchPhone();
    if (phone) {
      requireRule(
        phone.role === 'LEADING_HAND' && it.people.some((/** @type {any} */ p) => p.person === phone.id),
        'Only the leading hand on this booking (or the office) can sign the gang on.',
      );
    }
    const chosen =
      input.people === undefined || input.people === null
        ? it.people
            .filter((/** @type {any} */ p) => !p.moved && this.planMsg(p.message)?.status === 'YES')
            .map((/** @type {any} */ p) => p.person)
        : input.people;
    if (input.people === undefined || input.people === null)
      requireRule(
        chosen.length,
        it.people.some((/** @type {any} */ p) => p.moved && !p.homeAt)
          ? 'Everyone who said yes is already on site.'
          : 'Nobody has said yes yet. Say who is on site.',
      );
    requireRule(Array.isArray(chosen) && chosen.length > 0 && chosen.length <= 20, 'Say who is on site.');
    const who = this.dispatchWho(null);
    const names = [];
    this.planEdit(it.id, (/** @type {any} */ x) => {
      for (const id of new Set(chosen)) {
        const row = x.people.find((/** @type {any} */ p) => p.person === id);
        requireRule(row, this.planName(id, 'That person') + ' is not on this booking.');
        if (row.moved && !row.homeAt) continue;
        row.moved = true;
        row.arrivedAt = iso(now);
        row.homeAt = null;
        row.signOn = { at: iso(now), by: this.user.id, byName: who.byName, kind: who.kind };
        names.push(this.planName(id));
      }
      requireRule(names.length, 'Everyone you chose is already on site.');
      x.status = 'ACTIVE';
      x.stage = 'ON_SITE';
      x.problem = null;
      this.planLog(
        x,
        names.join(', ') +
          (names.length === 1 ? ' is' : ' are') +
          ' on site' +
          (who.kind === 'ON_BEHALF' ? ' (recorded by ' + who.byName + ')' : ' (' + who.byName + ')') +
          '.',
        now,
      );
    });
    this.notify('On site', names.join(', ') + ' at ' + this.planSiteName(it.site) + '.', it.site);
    return this.planReply(it, names.join(', ') + ' signed on at ' + this.planSiteName(it.site) + '.');
  },
  // "Done": a Workers day closed (the leading hand or the office) or a yard task finished (a yard hand or the office). The clock never does this.
  planDone(/** @type {any} */ input) {
    requireLive(this);
    const it = this.planItemFor(input?.id),
      now = this.planNow();
    requireRule(['WORKERS', 'RESTACK'].includes(it.type), 'Trucks and lists are done by their trips.');
    requireRule(
      PLAN_OPEN.includes(it.status),
      it.status === 'DRAFT' ? 'Send this booking first.' : 'This is already ' + String(it.status).toLowerCase() + '.',
    );
    requireRule(this.planToday(now) >= it.day, 'That day has not come yet.');
    const phone = this.dispatchPhone();
    if (phone) {
      if (it.type === 'WORKERS')
        requireRule(
          phone.role === 'LEADING_HAND' && it.people.some((/** @type {any} */ p) => p.person === phone.id),
          'Only the leading hand on this booking (or the office) can mark the day done.',
        );
      else requireRule(phone.role === 'YARDSMAN', 'Only a yard hand (or the office) can mark a re-stack done.');
    }
    const who = this.dispatchWho(null),
      reason = note(input.note);
    this.planEdit(it.id, (/** @type {any} */ x) => {
      x.status = 'DONE';
      x.stage = 'DONE';
      x.doneAt = iso(now);
      x.problem = null;
      x.unconfirmedAt = null;
      x.why = null;
      x.done = { at: iso(now), by: this.user.id, byName: who.byName, kind: who.kind, note: reason };
      if (x.type === 'WORKERS') for (const p of x.people) if (p.moved && !p.homeAt) p.homeAt = iso(now);
      if (x.type === 'RESTACK') x.finishedAt = iso(now);
      this.planLog(
        x,
        'Done' +
          (reason ? ': ' + reason : '') +
          (who.kind === 'ON_BEHALF' ? ' (recorded by ' + who.byName + ')' : ' (' + who.byName + ')') +
          '.',
        now,
      );
      this.planCloseMsgs(x, now);
    });
    return this.planReply(it, this.planWhat(it) + ' is done.');
  },
  // ----- RESTACK in a real yard: a dated task. Begun on its day (a label), flagged when the day ends with no Done tap. -----
  /** @param {any} it @param {number} now @param {string} today */
  clockRestack(it, now, today) {
    if (this.clockOver(it, now)) {
      this.clockUnconfirmed(it, now, 'nobody tapped Done on the re-stack');
      return;
    }
    if (this.clockBegun(it, now) && today >= it.day) {
      if (it.status === 'PLANNED') it.status = 'ACTIVE';
      it.stage = 'TODO';
    }
    it.problem = null;
  },
  // ---------- the day ----------
  // Move the day (weather): every open item of one day to another, all or nothing (a refusal anywhere undoes the whole command, since a
  // command is one transaction). Lists stay on their trucks when the truck booking moves with them.
  planMoveDay(/** @type {any} */ input) {
    requireLive(this);
    const cal = this.planNowCal(),
      from = input?.from;
    requireRule(typeof from === 'string' && DAY.test(from) && addDays(from, 0) === from, 'Choose the day to move.');
    const to = this.planDay(input?.to, cal);
    requireRule(to !== from, 'That is the same day.');
    const items = this.planDayItems(from, null, { open: false })
      .filter((/** @type {any} */ i) => PLAN_FIXABLE.includes(i.status))
      .sort(
        (/** @type {any} */ a, /** @type {any} */ b) =>
          TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || String(a.time).localeCompare(String(b.time)),
      );
    requireRule(items.length, 'Nothing to move on ' + dayLabel(from) + '.');
    // remember each list's truck booking: the truck move unlinks it, and the list's own move links it again on the new day
    const onTruck = new Map(
      items
        .filter((/** @type {any} */ i) => i.type === 'MATERIALS' && i.truckPlan)
        .map((/** @type {any} */ i) => [i.id, i.truckPlan]),
    );
    const movingTrucks = new Set(
      items.filter((/** @type {any} */ i) => i.type === 'TRUCK').map((/** @type {any} */ i) => i.id),
    );
    const moved = [];
    // a list already packed for a truck that moves: its trip is booked again on the new day, so the yard packs it again (the count starts over)
    const repack = items.filter(
      (/** @type {any} */ i) =>
        i.type === 'TRUCK' && this.planLiveTrips(i).some((/** @type {any} */ t) => t.state === 'PACKED'),
    ).length;
    for (const it of items) {
      const tp = onTruck.get(it.id);
      const r = this.planMove({
        id: it.id,
        day: to,
        ...(tp && movingTrucks.has(tp) ? { truckPlan: tp } : {}),
      });
      moved.push({ id: it.id, type: it.type, words: r.message });
    }
    return {
      from,
      to,
      moved: moved.length,
      items: moved,
      message:
        plural(moved.length, 'thing') +
        ' moved from ' +
        dayLabel(from) +
        ' to ' +
        dayLabel(to) +
        '. Everyone is asked again.' +
        (repack ? ' Packed lists need packing again on the new day.' : ''),
    };
  },
  // Copy yesterday's crews: every Workers booking of one day made again on another, the same people, site, time and count. All or nothing.
  planCopyCrews(/** @type {any} */ input) {
    requireLive(this);
    const cal = this.planNowCal(),
      from = input?.from ?? addDays(cal.today, -1);
    requireRule(typeof from === 'string' && DAY.test(from) && addDays(from, 0) === from, 'Choose the day to copy.');
    const to = this.planDay(input?.to ?? cal.today, cal);
    requireRule(to !== from, 'That is the same day.');
    const crews = this.planDayItems(from, 'WORKERS', { open: false }).filter(
      (/** @type {any} */ i) => i.status !== 'CANCELLED',
    );
    requireRule(crews.length, 'No crews on ' + dayLabel(from) + ' to copy.');
    const made = [];
    for (const it of crews) {
      const people = it.people
        .map((/** @type {any} */ p) => p.person)
        .filter((/** @type {string} */ id) => this.teamPerson(id));
      const r = this.planWorkers({
        day: to,
        time: it.time,
        site: it.site,
        count: it.count,
        people,
        note: it.note,
        draft: input?.draft === true,
      });
      made.push({ id: r.item.id, site: it.site, siteName: this.planSiteName(it.site), time: it.time, count: it.count });
    }
    return {
      from,
      to,
      copied: made.length,
      items: made,
      message: plural(made.length, 'crew') + ' copied from ' + dayLabel(from) + ' to ' + dayLabel(to) + '.',
    };
  },
  // ---------- suggestions ----------
  // "Next free truck" for an order waiting: a suggestion only, never a booking. The day's truck bookings whose driver said yes first, then
  // any booked with a driver, then a truck with no booking that day. Null when there is nothing to suggest.
  /** @param {any} order */
  tripSuggestTruck(order) {
    if (!order || order.status !== 'OPEN') return null;
    const day = order.neededOn ?? this.planToday();
    const bookings = this.planDayItems(day, 'TRUCK').filter(
      (/** @type {any} */ x) => PLAN_OPEN.includes(x.status) && x.truck && !x.hire,
    );
    const rank = (/** @type {any} */ x) => (this.planMsg(x.message)?.status === 'YES' ? 0 : x.driver ? 1 : 2);
    const b = bookings.sort((x, y) => rank(x) - rank(y) || String(x.time).localeCompare(String(y.time)))[0];
    if (b)
      return {
        truckPlan: b.id,
        truck: b.truck,
        name: this.planName(b.truck, 'A truck'),
        driver: b.driver ?? null,
        driverName: b.driver ? this.planName(b.driver) : null,
        why:
          rank(b) === 0
            ? 'booked, driver said yes'
            : rank(b) === 1
              ? 'booked, waiting for the driver'
              : 'booked, no driver yet',
      };
    const booked = new Set(this.planDayItems(day, 'TRUCK').map((/** @type {any} */ x) => x.truck));
    const t = this.repo
      .all('truck')
      .filter((/** @type {any} */ x) => !x.retired && !x.hired && !booked.has(x.id))
      .sort((/** @type {any} */ a, /** @type {any} */ b) =>
        String(a.name).localeCompare(String(b.name), undefined, { numeric: true }),
      )[0];
    return t
      ? { truckPlan: null, truck: t.id, name: t.name, driver: null, driverName: null, why: 'not booked that day' }
      : null;
  },
  // ---------- the Dispatch lanes view of Today (GET /api/dispatch?day=) ----------
  /** @param {any} trip @param {any} booking */
  tripDot(trip, booking) {
    if (booking?.status === 'DRAFT') return 'DRAFT';
    const s = trip.state;
    if (s === 'RETURNED') return 'BACK';
    if (s === 'DELIVERED' || s === 'DELIVERED_SHORT') return 'DELIVERED';
    if (s === 'LOADED' || s === 'COLLECTED') return trip.steps?.ARRIVED_DROP ? 'AT_SITE' : 'LOADED';
    if (s === 'PACKED') return 'PACKED';
    if (trip.steps?.ARRIVED_PICKUP) return 'ARRIVED';
    const a = booking ? this.planAnswerOf(this.planMsg(booking.message), this.planNow()) : 'NOT_SENT';
    return a === 'YES' ? 'YES' : a === 'WAITING' || a === 'NO_ANSWER' || a === 'NO' ? 'ASKED' : 'BOOKED';
  },
  /** @param {{day?:string|null}} [query] */
  dispatchView({ day = null } = {}) {
    requireLive(this);
    this.auth.require(this.user, 'operations.manage');
    const cal = this.planNowCal(),
      now = this.planNow(),
      d = day && DAY.test(day) ? day : cal.today;
    const bookings = this.planDayItems(d, 'TRUCK').filter((/** @type {any} */ x) => x.status !== 'CANCELLED'),
      trips = this.tripRows(
        'trip',
        "json_extract(data,'$.state')<>'CANCELLED' AND json_extract(data,'$.truckPlan') IN (SELECT value FROM json_each(?))",
        JSON.stringify(bookings.map((/** @type {any} */ b) => b.id)),
      );
    const started = (/** @type {any} */ t, /** @type {any} */ b) =>
      d < cal.today || (d === cal.today && now >= this.planAt(d, t.time ?? b.time));
    const lanes = bookings.map((/** @type {any} */ b) => {
      const answer = this.planAnswerOf(this.planMsg(b.message), now);
      const rows = trips
        .filter((/** @type {any} */ t) => t.truckPlan === b.id)
        .sort(
          (/** @type {any} */ x, /** @type {any} */ y) =>
            String(x.time ?? b.time).localeCompare(String(y.time ?? b.time)) || x.number - y.number,
        )
        .map((/** @type {any} */ t) => {
          const dot = this.tripDot(t, b);
          // a known problem comes first: the driver said no, or the day has started and nothing is confirmed
          const unconfirmed =
            !!t.flag ||
            (answer === 'NO' && !['LOADED', 'DELIVERED', 'BACK'].includes(dot)) ||
            (['BOOKED', 'ASKED'].includes(dot) && started(t, b)) ||
            (t.state === 'RETURNED' && (t.countPending || (t.notBack ?? []).length > 0));
          const lines = this.tripLines(t);
          return {
            id: t.id,
            label: this.tripLabel(t),
            time: t.time ?? b.time,
            timeWords: timeWords(t.time ?? b.time),
            direction: t.direction,
            site: t.site,
            siteName: this.planSiteName(t.site),
            state: t.state,
            stateWords: this.tripStateWords(t),
            dot,
            dotWords: dot === 'ASKED' && answer === 'NO' ? "Asked · can't make it" : DOT_WORDS[dot],
            unconfirmed,
            flag: t.flag ?? null,
            // what is really on it: packed (the yard's count) once packed, else what was asked
            pieces: lines.reduce((/** @type {number} */ n, /** @type {any} */ l) => n + (l.packed ?? l.asked), 0),
            asked: lines.reduce((/** @type {number} */ n, /** @type {any} */ l) => n + l.asked, 0),
            packed: t.steps?.PACKED
              ? lines.reduce((/** @type {number} */ n, /** @type {any} */ l) => n + (l.packed ?? 0), 0)
              : null,
            orders: t.orders,
          };
        });
      const laneUnconfirmed =
        rows.some((r) => r.unconfirmed) ||
        (b.status !== 'DRAFT' && b.status !== 'DONE' && b.driver && answer === 'NO') ||
        (b.status !== 'DRAFT' && b.status !== 'DONE' && b.driver && answer !== 'YES' && started({ time: b.time }, b));
      return {
        booking: b.id,
        truck: b.truck ?? b.hire?.truck ?? null,
        truckName: b.truck ? this.planName(b.truck, 'Truck') : b.hire ? 'Hire truck' : (b.truckGone ?? 'Truck'),
        time: b.time,
        timeWords: timeWords(b.time),
        driver: b.driver ?? null,
        driverName: b.driver ? this.planName(b.driver) : null,
        answer,
        status: b.status,
        stage: b.stage,
        draft: b.status === 'DRAFT',
        problem: b.problem ?? null,
        dot: rows.length
          ? null
          : b.status === 'DRAFT'
            ? 'DRAFT'
            : answer === 'YES'
              ? 'YES'
              : ['WAITING', 'NO_ANSWER', 'NO'].includes(answer)
                ? 'ASKED'
                : 'BOOKED',
        unconfirmed: laneUnconfirmed,
        trips: rows,
      };
    });
    lanes.sort(
      (a, b) =>
        Number(b.unconfirmed) - Number(a.unconfirmed) ||
        a.time.localeCompare(b.time) ||
        a.truckName.localeCompare(b.truckName),
    );
    const bookedTrucks = new Set(lanes.map((l) => l.truck));
    const unbooked = this.repo
      .all('truck')
      .filter((/** @type {any} */ t) => !t.retired && !t.hired && !bookedTrucks.has(t.id))
      .map((/** @type {any} */ t) => ({ id: t.id, name: t.name }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const waiting = this.tripRowsBy('objects_order_status', 'order', "json_extract(data,'$.status')='OPEN'")
      .filter((/** @type {any} */ o) => (o.neededOn ?? d) <= d)
      .map((/** @type {any} */ o) => ({ ...this.orderView(o), suggestedTruck: this.tripSuggestTruck(o) }));
    // the day's people: drivers by answer, workers per site with who has signed on, the yard's packs and its task
    const drivers = this.teamDrivers().map((/** @type {any} */ dr) => {
      const b = bookings.find((/** @type {any} */ x) => x.driver === dr.id && x.status !== 'DRAFT');
      return {
        id: dr.id,
        name: dr.name,
        booking: b?.id ?? null,
        truckName: b ? this.planName(b.truck, 'Truck') : null,
        answer: b ? this.planAnswerOf(this.planMsg(b.message), now) : null,
      };
    });
    const workers = this.planDayItems(d, 'WORKERS')
      .filter((/** @type {any} */ x) => x.status !== 'CANCELLED')
      .map((/** @type {any} */ x) => ({
        item: x.id,
        site: x.site,
        siteName: this.planSiteName(x.site),
        time: x.time,
        timeWords: timeWords(x.time),
        count: x.count,
        draft: x.status === 'DRAFT',
        status: x.status,
        stage: x.stage,
        yes: x.people.filter((/** @type {any} */ p) => this.planMsg(p.message)?.status === 'YES').length,
        onSite: x.people.filter((/** @type {any} */ p) => p.moved && !p.homeAt).length,
        people: x.people.map((/** @type {any} */ p) => ({
          person: p.person,
          name: this.planName(p.person),
          answer: this.planAnswerOf(this.planMsg(p.message), now),
          onSite: !!p.moved && !p.homeAt,
        })),
      }));
    const restack = this.planDayItems(d, 'RESTACK').find((/** @type {any} */ x) => x.status !== 'CANCELLED') ?? null;
    const yard = {
      toPack: lanes.reduce(
        (n, l) => n + l.trips.filter((t) => t.direction === 'OUT' && t.state === 'BOOKED').length,
        0,
      ),
      packed: lanes.reduce((n, l) => n + l.trips.filter((t) => t.state === 'PACKED').length, 0),
      restack: restack
        ? {
            id: restack.id,
            time: restack.time,
            status: restack.status,
            stage: restack.stage,
            draft: restack.status === 'DRAFT',
          }
        : null,
    };
    return {
      day: d,
      dayLabel: dayLabel(d),
      today: cal.today,
      now: iso(now),
      lanes,
      unbooked,
      waiting,
      people: { drivers, workers, yard },
      dots: DOTS.map((k) => ({ code: k, words: DOT_WORDS[k] })),
      needsYou: this.needsYou(),
    };
  },
  // ---------- the run sheet (GET /api/run-sheet?day=&driver=): one printed page per driver ----------
  /** @param {{day?:string|null,driver?:string|null}} [query] */
  runSheet({ day = null, driver = null } = {}) {
    requireLive(this);
    this.auth.require(this.user, 'operations.manage');
    const cal = this.planNowCal(),
      d = day && DAY.test(day) ? day : cal.today;
    const bookings = this.planDayItems(d, 'TRUCK').filter(
      (/** @type {any} */ b) =>
        !['CANCELLED', 'DRAFT'].includes(b.status) && b.driver && (!driver || b.driver === driver),
    );
    const sheets = bookings.map((/** @type {any} */ b) => this.runSheetFor(b, d));
    return { day: d, dayLabel: dayLabel(d), company: this.planCompany(), sheets };
  },
  /** @param {any} b @param {string} d */
  runSheetFor(b, d) {
    const dr = this.teamPerson(b.driver),
      answer = this.planAnswerOf(this.planMsg(b.message), this.planNow());
    const trips = this.tripRows(
      'trip',
      "json_extract(data,'$.truckPlan')=? AND json_extract(data,'$.state')<>'CANCELLED'",
      b.id,
    )
      .sort(
        (/** @type {any} */ x, /** @type {any} */ y) =>
          String(x.time ?? b.time).localeCompare(String(y.time ?? b.time)) || x.number - y.number,
      )
      .map((/** @type {any} */ t) => {
        const v = this.tripView(t);
        const notes = t.orders
          .map((/** @type {string} */ id) => {
            try {
              return this.repo.get(id, 'order').note;
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        return {
          id: t.id,
          label: v.label,
          time: v.time,
          timeWords: timeWords(v.time),
          direction: t.direction,
          words: (t.direction === 'OUT' ? 'Deliver to ' : 'Bring back from ') + v.siteName,
          site: v.site,
          siteName: v.siteName,
          address: v.address,
          contact: v.contact,
          phone: v.phone,
          // the load: what left (loaded or collected), else what the yard packed, else what was asked; asked beside it when different
          lines: v.lines.map((/** @type {any} */ l) => ({
            product: l.product,
            name: l.name,
            quantity: l.loaded || l.collected || l.packed || l.asked,
            asked: l.asked,
            packed: l.packed ?? null,
          })),
          pieces: v.lines.reduce(
            (/** @type {number} */ n, /** @type {any} */ l) => n + (l.loaded || l.collected || l.packed || l.asked),
            0,
          ),
          receivedBy: t.steps?.DELIVERED?.receivedBy ?? null,
          state: t.state,
          stateWords: v.stateWords,
          notes,
        };
      });
    return {
      booking: b.id,
      day: d,
      dayLabel: dayLabel(d),
      driver: {
        id: b.driver,
        name: dr?.name ?? 'Driver',
        mobile: dr?.mobile ?? null,
        mobileWords: dr?.mobile ? mobileWords(dr.mobile) : null,
      },
      answer,
      truck: { id: b.truck ?? null, name: b.truck ? this.planName(b.truck, 'Truck') : 'Hire truck' },
      time: b.time,
      timeWords: timeWords(b.time),
      note: b.note ?? null,
      trips,
    };
  },
  // ---------- a person's phone (GET /api/crew/me) ----------
  // What this phone shows: a driver's trips (the run sheet), everyone's own open asks with I'll be there / Can't make it, a yard hand's
  // lists to pack and returns to count and the re-stack, a leading hand's gang to sign on. Only their own.
  crewMe() {
    requireLive(this);
    const phone = this.dispatchPhone();
    if (!phone) throw new AppError(404, 'Record not found in your company.');
    const base = this.crewTrips(),
      today = base.today,
      tomorrow = addDays(today, 1);
    // the worker's own day: their tasks in priority order and their roster (tasks.js, roster.js; part 5)
    const myDay =
      phone.kind === 'worker' && typeof this.taskMyDay === 'function' ? this.taskMyDay(phone.id, today) : null;
    // a list whose task they are on is theirs through the task's steps: its older Pack ask and pack card would say the same thing twice
    const onTask = new Set(
      [...(myDay?.tasks ?? []), ...(myDay?.tomorrow ?? [])].map((/** @type {any} */ t) => t.list).filter(Boolean),
    );
    const asks = this.personMessages(phone.kind, phone.id).filter(
      (/** @type {any} */ v) =>
        (v.canAnswer || v.canSee || v.answer === 'WAITING' || (v.answeredAt && v.day >= today)) &&
        !(v.subject === 'PACK' && v.item && onTask.has(v.item)),
    );
    const perms = this.auth.permissions(this.user),
      yard = perms.includes('packs.confirm');
    let packs = [],
      returns = [],
      tasks = [];
    if (yard) {
      const rows = this.tripRows(
        'trip',
        "json_extract(data,'$.state') IN ('BOOKED','PACKED') AND json_extract(data,'$.direction')='OUT'",
      );
      packs = rows
        .map((/** @type {any} */ t) => [this.tripPlan(t), t])
        .filter(
          ([tp]) => tp && !['CANCELLED', 'DRAFT'].includes(tp.status) && (tp.day === today || tp.day === tomorrow),
        )
        .map(([, t]) => this.tripView(t))
        .filter((/** @type {any} */ v) => !(v.list && onTask.has(v.list.id)))
        .sort((a, b) => String(a.day).localeCompare(String(b.day)) || String(a.time).localeCompare(String(b.time)));
      returns = this.tripRowsBy(
        'objects_trip_state',
        'trip',
        "json_extract(data,'$.state')='RETURNED' AND json_extract(data,'$.countPending')=1",
      ).map((/** @type {any} */ t) => this.tripView(t));
      // today's re-stack (Done), and tomorrow's so the yard knows what is coming (read-only until the day)
      tasks = [today, tomorrow].flatMap((day) =>
        this.planDayItems(day, 'RESTACK')
          .filter((/** @type {any} */ x) => PLAN_OPEN.includes(x.status))
          .map((/** @type {any} */ x) => ({
            id: x.id,
            type: 'RESTACK',
            day,
            dayWords: day === today ? 'Today' : 'Tomorrow',
            time: x.time,
            timeWords: timeWords(x.time),
            words: 'Re-stack the yard',
            canDone: day === today,
          })),
      );
    }
    let gang = [];
    if (phone.role === 'LEADING_HAND')
      // today's gang (On site, Day done), and tomorrow's to see who said yes (read-only until the day)
      gang = [today, tomorrow].flatMap((day) =>
        this.planDayItems(day, 'WORKERS')
          .filter(
            (/** @type {any} */ x) =>
              PLAN_OPEN.includes(x.status) && x.people.some((/** @type {any} */ p) => p.person === phone.id),
          )
          .map((/** @type {any} */ x) => ({
            item: x.id,
            day,
            dayWords: day === today ? 'Today' : 'Tomorrow',
            site: x.site,
            siteName: this.planSiteName(x.site),
            time: x.time,
            timeWords: timeWords(x.time),
            people: x.people.map((/** @type {any} */ p) => ({
              person: p.person,
              name: this.planName(p.person),
              answer: this.planAnswerOf(this.planMsg(p.message), this.planNow()),
              onSite: !!p.moved && !p.homeAt,
            })),
            canSignOn: day === today && x.people.some((/** @type {any} */ p) => !p.moved),
            canDone: day === today,
          })),
      );
    const roster =
      phone.kind === 'worker' && typeof this.rosterMine === 'function' ? this.rosterMine(phone.id, today) : null;
    return {
      ...base,
      person: { id: phone.id, name: phone.person.name, kind: phone.kind, role: phone.role },
      can: {
        trips: phone.kind === 'driver',
        asks: true,
        packs: yard,
        signOn: phone.role === 'LEADING_HAND',
        done: yard || phone.role === 'LEADING_HAND',
        tasks: !!(myDay?.tasks.length || myDay?.tomorrow.length),
      },
      asks,
      packs,
      returns,
      tasks,
      gang,
      myDay,
      roster,
      dayEnd: DAY_END,
    };
  },
};
