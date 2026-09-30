// @ts-check
// Gear lists (ADR 0011, the owner's brief of 2026-09-30): "the list that will be prepared and loaded when the truck arrives". One model for
// both yards, built on Today's MATERIALS item, the orders and trips of ADR 0009 and the truck booking of Today:
//   a named list ('Bondi gear') with exact lines, FROM and TO among {this yard, a site} (yard -> site OUT, site -> site MOVE, site -> yard
//   BACK), a day and a time, and the truck + driver booked in the same tap (the truck goes to where the gear is and delivers to where it
//   goes). The list is on the Daily activities calendar the moment it is confirmed. The day before at 3 pm the driver is asked "Confirm
//   you'll be ready?"; at 6 am on the day a notice says today's run; then the chain: Arrived at yard · Packed · Loaded · Arrived at site ·
//   Landed (gear-chain.js), each a dot on the item.
// Practice yard (DEMO): the simulated crew packs, the truck autopilot drives (plan.js / game.js) and writes the same marks on the item
// (kind ENGINE); simulated people answer the asks. Real yard (LIVE): only the driver's phone (tripArrived, tripLoaded, ...) or the office
// for them changes a dot; the clock only asks and flags. Mixed into Simulation.prototype (this = the Simulation).
import { requireRule } from './geometry.js';
import { AppError } from '../service.js';
import { addDays, dayLabel } from './schedule.js';
import { DAY_START, SEND_BEFORE, DAY_END, atLocal, parseTime, timeWords } from './plantime.js';
import { PLAN_OPEN, PLAN_FIXABLE } from './plan.js';
import { chainOf, chainWords, CHAIN_STEPS } from './gear-chain.js';
/** Office commands of this file (operations.manage; on the LIVE allow-list). @type {string[]} */
export const GEAR_OPS = ['gearListCreate', 'gearListUpdate'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** @type {(ms:number)=>string} */
const iso = (ms) => new Date(ms).toISOString();
/** @type {(names:string[])=>string} */
const listWords = (names) =>
  names.length < 2 ? (names[0] ?? '') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
// open gear lists on one day (the day panel, the asks): through the day index of migration 010
const GEAR_DAY =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='planItem' AND json_extract(data,'$.day')=? AND json_extract(data,'$.type')='MATERIALS' AND json_extract(data,'$.gear')=1 AND json_extract(data,'$.status') IN ('PLANNED','ACTIVE') ORDER BY rowid";
const GEAR_RANGE =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='planItem' AND json_extract(data,'$.day') BETWEEN ? AND ? AND json_extract(data,'$.type')='MATERIALS' AND json_extract(data,'$.gear')=1 AND json_extract(data,'$.status')<>'CANCELLED' ORDER BY json_extract(data,'$.day'),json_extract(data,'$.time'),rowid";

/** @type {Record<string,any> & ThisType<any>} */
export const gearMethods = {
  // ---------- places ----------
  // {kind:'yard'} or {kind:'site', id}: the two ends of a list. A site must be active (and the viewer's own, for a supervisor).
  /** @param {any} v @param {string} what */
  gearPlace(v, what) {
    requireRule(
      v && typeof v === 'object' && ['yard', 'site'].includes(v.kind),
      'Choose where the gear goes ' + what + '.',
    );
    if (v.kind === 'yard') {
      const yard = this.planYard();
      requireRule(yard, 'Set up your yard first.');
      return { kind: 'yard', id: yard.id, name: 'the yard' };
    }
    const s = this.planSite(v.id);
    return { kind: 'site', id: s.id, name: s.name };
  },
  /** The name of a place id: a site's name, or 'the yard'. @param {string|null} id */
  gearPlaceName(id) {
    if (!id) return 'the yard';
    try {
      const o = this.repo.get(id);
      return o.kind === 'yard' ? 'the yard' : (o.name ?? 'the site');
    } catch {
      return 'the site';
    }
  },
  /** The from and to of a list item, as places. @param {any} it */
  gearEnds(it) {
    const yard = this.planYard(),
      y = { kind: 'yard', id: yard?.id ?? null, name: 'the yard' },
      site = (id) => ({ kind: 'site', id, name: this.planSiteName(id) });
    const d = it.direction ?? 'OUT';
    if (d === 'OUT') return { from: y, to: site(it.site) };
    if (d === 'MOVE') return { from: site(it.fromSite), to: site(it.site) };
    return { from: site(it.site), to: y };
  },
  // ---------- the command: one tap makes the list, books the truck and driver, and puts it on the calendar ----------
  gearListCreate(/** @type {any} */ input) {
    requireRule(input && typeof input === 'object', 'Choose where the gear goes, the parts, a day and a time.');
    const cal = this.planNowCal(),
      now = this.planNow(),
      day = this.planDay(input.day, cal),
      time = parseTime(input.time),
      yard = this.planYard();
    requireRule(yard, 'Set up your yard first.');
    const from = this.gearPlace(input.from, 'from'),
      to = this.gearPlace(input.to, 'to');
    requireRule(!(from.kind === 'yard' && to.kind === 'yard'), 'Choose a site.');
    requireRule(!(from.kind === 'site' && to.kind === 'site' && from.id === to.id), 'Choose two different sites.');
    const direction = from.kind === 'yard' ? 'OUT' : to.kind === 'yard' ? 'BACK' : 'MOVE';
    const lines = this.planMaterialLines(input.lines, yard);
    requireRule(lines.length, 'Pick the parts.');
    const name = this.gearName(input.name, direction, to);
    const draft = input.draft === true;
    if (draft) requireRule(this.live(), 'Drafts are for your real yard.');
    this.planWhen('MATERIALS', day, time, now);
    const site = direction === 'BACK' ? from : to; // the item's site: where it goes, or (a bring-back) where it comes from, as before
    const note = this.gearNote(input.note);
    // the list first, then its truck: a booking made here names the list (viaGear), so the driver gets the list's one ask the day before
    const it = this.repo.add('planItem', {
      type: 'MATERIALS',
      day,
      time,
      site: site.id,
      yard: yard.id,
      status: draft ? 'DRAFT' : 'PLANNED',
      stage: draft ? 'DRAFT' : 'WAITING',
      note,
      problem: null,
      log: [{ at: iso(now), text: (draft ? 'Drafted by ' : 'Confirmed by ') + this.user.name + '.' }],
      createdAt: iso(now),
      createdBy: this.user.id,
      updatedAt: iso(now),
      doneAt: null,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
      lines,
      pack: 'SAME_DAY',
      packDay: day,
      truckPlan: null,
      packer: null,
      packMessage: null,
      held: [],
      got: {},
      short: [],
      left: [],
      trips: [],
      // the gear list's own fields (ADR 0011 §2.1)
      name,
      direction,
      fromSite: direction === 'MOVE' ? from.id : null,
      gear: true,
      chain: {},
      driverAsk: null,
      dayNotice: null,
    });
    // the truck and driver: an existing booking of that truck that day is linked (never booked twice); else it is booked now
    const tp = this.gearTruck(input, day, time, draft, it.id);
    if (tp)
      this.planEdit(it.id, (/** @type {any} */ x) => {
        x.truckPlan = tp.id;
      });
    if (direction === 'OUT') {
      const who = this.planPacker(it);
      if (who)
        this.planEdit(it.id, (/** @type {any} */ x) => {
          x.packer = who.id;
        });
    }
    let held = '';
    if (!draft && this.live()) {
      const made = this.orderMake(
        direction,
        { site: site.id, fromSite: it.fromSite, lines, neededOn: day, time, note },
        { source: 'today', planItem: it.id },
      );
      this.planEdit(it.id, (/** @type {any} */ x) => {
        x.order = made.order.id;
      });
      if (tp) this.tripBook({ orders: [made.order.id], truckPlan: tp.id });
      held = ' ' + made.order.label + ': ' + made.heldWords;
    }
    // the workers on it: a task, when the tasks module is there (CREW's part; ADR 0011 §11.4)
    let task = null,
      rostered = [];
    if (Array.isArray(input.workers) && input.workers.length && typeof this.taskCreate === 'function') {
      const made = this.taskCreate({
        day,
        kind: 'LIST',
        list: it.id,
        workers: input.workers,
        roster: input.roster === true,
      });
      task = made?.task ?? null;
      rostered = made?.rostered ?? [];
    }
    this.planStep(it.id);
    const fresh = this.repo.get(it.id, 'planItem'),
      tpv = tp ? this.repo.get(tp.id, 'planItem') : null,
      driverName = tpv?.driver ? this.planName(tpv.driver, 'the driver') : null;
    const names = (task?.workers ?? []).map((/** @type {any} */ w) => w.name ?? this.planName(w.person));
    const message = draft
      ? name + ' drafted for ' + dayLabel(day) + '. Nobody is asked until you send it.'
      : name +
        ' on ' +
        dayLabel(day) +
        ' at ' +
        timeWords(time) +
        '. ' +
        (tpv
          ? this.planTruckWords(tpv).replace(/ \((big|small) truck\)$/, '') +
            (driverName ? ' with ' + driverName : '') +
            ' booked.'
          : 'No truck yet.') +
        (names.length ? ' ' + listWords(names) + (names.length === 1 ? ' is' : ' are') + ' on it.' : '') +
        (rostered.length ? ' ' + listWords(rostered) + ' rostered for ' + dayLabel(day) + ' too.' : '') +
        held;
    return {
      item: this.planItemView(fresh),
      truckItem: tpv ? this.planItemView(tpv) : null,
      task,
      message,
    };
  },
  /** The list's name: as typed (at most 60 characters), else the destination's ('Bondi gear', 'Yard gear'). */
  gearName(v, direction, to) {
    if (v !== undefined && v !== null && String(v).trim()) {
      requireRule(typeof v === 'string', 'The name must be text.');
      const s = v.trim().replace(/\s+/g, ' ');
      requireRule(s.length <= 60, 'A name can be at most 60 characters.');
      return s;
    }
    return (direction === 'BACK' ? 'Yard' : to.name) + ' gear';
  },
  gearNote(v) {
    if (v === undefined || v === null) return null;
    requireRule(typeof v === 'string', 'A note must be text.');
    const s = v.trim();
    if (!s) return null;
    requireRule(s.length <= 200, 'A note can be at most 200 characters.');
    return s;
  },
  // The truck booking for a list: input.truck is a fleet truck id, 'HIRE:BIG' / 'HIRE:SMALL' (the Practice yard only), or nothing.
  // A booking of that truck that day is linked (a different driver named is refused in the booking's own words); else planTruck makes it.
  /** @param {any} input @param {string} day @param {string} listTime @param {boolean} draft @param {string|null} [listId] the list a new booking is made for */
  gearTruck(input, day, listTime, draft, listId = null) {
    const truck = input.truck === undefined || input.truck === null || input.truck === '' ? null : input.truck,
      driver = input.driver === undefined || input.driver === null || input.driver === '' ? null : input.driver;
    if (!truck) return null;
    // a list for the half hour that has begun (today) still books its truck: at the next time still ahead (a booking is never in the past)
    const time =
      day === this.planToday() && this.planAt(day, listTime) <= this.planNow()
        ? (this.tripNextTime(day) ?? listTime)
        : listTime;
    requireRule(typeof truck === 'string', 'Choose a truck.');
    if (truck.startsWith('HIRE:')) {
      requireRule(!this.live(), 'Hire trucks come later.');
      const size = truck.slice(5);
      requireRule(['BIG', 'SMALL'].includes(size), 'Choose a big or a small hire truck.');
      return this.repo.get(this.planTruck({ day, time, hire: { size }, driver }).item.id, 'planItem');
    }
    const t = this.repo.get(truck, 'truck');
    requireRule(!t.retired, t.name + ' has been removed.');
    const same = this.planDayItems(day, 'TRUCK').find(
      (/** @type {any} */ x) => x.truck === t.id && (PLAN_OPEN.includes(x.status) || x.status === 'DRAFT'),
    );
    if (same) {
      if (driver && same.driver && same.driver !== driver)
        throw new AppError(
          409,
          t.name +
            ' is booked with ' +
            this.planName(same.driver, 'no driver') +
            ' that day. Change the driver on Today.',
        );
      if (driver && !same.driver) this.planAsk({ item: same.id, person: driver });
      return this.repo.get(same.id, 'planItem');
    }
    return this.repo.get(
      this.planTruck({
        day,
        time,
        truck: t.id,
        driver,
        viaGear: listId ?? true,
        ...(draft ? { draft: true } : {}),
      }).item.id,
      'planItem',
    );
  },
  // A truck booking made by a gear list asks its driver once: the list's READY the day before at 3 pm (gearAskItem), which the booking
  // then carries as its own message; plan.js and clock.js send no DRIVE ask while an open gear list is on it (viaGear names the list it
  // was made for, so this holds from the moment the booking is made, before the list points at it).
  /** @param {any} tp the TRUCK booking */
  gearAsksDriver(tp) {
    if (!tp?.viaGear || tp.type !== 'TRUCK') return false;
    // once its day has begun no READY can go (a list made that morning): the booking asks its driver as any booking does
    if (this.planNow() >= this.planAt(tp.day, DAY_START)) return false;
    const open = (/** @type {any} */ x) => x?.gear && ['PLANNED', 'ACTIVE', 'DRAFT'].includes(x.status);
    if (this.planDayItems(tp.day, 'MATERIALS').some((x) => open(x) && x.truckPlan === tp.id)) return true;
    if (typeof tp.viaGear !== 'string') return false;
    try {
      const it = this.repo.get(tp.viaGear, 'planItem');
      return open(it) && (it.truckPlan === tp.id || !it.truckPlan);
    } catch {
      return false;
    }
  },
  // Change a list: its name, and (through planMove, the same rules in both yards) its lines, day, time or truck. A truck change books or links
  // the truck booking as when the list was made. Cancel is planCancel, as for any item.
  gearListUpdate(/** @type {any} */ input) {
    const it = this.planItemFor(input?.id),
      now = this.planNow();
    requireRule(it.type === 'MATERIALS' && it.gear, 'Choose a gear list.');
    requireRule(PLAN_FIXABLE.includes(it.status), 'This is already ' + String(it.status).toLowerCase() + '.');
    let changed = false;
    if (input.name !== undefined && input.name !== null) {
      const name = this.gearName(input.name, it.direction, this.gearEnds(it).to);
      if (name !== it.name) {
        this.planEdit(it.id, (/** @type {any} */ x) => {
          x.name = name;
          this.planLog(x, 'Renamed to ' + name + '.', now);
        });
        changed = true;
      }
    }
    const move = {};
    if (input.day !== undefined && input.day !== null) move.day = input.day;
    if (input.time !== undefined && input.time !== null) move.time = input.time;
    if (input.lines !== undefined && input.lines !== null) move.lines = input.lines;
    if (input.truck !== undefined) {
      const day = move.day ?? it.day,
        time = move.time ?? it.time;
      const tp = input.truck ? this.gearTruck(input, day, time, it.status === 'DRAFT') : null;
      move.truckPlan = tp?.id ?? null;
    }
    let r = null;
    if (Object.keys(move).length) {
      r = this.planMove({ id: it.id, ...move });
      changed = changed || !!r.changed;
    }
    const fresh = this.repo.get(it.id, 'planItem');
    return {
      item: this.planItemView(fresh),
      changed,
      message: r?.changed ? r.message : changed ? fresh.name + ' updated.' : 'Nothing changed.',
    };
  },
  // ---------- messages: the day-before ask and the day-of notice to the driver ----------
  /** @param {any} m @param {any} it @param {string} who the first name */
  gearMsgText(m, it, who) {
    const tp = this.gearTruckItem(it),
      truck = tp ? this.planTruckWords(tp).replace(/ \((big|small) truck\)$/, '') : 'The truck',
      ends = this.gearEnds(it),
      at = timeWords(it.time);
    if (m.subject === 'READY')
      return (
        'Hi ' +
        who +
        ', ' +
        truck +
        ' for ' +
        (it.name ?? 'the gear') +
        ' tomorrow at ' +
        at +
        ' (' +
        ends.from.name +
        ' → ' +
        ends.to.name +
        "). Confirm you'll be ready? – " +
        this.planCompany()
      );
    return (
      'Today: ' +
      (it.name ?? 'the gear') +
      ' at ' +
      at +
      ', ' +
      ends.from.name +
      ' → ' +
      ends.to.name +
      '. Tap each step on your phone. – ' +
      this.planCompany()
    );
  },
  /** The TRUCK booking of a list, or null. @param {any} it */
  gearTruckItem(it) {
    if (!it?.truckPlan) return null;
    try {
      const tp = this.repo.get(it.truckPlan, 'planItem');
      return tp.status === 'CANCELLED' ? null : tp;
    } catch {
      return null;
    }
  },
  // The clock's duty (both yards, ADR 0011 §5.3): at 3 pm the day before, READY to the driver of every gear list with a truck and a driver
  // (at once when the list was made later, never after 6 am on its day: "Not asked in time"); at 6 am on the day, the DAY notice; a driver
  // who changed is asked instead; a driver who said no flags the list and the truck booking (Needs you shows it). Never a state change.
  /** @param {number} now */
  gearAsks(now) {
    const today = this.planToday(now),
      tomorrow = addDays(today, 1);
    for (const day of [today, tomorrow])
      for (const it of this.planRows(GEAR_DAY, day)) {
        try {
          this.planEdit(it.id, (/** @type {any} */ x) => this.gearAskItem(x, now, today));
        } catch (e) {
          if (!e.status) throw e;
        }
      }
  },
  /** @param {any} it @param {number} now @param {string} today */
  gearAskItem(it, now, today) {
    const tp = this.gearTruckItem(it),
      driver = tp?.driver ? this.teamPerson(tp.driver) : null,
      name = driver?.name ?? 'The driver',
      begun = now >= this.planAt(it.day, DAY_START),
      over = now >= this.planAt(it.day, DAY_END);
    // the driver changed: the old ask is called off and the new driver asked (while there is time)
    const ask = this.planMsg(it.driverAsk);
    if (ask && (!driver || ask.person !== driver.id)) {
      this.planCallOff(ask.id, driver ? 'Another driver was asked' : 'The driver changed', now);
      it.driverAsk = null;
      it.readyNo = null;
      it.readyNotAsked = null;
      if (it.problem?.includes("can't make it")) it.problem = null;
      if (tp?.readyNo) this.gearTruckFlag(tp.id, null);
    }
    if (!driver) return;
    const sendAt = this.planAt(addDays(it.day, -1), SEND_BEFORE);
    if (!it.driverAsk && !it.readyNotAsked && now >= sendAt && !over) {
      if (begun) {
        it.readyNotAsked = iso(now);
        // a list made this morning for later today could never have been asked the day before: nothing to call about
        if (Date.parse(it.createdAt) < this.planAt(it.day, DAY_START)) {
          this.planLog(it, 'Not asked in time: ' + name + " wasn't asked to be ready. Call them.", now);
          this.notify(
            'Not asked in time',
            name + " wasn't asked about " + (it.name ?? 'the gear') + '. Call them.',
            it.site,
          );
        }
      } else {
        // one ask to the driver for the run (decision 3): a READY already standing on the booking (another list on the same truck) is this
        // list's too; a DRIVE ask not yet answered gives way to it; the booking carries the READY as its own message (one answer on the card)
        const bm = tp ? this.planMsg(tp.message) : null;
        if (bm && bm.subject === 'READY' && bm.person === driver.id && bm.status !== 'CALLED_OFF') it.driverAsk = bm.id;
        else {
          it.driverAsk = this.planAskPerson(it, driver.id, 'driver', 'READY', now);
          if (it.driverAsk) this.planLog(it, name + ' has been asked to be ready.', now);
          if (it.driverAsk && tp && (!bm || (bm.subject === 'DRIVE' && bm.status === 'SENT'))) {
            if (bm) this.planCallOff(bm.id, 'Asked to be ready instead', now);
            this.planEdit(tp.id, (/** @type {any} */ x) => {
              x.message = it.driverAsk;
              if (x.stage === 'READY') x.stage = 'ASKING';
            });
          }
        }
      }
    }
    const m = this.planMsg(it.driverAsk);
    if (m?.status === 'NO' && it.readyNo?.message !== m.id) {
      const words =
        name + " can't make it" + (m.answer?.reason ? ': ' + m.answer.reason : '') + '. Pick another driver.';
      it.readyNo = { message: m.id, words };
      it.problem = words;
      this.planLog(it, name + " can't make it.", now);
      if (tp) this.gearTruckFlag(tp.id, { message: m.id, words });
    } else if (m?.status === 'YES' && it.readyNo) {
      it.readyNo = null;
      if (it.problem?.includes("can't make it")) it.problem = null;
      if (tp) this.gearTruckFlag(tp.id, null);
    }
    // the day-of notice: at 6 am on the day, once, to the driver (Got it on the phone; never an answer)
    if (it.day === today && begun && !over && !it.dayNotice) {
      it.dayNotice = this.planAskPerson(it, driver.id, 'driver', 'DAY', now, { quiet: true, needsAnswer: false });
      if (it.dayNotice) this.planLog(it, "Today's run sent to " + name + '.', now);
    }
  },
  /** The truck booking's copy of the driver's no (clockTruck / planStepTruck read it). @param {string} id @param {any} flag */
  gearTruckFlag(id, flag) {
    try {
      this.planEdit(id, (/** @type {any} */ x) => {
        x.readyNo = flag;
        if (flag) x.problem = flag.words;
        else if (x.problem?.includes("can't make it")) x.problem = null;
      });
    } catch {}
  },
  // A list that moved day or time: its day-before ask and notice are for the old day, so they are called off and sent again when due.
  /** @param {string} id @param {number} now */
  gearMoved(id, now) {
    this.planEdit(id, (/** @type {any} */ x) => {
      for (const k of ['driverAsk', 'dayNotice']) {
        if (x[k]) this.planCallOff(x[k], 'Moved to ' + dayLabel(x.day), now);
        x[k] = null;
      }
      x.readyNo = null;
      x.readyNotAsked = null;
      x.chain = {};
    });
  },
  // ---------- the Practice yard's marks (kind ENGINE) ----------
  // The engine's steps write the same chain a driver's phone would: on the item, never on a trip (the Practice yard has none).
  /** @param {any} it @param {string} step @param {number} now */
  gearEngineMark(it, step, now) {
    if (this.live()) return;
    const mark = { at: iso(now), recordedAt: iso(now), by: null, byName: 'The yard', kind: 'ENGINE', onBehalfOf: null };
    if (step !== 'RECEIVED') {
      it.chain ??= {};
      if (!it.chain[step]) it.chain[step] = mark;
    }
    if (['RECEIVED', 'PACKED', 'LOADED', 'COLLECTED'].includes(step) && typeof this.taskListSync === 'function')
      this.taskListSync(it.id, step === 'COLLECTED' ? 'LOADED' : step, now, mark);
  },
  /** The same, from the truck autopilot (game.js), by item id. @param {string} id @param {string} step */
  gearMark(id, step) {
    if (!id || this.live()) return;
    const now = this.planNow();
    try {
      this.planEdit(id, (/** @type {any} */ x) => this.gearEngineMark(x, step, now));
    } catch {}
  },
  // A gear list from a site in the Practice yard (site -> yard, site -> site): at its time the booked truck (or the next free one, once its
  // driver said yes) drives there; the site crew loads it; it drives on to the destination (or home) and unloads. Stock never teleports.
  /** @param {any} it @param {number} now @param {string} today */
  gearStepDemo(it, now, today) {
    const yard = this.planYard(),
      start = atLocal(it.day, it.time),
      due = today > it.day || (today === it.day && now >= start),
      over = today > it.day || now >= atLocal(it.day, DAY_END),
      last = CHAIN_STEPS[it.direction]?.at(-1) ?? 'DELIVERED',
      ends = this.gearEnds(it);
    if (it.stage === 'WAITING') {
      if (over) {
        this.planMissed(it, now, it.why ?? 'the day passed while the app was closed');
        return;
      }
      if (!due) return;
      const pick = this.planPickTruck(it, yard, now);
      if (pick.problem) {
        it.problem = pick.problem;
        it.why = pick.why ?? null;
        return;
      }
      const t = pick.truck;
      try {
        if (it.direction === 'BACK') this.gameCollect({ site: it.site, lines: it.lines, truck: t.id, plan: it.id });
        else this.gameMoveStart({ from: it.fromSite, to: it.site, lines: it.lines, truck: t.id, plan: it.id });
      } catch (e) {
        if (!e.status) throw e;
        it.problem = e.message;
        it.why = e.message;
        return;
      }
      it.gameTruck = t.id;
      it.stage = 'ON_THE_WAY';
      it.status = 'ACTIVE';
      it.problem = null;
      this.planLog(it, t.name + ' is on its way to ' + ends.from.name + ' for ' + (it.name ?? 'the gear') + '.', now);
      return;
    }
    if (it.stage !== 'ON_THE_WAY') return;
    if (it.chain?.[last]) {
      it.stage = it.direction === 'BACK' ? 'RETURNED' : 'DELIVERED';
      this.planFinish(
        it,
        now,
        (it.direction === 'BACK' ? 'Back at yard: ' : 'Landed at ' + ends.to.name + ': ') + it.name + '.',
      );
      this.notify(
        it.direction === 'BACK' ? 'Back at yard' : 'Delivered',
        (it.name ?? 'The gear') +
          (it.direction === 'BACK' ? ' is back at the yard.' : ' landed at ' + ends.to.name + '.'),
        it.site,
      );
      return;
    }
    let t = null;
    try {
      t = this.repo.get(it.gameTruck, 'truck');
    } catch {}
    if (!t || !t.game || t.game.plan !== it.id) {
      if (t?.status === 'AT_YARD' && !t.game) {
        this.planMissed(it, now, 'the truck came back without it');
        this.notify(
          "Didn't go",
          (it.name ?? 'The gear') + ': the truck came back without it. Pick a new day.',
          it.site,
        );
      }
      return;
    }
    it.problem = t.game.problem ?? null;
  },
  // ---------- views ----------
  // The gear fields of a MATERIALS item's view (today.js planItemView adds them for every list made by gearListCreate).
  /** @param {any} it @param {any} ctx */
  gearItemFields(it, ctx) {
    const ends = this.gearEnds(it),
      names = { from: ends.from.name, to: ends.to.name },
      direction = it.direction ?? 'OUT';
    let trip = null,
      order = null;
    if (this.live() && it.order)
      try {
        order = this.repo.get(it.order, 'order');
        trip = order.trip ? this.repo.get(order.trip, 'trip') : null;
      } catch {}
    const marks = this.live() ? (trip?.steps ?? {}) : (it.chain ?? {});
    const chain = chainOf(direction, marks, names);
    const tp = this.gearTruckItem(it),
      driverMsg = tp ? this.planMsg(tp.message) : null,
      ready = this.planMsg(it.driverAsk),
      notice = this.planMsg(it.dayNotice),
      now = ctx?.now ?? this.planNow();
    const done = chain.filter((c) => c.done).at(-1);
    let task = null;
    if (typeof this.taskForList === 'function' && typeof this.taskView === 'function')
      try {
        const tk = this.taskForList(it.id);
        task = tk ? this.taskView(tk) : null;
      } catch {}
    const arrival = trip && this.live() ? this.tripArrivalNext(trip) : null;
    return {
      gear: true,
      name: it.name ?? ends.to.name + ' gear',
      direction,
      from: ends.from,
      to: ends.to,
      arrow:
        direction === 'OUT'
          ? '→ ' + ends.to.name
          : direction === 'BACK'
            ? '← ' + ends.from.name
            : ends.from.name + ' → ' + ends.to.name,
      chain,
      chainWords: done ? done.words + ' ' + this.planParts(Date.parse(done.at)).hm : null,
      truckItem: tp
        ? {
            id: tp.id,
            truckName: this.planTruckWords(tp).replace(/ \((big|small) truck\)$/, ''),
            driver: tp.driver ?? null,
            driverName: tp.driver ? this.planName(tp.driver, 'the driver') : null,
            driverAnswer: tp.driver ? this.planAnswerOf(driverMsg, now) : null,
          }
        : null,
      readyAsk: ready ? this.planMsgView(ready, now) : null,
      readyNotAsked: it.readyNotAsked ?? null,
      dayNotice: notice ? this.planMsgView(notice, now) : null,
      order: order ? this.orderLabel(order) : null,
      trip: trip?.id ?? null,
      // the office's next arrival tap for the driver (a real yard): its words, or null
      arrival:
        arrival && ctx?.ops ? { step: arrival, words: chainWords(direction, arrival, names), trip: trip.id } : null,
      task,
    };
  },
  // GET /api/gear?day=  (the Gear list page's week and the day panel): the day's gear lists with their chain, or a week from today.
  /** @param {{day?:string|null,days?:number}} [query] */
  gearView({ day = null, days = 1 } = {}) {
    this.planScopeCheck();
    const ctx = this.planCtx(),
      from = day && DAY.test(day) ? day : ctx.today,
      n = Math.max(1, Math.min(31, Number(days) || 1)),
      to = addDays(from, n - 1);
    const rows = this.planRows(GEAR_RANGE, from, to).filter((/** @type {any} */ i) => this.planVisible(i, ctx));
    this.planLoadMsgs(ctx, rows);
    return {
      day: from,
      to,
      today: ctx.today,
      now: iso(ctx.now),
      dayOver: ctx.now >= this.planAt(ctx.today, DAY_END),
      lists: rows.map((/** @type {any} */ i) => this.planItemView(i, ctx)),
    };
  },
  // GET /api/gear/places: the yard, the active sites, the fleet trucks and the drivers, for the form.
  gearPlaces() {
    this.planScopeCheck();
    const ctx = this.planCtx(),
      yard = this.planYard();
    return {
      yard: yard ? { id: yard.id, name: yard.name ?? 'Main yard' } : null,
      sites: [...ctx.sites.values()]
        .filter((/** @type {any} */ s) => s.status === 'ACTIVE' && ctx.mine.has(s.id) && !s.finishing)
        .map((/** @type {any} */ s) => ({ id: s.id, name: s.name }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
      trucks: ctx.ops
        ? [...ctx.trucks.values()]
            .filter((/** @type {any} */ t) => !t.retired && !t.hired)
            .map((/** @type {any} */ t) => ({ id: t.id, name: t.name, big: t.payload >= 10000000 }))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        : [],
      drivers: ctx.ops
        ? this.teamDrivers()
            .map((/** @type {any} */ d) => ({ id: d.id, name: d.name }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : [],
      hire: !this.live(),
    };
  },
};
