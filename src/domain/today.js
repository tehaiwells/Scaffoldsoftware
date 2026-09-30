// What the Today page reads (read-only; the planner itself is src/domain/plan.js):
//   GET /api/plan?month=YYYY-MM  planMonth   the calendar: plan items, yard lists, requests, collections and deliveries on its 42 days
//   GET /api/today               todayView   the five daily cards: sites, paperwork, who's in, yesterday & today, the business
//   GET /api/person?kind=&id=    personView  one person's messages (the crew and driver phone views)
//   /api/state                   planSnapshot result.plan = {rev, today counts}: a few bytes, so the page knows when to refetch
// Scope: the office (operations.manage) sees everything; a supervisor (sites.assigned) sees their own sites' lists and allocations, a truck only
// when a list for their site goes on it (no mobiles), and never a re-stack or money. Dollars only with finance.view, from hire.js.
import { AppError } from '../service.js';
import { requireRule } from './geometry.js';
import { cached } from '../database.js';
import { planRevision } from '../repository.js';
import { addDays, dayLabel, daysBetween, calendarNow } from './schedule.js';
import { SEND_BEFORE, timeWords } from './plantime.js';
import { PLAN_OPEN, PLAN_FIXABLE, MSG_OPEN } from './plan.js';
import { mobileWords, ROLE_WORDS } from './team.js';
import { paperState } from './paperwork.js';
import { hireGst } from './hire.js';
import { active } from './inventory.js';
import { monthGrid, isMonth, monthAdd, monthsBetween, smsHref } from '../../public/plan-cal.js';
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
const iso = (ms) => new Date(ms).toISOString();
const SLOT_TIME = { AM: '07:00', ANY: '12:00', PM: '13:00' },
  SLOT_WORDS = { AM: 'Morning', ANY: 'Any time', PM: 'Afternoon' };
const RANGE =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='planItem' AND json_extract(data,'$.day') BETWEEN ? AND ? ORDER BY rowid";
const MSGS_FOR =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='message' AND json_extract(data,'$.item') IN (SELECT value FROM json_each(?)) ORDER BY rowid";
// lists that didn't go (MISSED) and open items whose day has passed: shown until the office picks a new day or cancels
const LATE =
  "SELECT id,kind,data,version FROM objects WHERE company_id=?1 AND kind='planItem' AND (json_extract(data,'$.status')='MISSED' OR (json_extract(data,'$.status') IN ('PLANNED','ACTIVE') AND json_extract(data,'$.day')<?2)) ORDER BY rowid";
const PERSON =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='message' AND json_extract(data,'$.person')=? AND json_extract(data,'$.status')<>'WAITING_TO_SEND' ORDER BY rowid DESC LIMIT 200";
const crewState = (r) =>
  r.task
    ? ['load', 'Moving stock']
    : r.mountedOn
      ? ['drive', 'Driving a forklift']
      : r.mountTarget
        ? ['walk', 'Walking to a forklift']
        : r.walk
          ? ['walk', r.walk.job ? 'Walking to a job' : 'Walking']
          : r.job
            ? ['job', 'On a job']
            : r.workerMode === 'HOLD'
              ? ['hold', 'Holding position']
              : ['idle', 'Idle'];
const crewBusy = (r) => !!(r.task || r.mountedOn || r.mountTarget || r.walk || r.job);
const TRIP_WORDS = { LOADING: 'Loading', DRIVING: 'On the road', UNLOADING: 'Unloading' };
export const todayMethods = {
  // Lookups for a batch of views (one per request).
  planCtx() {
    const now = this.planNow(),
      cal = this.live() ? this.clockCal(now) : calendarNow(new Date(now)),
      perms = this.auth.permissions(this.user),
      ops = perms.includes('operations.manage');
    const sites = new Map(this.repo.all('site').map((s) => [s.id, s])),
      mine = new Set([...sites.values()].filter((s) => ops || s.supervisor === this.user.id).map((s) => s.id));
    return {
      now,
      cal,
      today: cal.today,
      perms,
      ops,
      sites,
      mine,
      trucks: new Map(this.repo.all('truck').map((t) => [t.id, t])),
      people: new Map(
        [...this.repo.all('resource').filter((r) => r.type === 'WORKER'), ...this.repo.all('driver')].map((p) => [
          p.id,
          p,
        ]),
      ),
      msgs: new Map(),
      items: new Map(),
    };
  },
  planLoadMsgs(ctx, items) {
    const ids = items.map((i) => i.id).filter((id) => !ctx.items.has(id));
    for (const it of items) ctx.items.set(it.id, it);
    if (!ids.length) return;
    for (const row of cached(this.db, MSGS_FOR).all(this.repo.company, JSON.stringify(ids))) {
      const m = this.repo.decode(row);
      ctx.msgs.set(m.id, m);
    }
  },
  // The answer a message stands at: NOT_SENT, WAITING (sent, before the item's time), NO_ANSWER (after it), YES, NO or CALLED_OFF.
  planAnswerOf(m, now) {
    if (!m || m.status === 'WAITING_TO_SEND') return 'NOT_SENT';
    if (m.status === 'SENT') {
      if (!m.needsAnswer) return m.seenAt ? 'SEEN' : 'SENT';
      return now >= this.planAt(m.day, m.time) || m.closedAt ? 'NO_ANSWER' : 'WAITING';
    }
    return m.status;
  },
  // Is this item on the viewer's calendar? (supervisor: own sites' lists and allocations, and a truck a list for their site goes on)
  planVisible(it, ctx, all) {
    if (ctx.ops) return true;
    if (it.type === 'MATERIALS' || it.type === 'WORKERS') return ctx.mine.has(it.site);
    if (it.type === 'TRUCK')
      return (all ?? []).some(
        (x) => x.type === 'MATERIALS' && x.truckPlan === it.id && ctx.mine.has(x.site) && x.status !== 'CANCELLED',
      );
    return false;
  },
  planMsgView(m, now = this.planNow()) {
    if (!m) return null;
    const answer = this.planAnswerOf(m, now);
    let site = null;
    try {
      site = m.site ? this.repo.get(m.site, 'site') : null;
    } catch {}
    const address = site?.address && site.address !== 'Demonstration site' ? site.address : null,
      open = ['SENT', 'YES', 'NO'].includes(m.status) && !m.closedAt;
    const words =
      m.status === 'CALLED_OFF'
        ? 'Called off'
        : answer === 'YES'
          ? 'You said yes, see you there'
          : answer === 'NO'
            ? "You said you can't make it"
            : answer === 'NO_ANSWER'
              ? 'Too late to answer, call the office'
              : m.subject === 'PACK'
                ? m.seenAt
                  ? 'Got it'
                  : 'Please pack this list'
                : 'Can you make it?';
    return {
      id: m.id,
      item: m.item,
      itemType: m.itemType,
      subject: m.subject,
      text: m.text,
      day: m.day,
      dayLabel: dayLabel(m.day),
      time: m.time,
      timeWords: timeWords(m.time),
      site: m.site,
      siteName: site?.name ?? null,
      address,
      directions: address ? 'https://maps.google.com/?q=' + encodeURIComponent(address) : null,
      status: m.status,
      answer,
      reason: m.answer?.reason ?? null,
      via: m.answer?.via ?? null,
      needsAnswer: !!m.needsAnswer,
      canAnswer: open && !!m.needsAnswer && now < this.planAt(m.day, m.time),
      canSee: m.subject === 'PACK' && open && !m.seenAt,
      seen: !!m.seenAt,
      sentAt: m.sentAt,
      answeredAt: m.answeredAt,
      calledOffWhy: m.calledOffWhy ?? null,
      attempt: m.attempt ?? 1,
      personName: m.personName,
      words,
    };
  },
  planItemView(it, ctx = this.planCtx()) {
    this.planLoadMsgs(ctx, [it]);
    const now = ctx.now,
      open = PLAN_OPEN.includes(it.status),
      fix = PLAN_FIXABLE.includes(it.status),
      missed = it.status === 'MISSED',
      late = fix && it.day < ctx.today,
      msg = (id) => (id ? (ctx.msgs.get(id) ?? this.planMsg(id)) : null);
    const site = it.site ? ctx.sites.get(it.site) : null,
      siteName = site?.name ?? null,
      person = (id) => ctx.people.get(id) ?? null,
      nameOf = (id) => person(id)?.name ?? 'Someone';
    const who = (id, mid) => {
      const m = msg(mid),
        p = person(id),
        answer = this.planAnswerOf(m, now),
        mobile = ctx.ops ? (p?.mobile ?? null) : null;
      return {
        person: id,
        name: p ? this.teamLabel(p) : (m?.personName ?? 'Someone'),
        gone: !p || (p.kind === 'driver' ? !p.active : !p.enabled),
        message: mid ?? null,
        answer,
        reason: m?.answer?.reason ?? null,
        via: m?.answer?.via ?? null,
        attempt: m?.attempt ?? null,
        sentAt: m?.sentAt ?? null,
        mobile,
        mobileWords: mobileWords(mobile),
        smsHref: mobile && m && ['SENT', 'NO'].includes(m.status) && !m.closedAt ? smsHref(mobile, m.text) : null,
        canConfirm: ctx.ops && open && !!m && ['SENT', 'NO'].includes(m.status) && !m.closedAt,
      };
    };
    const v = {
      id: it.id,
      type: it.type,
      day: it.day,
      dayLabel: dayLabel(it.day),
      time: it.time,
      timeWords: timeWords(it.time),
      site: it.site ?? null,
      siteName,
      status: it.status,
      stage: it.stage,
      note: it.note ?? null,
      problem: it.problem ?? null,
      log: it.log ?? [],
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
      doneAt: it.doneAt ?? null,
      cancelledAt: it.cancelledAt ?? null,
      cancelReason: it.cancelReason ?? null,
    };
    const draft = it.status === 'DRAFT';
    let red = !!it.problem || late || missed,
      needsAnswer = false,
      warn = false,
      words = '';
    if (it.type === 'TRUCK') {
      const t = it.truck ? ctx.trucks.get(it.truck) : null,
        ht = it.hire?.truck ? ctx.trucks.get(it.hire.truck) : null,
        d = it.driver ? who(it.driver, it.message) : null;
      Object.assign(v, {
        truck: it.truck ?? null,
        truckName: t?.name ?? (it.hire ? (ht?.name ?? 'Hire truck') : (it.truckGone ?? null)),
        big: it.hire ? it.hire.size !== 'SMALL' : t ? t.payload >= 10000000 : null,
        hire: it.hire ?? null,
        hireTruckName: ht?.name ?? null,
        driver: it.driver ?? null,
        driverName: d?.name ?? null,
        driverRow: d,
        needsDriver: !!it.needsDriver,
        loads: [...ctx.items.values()]
          .filter(
            (x) =>
              x.type === 'MATERIALS' &&
              x.truckPlan === it.id &&
              x.status !== 'CANCELLED' &&
              (ctx.ops || ctx.mine.has(x.site)),
          )
          .map((x) => ({ id: x.id, site: x.site, siteName: ctx.sites.get(x.site)?.name ?? null })),
      });
      if (d) {
        needsAnswer = d.answer === 'WAITING';
        if (['NO', 'NO_ANSWER'].includes(d.answer)) red = true;
      }
      words =
        it.status === 'DONE'
          ? 'Done'
          : !it.truck && !it.hire
            ? it.truckGone
              ? it.truckGone + ' was removed. Cancel it and book another truck.'
              : 'Pick a truck.'
            : !d
              ? it.needsDriver
                ? 'Needs a driver'
                : 'No driver named'
              : d.answer === 'YES'
                ? d.name + ' said yes'
                : d.answer === 'WAITING'
                  ? 'Waiting for ' + d.name + ' to answer'
                  : d.answer === 'NO'
                    ? d.name + " can't make it" + (d.reason ? ': ' + d.reason : '')
                    : d.answer === 'NO_ANSWER'
                      ? d.name + " hasn't answered"
                      : 'Asking ' + d.name;
      if (it.hire && ht && !it.hire.goneAt && it.status !== 'DONE') words += ' · ' + ht.name + ' is here today';
    } else if (it.type === 'MATERIALS') {
      const tp = it.truckPlan
          ? (ctx.items.get(it.truckPlan) ??
            (() => {
              try {
                return this.repo.get(it.truckPlan, 'planItem');
              } catch {
                return null;
              }
            })())
          : null,
        tpt = tp ? (tp.truck ? ctx.trucks.get(tp.truck) : tp.hire?.truck ? ctx.trucks.get(tp.hire.truck) : null) : null;
      const cat = this.catalogue().byId,
        pname = (id) => cat.get(id)?.name ?? 'Removed material',
        pm = msg(it.packMessage),
        packer = it.packer ? person(it.packer) : null;
      const lastTrip = (it.trips ?? []).at(-1),
        delivered = (it.trips ?? []).filter((x) => x.delivered).reduce((n, x) => n + (x.pieces ?? 0), 0);
      // a real yard: the yard's own Packed tap (who, when, the counts) is what the card says once it is packed
      let packedWords = null;
      if (this.live() && it.order && it.stage === 'PACKED')
        try {
          const o = this.repo.get(it.order, 'order'),
            trip = o.trip ? this.repo.get(o.trip, 'trip') : null,
            st = trip?.steps?.PACKED;
          if (st) {
            const lines = this.tripLines(trip),
              n = lines.reduce((k, l) => k + (l.packed ?? 0), 0);
            packedWords =
              'Packed by ' +
              (st.kind === 'ON_BEHALF' && st.onBehalfOf ? nameOf(st.onBehalfOf) + ' (the office)' : st.byName) +
              ', ' +
              this.tripHm(Date.parse(st.at)) +
              ' · ' +
              (lines.length > 1 ? lines.map((l) => l.packed ?? 0).join(' + ') + ' = ' : '') +
              plural(n, 'piece');
          }
        } catch {}
      Object.assign(v, {
        lines: it.lines.map((l) => ({
          product: l.product,
          quantity: l.quantity,
          name: pname(l.product),
          got: it.got?.[l.product] ?? null,
        })),
        pieces: it.lines.reduce((n, l) => n + l.quantity, 0),
        pack: it.pack,
        packDay: it.packDay,
        packDayLabel: dayLabel(it.packDay),
        truckPlan: it.truckPlan ?? null,
        truckPlanName: tp
          ? (tpt?.name ?? (tp.hire ? 'Hire truck' : 'Truck')) + (tp.driver ? ' · ' + nameOf(tp.driver) : '')
          : null,
        packer: it.packer ?? null,
        packerName: packer?.name ?? null,
        packAnswer: this.planAnswerOf(pm, now),
        packSeen: !!pm?.seenAt,
        held: (it.held ?? []).length,
        left: (it.left ?? []).length,
        short: (it.short ?? []).map((s) => ({
          product: s.product,
          name: pname(s.product),
          want: s.want,
          got: s.got,
          missing: s.want - s.got,
        })),
        trips: (it.trips ?? []).map((x) => ({
          truck: x.truck,
          truckName: x.truckName,
          at: x.at,
          stillages: x.stillages,
          pieces: x.pieces,
          delivery: x.delivery,
          done: !!x.done,
          delivered: !!x.delivered,
        })),
        delivered,
      });
      if ((it.short ?? []).length) red = true;
      // before it is packed: a line above what is free in the yard now (recomputed on every read)
      let low = [];
      if (open && ['WAITING', 'PACKING'].includes(it.stage) && !(it.held ?? []).length) {
        const free = (ctx.free ??= this.planFree());
        // a real yard's list holds exact pieces on its order: what it holds is in the yard for it (not "short" of itself)
        const mine = this.live() && it.order ? this.orderHeld(it.order) : null;
        const have = (l) => (free.get(l.product) ?? 0) + (mine?.get(l.product) ?? 0);
        low = it.lines
          .filter((l) => have(l) < l.quantity)
          .map((l) => ({
            product: l.product,
            name: pname(l.product),
            want: l.quantity,
            have: have(l),
            missing: l.quantity - have(l),
          }));
      }
      warn = low.length > 0;
      v.low = low;
      v.lowWords = low.length
        ? 'Only ' +
          low[0].have +
          ' of ' +
          low[0].name +
          ' in the yard now: ' +
          low[0].missing +
          ' short' +
          (low.length > 1 ? ' (and ' + plural(low.length - 1, 'more part') + ')' : '')
        : null;
      v.leftOver = it.leftOver ?? 0;
      v.why = it.why ?? null;
      if (v.leftOver) red = true;
      words =
        {
          WAITING:
            (packer?.name ?? 'The crew') + ' packs it ' + (it.pack === 'DAY_BEFORE' ? 'the day before' : 'on the day'),
          PACKING: 'Being packed',
          PACKED: packedWords ?? 'Packed: ' + plural((it.held ?? []).length, 'stillage') + ' set aside',
          LOADING: (lastTrip?.truckName ?? 'The truck') + ' is loading',
          ON_THE_WAY: 'On the way to ' + (siteName ?? 'the site'),
          DELIVERED: 'Delivered',
        }[it.stage] ?? '';
      if (it.status === 'CANCELLED') words = 'Cancelled';
      if (missed) words = "Didn't go";
      if (it.status === 'DONE' && it.leftOver) words = 'Part delivered';
    } else if (it.type === 'WORKERS') {
      const sendAt = iso(this.planAt(addDays(it.day, -1), SEND_BEFORE));
      const rows = it.people.map((p) => ({
        ...who(p.person, p.message),
        moved: !!p.moved && !p.homeAt,
        wasOnSite: !!p.moved,
        arrivedAt: p.arrivedAt ?? null,
        homeAt: p.homeAt ?? null,
        signOn: p.signOn ?? null, // a real yard: who tapped On site, and whether it was their own tap or the office's (ADR 0010)
        sendAt: p.message ? null : sendAt,
      }));
      for (const r of rows) {
        if (r.answer === 'WAITING') needsAnswer = true;
        if (['NO', 'NO_ANSWER'].includes(r.answer) && !r.wasOnSite) red = true;
      }
      const yes = rows.filter((r) => r.answer === 'YES').length,
        here = rows.filter((r) => r.moved).length,
        gaps = Math.max(0, it.count - rows.filter((r) => !r.gone || r.wasOnSite).length);
      if (gaps && open) red = true;
      Object.assign(v, { count: it.count, people: rows, gaps, yes, onSite: here, pickedBy: it.pickedBy, sendAt });
      words =
        it.status === 'DONE'
          ? 'Done'
          : it.status === 'CANCELLED'
            ? 'Cancelled'
            : it.stage === 'BOOKED'
              ? 'Messages go out ' + dayLabel(addDays(it.day, -1)) + ' at 3:00 pm'
              : it.stage === 'ON_SITE'
                ? here + ' of ' + it.count + ' at ' + (siteName ?? 'the site')
                : yes + ' of ' + it.count + ' said yes';
    } else if (it.type === 'RESTACK') {
      Object.assign(v, {
        consolidate: it.consolidate !== false,
        stackEmpties: it.stackEmpties !== false,
        startedAt: it.startedAt ?? null,
        finishedAt: it.finishedAt ?? null,
        moved: it.moved ?? { pieces: 0, jobs: 0, stacked: 0 },
      });
      words =
        it.status === 'DONE'
          ? it.startedAt
            ? !it.moved?.pieces && !it.moved?.stacked
              ? 'Done: the yard was already tidy'
              : 'Done: ' +
                plural(it.moved?.pieces ?? 0, 'piece') +
                ' topped up, ' +
                plural(it.moved?.stacked ?? 0, 'empty', 'empties') +
                ' stacked'
            : 'Did not run: the day passed'
          : it.status === 'CANCELLED'
            ? 'Cancelled'
            : it.stage === 'WORKING'
              ? 'Crew is re-stacking'
              : 'Starts at ' + timeWords(it.time);
    }
    if (missed) words = "Didn't go";
    if (draft) words = 'Draft: sent to nobody yet';
    if (it.status === 'DONE' && it.done)
      words = 'Done' + (it.done.kind === 'ON_BEHALF' ? ' (recorded by ' + it.done.byName + ')' : '');
    const canCancel = ctx.ops && fix && !(it.type === 'MATERIALS' && ['LOADING', 'ON_THE_WAY'].includes(it.stage));
    const canMove =
      ctx.ops &&
      fix &&
      (it.type === 'TRUCK'
        ? missed || draft || (it.status === 'PLANNED' && now < this.planAt(it.day, '06:00'))
        : it.type === 'MATERIALS'
          ? ['WAITING', 'PACKING', 'PACKED', 'MISSED'].includes(it.stage)
          : it.type === 'WORKERS'
            ? !it.people.some((p) => p.moved)
            : it.stage === 'WAITING');
    if (!fix)
      red = it.status === 'DONE' && it.type === 'MATERIALS' && ((it.short ?? []).length > 0 || (it.leftOver ?? 0) > 0);
    return Object.assign(v, {
      words,
      flags: {
        needsAnswer: open && needsAnswer,
        red: red && !draft,
        late,
        done: it.status === 'DONE',
        warn: open && warn,
        missed,
        draft,
      },
      canMove,
      canCancel,
      canEdit: ctx.ops && (open || draft) && it.type === 'MATERIALS' && ['WAITING', 'DRAFT'].includes(it.stage),
      canAsk: ctx.ops && open && ['TRUCK', 'WORKERS'].includes(it.type),
      // a real yard (ADR 0010): send a draft; sign a gang on and mark a day or a yard task done (the office, for the people)
      canSend: ctx.ops && draft,
      canSignOn: ctx.ops && open && it.type === 'WORKERS' && it.day === ctx.today && this.live(),
      canDone: ctx.ops && open && ['WORKERS', 'RESTACK'].includes(it.type) && it.day <= ctx.today && this.live(),
    });
  },
  // Yard lists, single requests and collections as calendar runs (the views the snapshot builds).
  planRuns(ctx) {
    const cal = ctx.cal,
      sctx = this.scheduleCtx(ctx.perms),
      mine = (id) => ctx.mine.has(id),
      products = this.catalogue().byId;
    const lists = this.loadLists(cal).map((l) => ({
      id: l.id,
      kind: 'loadList',
      day: l.neededOn,
      slot: l.slot,
      site: l.site,
      siteName: l.siteName,
      name: l.name,
      status: l.status,
      urgency: l.urgency,
      pieces: l.requested,
      delivered: l.delivered ?? 0,
      runTruck: l.runTruck,
      runTruckName: l.runTruckName,
      done: ['DELIVERED', 'CANCELLED'].includes(l.status),
      open: l.schedulable,
    }));
    const reqs = this.repo
      .all('request')
      .filter((r) => !r.loadList && (ctx.ops || mine(r.site)))
      .map((r) => {
        const f = this.scheduleFields(r, cal, sctx);
        return {
          id: r.id,
          kind: 'request',
          day: f.neededOn,
          slot: f.slot,
          site: r.site,
          siteName: f.siteName,
          name: r.quantity + ' × ' + (products.get(r.product)?.name ?? 'material'),
          status: r.status,
          urgency: f.urgency,
          pieces: r.quantity,
          runTruck: f.runTruck,
          runTruckName: f.runTruckName,
          done: ['DELIVERED', 'CANCELLED', 'RETURNED'].includes(r.status),
          open: f.schedulable,
        };
      });
    const rts = this.rtViews(cal, sctx).map((o) => ({
      id: o.id,
      kind: 'collection',
      day: o.neededOn,
      slot: o.slot,
      site: o.site,
      siteName: o.siteName,
      name: o.name,
      status: o.status,
      urgency: o.urgency,
      pieces: o.pieces,
      runTruck: o.runTruck,
      runTruckName: o.runTruckName,
      done: ['RETURNED', 'CANCELLED'].includes(o.status),
      open: ['REQUESTED', 'BOOKED', 'LOADING'].includes(o.status),
      scope: o.scope,
    }));
    // today's trips sent from the yard board (not the planner's own): on the calendar, where we begin today and the site's stage
    const trips = [];
    let stored = null,
      live = null;
    for (const t of ctx.trucks.values()) {
      const g = t.game;
      if (!g || g.plan || g.kind !== 'SEND' || t.retired || !TRIP_WORDS[g.stage] || !ctx.mine.has(g.site)) continue;
      const at = g.since ? this.planParts(Date.parse(g.since)) : null;
      if (!at || at.day !== ctx.today) continue;
      stored ??= this.containers();
      live ??= this.tasks().filter(active);
      const ids = new Set([
        ...stored.filter((c) => c.location === t.id).map((c) => c.id),
        ...live.filter((x) => x.to === t.id).map((x) => x.container),
      ]);
      let pieces = 0;
      for (const id of ids) pieces += this.repo.lines(id).reduce((k, l) => k + l.quantity, 0);
      trips.push({
        id: 'trip:' + t.id,
        kind: 'trip',
        day: ctx.today,
        slot: 'ANY',
        time: at.hm,
        site: g.site,
        siteName: ctx.sites.get(g.site)?.name ?? null,
        name: 'Sent from the yard board',
        status: TRIP_WORDS[g.stage],
        urgency: 'TODAY',
        pieces,
        stillages: g.stillages ?? ids.size,
        runTruck: t.id,
        runTruckName: t.name,
        done: false,
        open: false,
      });
    }
    return [...lists, ...reqs, ...rts, ...trips].filter((x) => x.day);
  },
  planScopeCheck() {
    const p = this.auth.permissions(this.user);
    if (!p.includes('operations.manage') && !p.includes('sites.assigned'))
      throw new AppError(403, 'Your role does not allow this action.');
  },
  // GET /api/plan?month=YYYY-MM
  planMonth(month) {
    this.planScopeCheck();
    const ctx = this.planCtx(),
      thisMonth = ctx.today.slice(0, 7);
    month = month || thisMonth;
    requireRule(
      isMonth(month) && Math.abs(monthsBetween(thisMonth, month)) <= 13,
      'Choose a month within a year of today.',
    );
    const grid = monthGrid(month),
      from = grid[0],
      to = grid[41];
    const all = cached(this.db, RANGE)
      .all(this.repo.company, from, to)
      .map((row) => this.repo.decode(row))
      .filter((i) => i.status !== 'CANCELLED');
    this.planLoadMsgs(ctx, all);
    const items = all
      .filter((i) => this.planVisible(i, ctx, all))
      .map((i) => {
        const v = this.planItemView(i, ctx);
        if (!ctx.ops && v.driverRow) {
          v.driverRow = { ...v.driverRow, mobile: null, mobileWords: null, smsHref: null };
        }
        return v;
      })
      .sort((a, b) => a.day.localeCompare(b.day) || a.time.localeCompare(b.time));
    const runsAll = this.planRuns(ctx),
      runs = runsAll.filter((x) => x.day >= from && x.day <= to),
      overdue = runsAll.filter((x) => x.open && x.day < ctx.today);
    const trucks = [...ctx.trucks.values()],
      delivered = this.repo
        .all('delivery')
        .filter((d) => d.status === 'DELIVERED' && d.completedAt && ctx.mine.has(d.to))
        .map((d) => ({
          id: d.id,
          day: this.planDayOfIso(d.completedAt),
          site: d.to,
          siteName: ctx.sites.get(d.to)?.name ?? null,
          pieces: d.pieces ?? null,
          stillages: (d.containers ?? []).length,
          truckName: ctx.trucks.get(d.truck)?.name ?? null,
        }))
        .filter((d) => d.day >= from && d.day <= to);
    const taken = {};
    if (ctx.ops) {
      for (const i of all) {
        if (i.status === 'MISSED') continue;
        const t = (taken[i.day] ??= { trucks: [], drivers: [], people: [], restack: false, workers: [] });
        if (i.type === 'TRUCK') {
          if (i.truck) t.trucks.push(i.truck);
          if (i.driver) t.drivers.push(i.driver);
        }
        if (i.type === 'WORKERS') t.workers.push({ site: i.site, time: i.time });
        if (i.type === 'RESTACK') t.restack = true;
      }
      // who is free each coming day, in the order "Anyone free" picks them (the Workers form and Ask someone use the same list), and the last of
      // each site's crane crew on a day with a delivery there (they can't be booked away)
      for (const d of grid) {
        const dayItems = all.filter((i) => i.day === d),
          t = (taken[d] ??= { trucks: [], drivers: [], people: [], restack: false, workers: [] }),
          tk = this.planTaken(d, dayItems);
        t.people = [...tk];
        if (d < ctx.today) continue;
        t.pool = this.planPool(d, null).map((w) => ({ id: w.id, home: this.teamHome(w) }));
        t.crane = this.planCraneHold(d, dayItems, tk);
      }
    }
    const missed = cached(this.db, LATE)
      .all(this.repo.company, addDays(ctx.today, -1))
      .map((r) => this.repo.decode(r));
    this.planLoadMsgs(ctx, missed);
    const cfg = this.repo.all('config')[0] ?? null,
      yard = this.planYard(),
      team = ctx.ops ? this.teamView() : null;
    return {
      month,
      prev: monthAdd(month, -1),
      next: monthAdd(month, 1),
      today: ctx.today,
      tomorrow: ctx.cal.tomorrow,
      now: iso(ctx.now),
      timeZone: ctx.cal.timeZone,
      rev: planRevision(this.db, this.repo.company),
      grid,
      items,
      runs,
      overdue,
      delivered,
      taken,
      missed: missed.filter((i) => this.planVisible(i, ctx, missed)).map((i) => this.planItemView(i, ctx)),
      canPlan: ctx.ops,
      canPaperwork: ctx.perms.includes('requests.create'),
      paused: !!cfg?.paused,
      replies: cfg?.planReplies !== false,
      firstDay: ctx.today,
      lastDay: addDays(ctx.today, 366),
      trucks: ctx.ops
        ? trucks
            .filter((t) => !t.retired && !t.hired)
            .map((t) => ({ id: t.id, name: t.name, big: t.payload >= 10000000, retired: false }))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        : [],
      drivers: ctx.ops
        ? this.teamDrivers()
            .map((d) => ({
              id: d.id,
              name: d.name,
              mobile: d.mobile ?? null,
              mobileWords: mobileWords(d.mobile),
              demo: !!d.demo,
            }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : [],
      team: team ? { needsStart: team.needsStart, needsNames: team.needsNames, people: team.people } : null,
      sites: [...ctx.sites.values()]
        .filter((s) => s.status === 'ACTIVE' && ctx.mine.has(s.id))
        .map((s) => ({ id: s.id, name: s.name, address: s.address ?? null, finishing: !!s.finishing }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
      pickerLift: yard ? this.gameLift(yard) : null,
    };
  },
  // Messages for one person: open ones first (by day), then the newest 20 answered or called off.
  personMessages(kind, id) {
    const now = this.planNow(),
      rows = cached(this.db, PERSON)
        .all(this.repo.company, id)
        .map((r) => this.repo.decode(r))
        .filter((m) => m.personKind === kind),
      views = rows.map((m) => this.planMsgView(m, now));
    const isOpen = (v) => v.canAnswer || v.canSee || v.answer === 'WAITING';
    const open = views.filter(isOpen).sort((a, b) => a.day.localeCompare(b.day) || a.time.localeCompare(b.time)),
      rest = views.filter((v) => !isOpen(v)).slice(0, 20);
    return [...open, ...rest];
  },
  // GET /api/person?kind=worker|driver&id=
  personView(kind, id) {
    requireRule(['worker', 'driver'].includes(kind), 'Choose a worker or a driver.');
    requireRule(typeof id === 'string' && id.length > 0 && id.length <= 100, 'Choose someone in your team.');
    this.planScopeCheck();
    const ctx = this.planCtx(),
      today = ctx.today;
    if (kind === 'driver') {
      this.auth.require(this.user, 'operations.manage');
      let d = null;
      try {
        d = this.repo.get(id, 'driver');
      } catch {}
      requireRule(d, 'Choose someone in your team.');
      const it = this.planDayItems(today, 'TRUCK').find((x) => x.driver === d.id) ?? null;
      let truck = null,
        trips = [];
      const t = it ? this.planTruckOf(it) : null;
      if (t) {
        const where =
          t.status === 'IN_TRANSIT'
            ? 'On the road to ' + this.planName(t.destination, 'a site')
            : t.status === 'AT_SITE'
              ? 'At ' + this.planName(t.at, 'a site')
              : t.retired
                ? 'Gone back'
                : 'At the yard';
        trips = this.repo
          .all('delivery')
          .filter((x) => x.truck === t.id && this.planDayOfIso(x.createdAt) === today)
          .map((x) => ({
            id: x.id,
            to: x.to,
            toName: this.planName(x.to, 'a site'),
            status: x.status,
            at: x.createdAt,
            stillages: (x.containers ?? []).length,
          }));
        truck = { id: t.id, name: t.name, where, status: t.status };
      }
      return {
        person: {
          id: d.id,
          name: d.name,
          role: 'DRIVER',
          roleWords: 'Driver',
          kind: 'driver',
          mobile: d.mobile ?? null,
          mobileWords: mobileWords(d.mobile),
          active: !!d.active,
        },
        messages: this.personMessages('driver', d.id),
        today: it ? { item: it.id, time: it.time, timeWords: timeWords(it.time), truck, trips } : null,
      };
    }
    let w = null;
    try {
      w = this.repo.get(id, 'resource');
    } catch {}
    requireRule(w && w.type === 'WORKER', 'Choose someone in your team.');
    if (!ctx.ops) {
      const theirs = ctx.mine.has(w.location) || this.personMessages('worker', w.id).some((m) => ctx.mine.has(m.site));
      if (!theirs) throw new AppError(403, 'You can only access your assigned sites.');
    }
    const role = this.roleOf(w),
      it = this.planDayItems(today, 'WORKERS').find((x) => x.people.some((p) => p.person === w.id)) ?? null,
      row = it?.people.find((p) => p.person === w.id);
    return {
      person: {
        id: w.id,
        name: w.name,
        role,
        roleWords: ROLE_WORDS[role],
        kind: 'worker',
        mobile: ctx.ops ? (w.mobile ?? null) : null,
        mobileWords: ctx.ops ? mobileWords(w.mobile) : null,
        active: !!w.enabled,
      },
      messages: this.personMessages('worker', w.id).filter((m) => ctx.ops || ctx.mine.has(m.site)),
      today:
        it && (ctx.ops || ctx.mine.has(it.site))
          ? {
              item: it.id,
              site: it.site,
              siteName: this.planSiteName(it.site),
              time: it.time,
              timeWords: timeWords(it.time),
              answer: this.planAnswerOf(this.planMsg(row.message), ctx.now),
              onSite: !!row.moved && !row.homeAt,
            }
          : null,
    };
  },
  // ---------- GET /api/today ----------
  todayView() {
    this.planScopeCheck();
    const ctx = this.planCtx(),
      today = ctx.today,
      yesterday = addDays(today, -1),
      tomorrow = ctx.cal.tomorrow,
      now = ctx.now,
      cfg = this.repo.all('config')[0] ?? null;
    const sites = [...ctx.sites.values()]
      .filter((s) => s.status === 'ACTIVE' && ctx.mine.has(s.id))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const items = cached(this.db, RANGE)
      .all(this.repo.company, yesterday, addDays(today, 400))
      .map((r) => this.repo.decode(r))
      .filter((i) => i.status !== 'CANCELLED' || i.day === yesterday);
    this.planLoadMsgs(ctx, items);
    const seen = items.filter((i) => this.planVisible(i, ctx, items)),
      todays = seen.filter((i) => i.day === today && i.status !== 'CANCELLED'),
      runs = this.planRuns(ctx);
    const lateAll = cached(this.db, LATE)
      .all(this.repo.company, yesterday)
      .map((r) => this.repo.decode(r));
    this.planLoadMsgs(ctx, lateAll);
    const missedItems = lateAll.filter((i) => this.planVisible(i, ctx, lateAll));
    const label = (id) => {
        const p = ctx.people.get(id);
        return p ? this.teamLabel(p) : 'Someone';
      },
      answerOf = (mid) => this.planAnswerOf(ctx.msgs.get(mid), now);
    // gear at each site: pieces and when the first stillage there was set down
    const on = new Map(),
      first = new Map();
    for (const c of this.containers()) {
      if (!ctx.sites.has(c.location)) continue;
      const n = this.repo.lines(c.id).reduce((k, l) => k + l.quantity, 0);
      on.set(c.location, (on.get(c.location) ?? 0) + n);
      if (c.placedAt && (!first.has(c.location) || c.placedAt < first.get(c.location)))
        first.set(c.location, c.placedAt);
    }
    const workers = this.repo.all('resource').filter((r) => r.type === 'WORKER' && r.enabled),
      kinds = this.placeKinds();
    // ---- 1. sites today ----
    const siteRows = sites.map((s) => {
      const mats = seen.filter((i) => i.type === 'MATERIALS' && i.site === s.id && PLAN_OPEN.includes(i.status));
      let toGo = mats.reduce(
        (n, i) =>
          n +
          Math.max(
            0,
            i.lines.reduce((k, l) => k + l.quantity, 0) -
              (i.trips ?? []).filter((x) => x.delivered).reduce((k, x) => k + (x.pieces ?? 0), 0),
          ),
        0,
      );
      for (const l of this.repo.all('loadList'))
        if (l.site === s.id && !l.cancelled && !l.delivery) {
          const v = runs.find((r) => r.id === l.id);
          if (v && !v.done) toGo += Math.max(0, (v.pieces ?? 0) - (v.delivered ?? 0));
        }
      for (const r of this.repo.all('request'))
        if (r.site === s.id && !r.loadList && ['REQUESTED', 'ALLOCATED', 'PARTIALLY ALLOCATED'].includes(r.status))
          toGo += Math.max(0, r.quantity - (r.delivered ?? 0));
      const here = on.get(s.id) ?? 0,
        coming = this.repo
          .all('collection')
          .some(
            (o) =>
              o.site === s.id &&
              o.scope === 'ALL' &&
              ['REQUESTED', 'BOOKED', 'LOADING', 'ON THE WAY'].includes(o.status),
          );
      const onWay = [...ctx.trucks.values()].some(
        (t) =>
          !t.retired &&
          t.game?.kind === 'SEND' &&
          t.game.site === s.id &&
          ['LOADING', 'DRIVING', 'UNLOADING'].includes(t.game.stage),
      );
      // who is there now: people borrowed for today by name, then its own crew; people booked who haven't arrived yet say when they come
      const borrowed = workers.filter((w) => w.location === s.id && w.away),
        own = workers.filter((w) => w.location === s.id && !w.away).length,
        due = [];
      for (const i of todays)
        if (i.type === 'WORKERS' && i.site === s.id && PLAN_OPEN.includes(i.status))
          for (const p of i.people)
            if (
              !p.moved &&
              answerOf(p.message) === 'YES' &&
              now < this.planAt(i.day, i.time) &&
              ctx.people.get(p.person)?.location !== s.id
            )
              due.push({ name: label(p.person), time: i.time });
      const crewOn =
        borrowed.length > 0 || todays.some((i) => i.type === 'WORKERS' && i.site === s.id && i.status === 'ACTIVE');
      const stage = s.finishing
        ? 'Being taken down'
        : coming
          ? 'Coming down'
          : onWay
            ? 'Gear on the way'
            : here === 0 && toGo > 0
              ? 'Waiting for gear'
              : here > 0 && toGo > 0
                ? 'Going up'
                : crewOn
                  ? 'Crew on site'
                  : here > 0
                    ? 'All gear on site'
                    : 'Quiet';
      const days = here > 0 && first.has(s.id) ? daysBetween(this.planDayOfIso(first.get(s.id)), today) + 1 : null;
      const names = borrowed.map((w) => this.teamLabel(w));
      const dueWords = due.length
        ? due.map((x) => x.name).join(', ') +
          ' from ' +
          timeWords(due.reduce((a, x) => (x.time < a ? x.time : a), due[0].time))
        : null;
      const whoWords =
        [names.length ? names.join(', ') : null, own ? plural(own, 'site crew member', 'site crew') : null]
          .filter(Boolean)
          .join(' + ') || (dueWords ? null : 'Nobody there');
      // the next thing still to come (not one already under way)
      const next =
        [
          ...seen
            .filter(
              (i) =>
                i.site === s.id &&
                i.status === 'PLANNED' &&
                i.day >= today &&
                (i.day > today || this.planAt(i.day, i.time) > now) &&
                (i.type === 'MATERIALS' || i.type === 'WORKERS'),
            )
            .map((i) => ({
              kind: i.type === 'MATERIALS' ? 'materials' : 'workers',
              id: i.id,
              day: i.day,
              sort: i.time,
              when: timeWords(i.time),
              what: i.type === 'MATERIALS' ? 'materials' : plural(i.count, 'worker'),
            })),
          ...runs
            .filter((r) => r.site === s.id && r.open && r.day >= today)
            .map((r) => ({
              kind: r.kind,
              id: r.id,
              day: r.day,
              sort: SLOT_TIME[r.slot ?? 'ANY'],
              when: SLOT_WORDS[r.slot ?? 'ANY'].toLowerCase(),
              what: r.kind === 'collection' ? 'collection' : r.kind === 'loadList' ? 'yard list' : 'delivery',
            })),
        ].sort((a, b) => a.day.localeCompare(b.day) || a.sort.localeCompare(b.sort))[0] ?? null;
      const busyToday = todays.some((i) => i.site === s.id) || runs.some((r) => r.site === s.id && r.day === today);
      return {
        id: s.id,
        name: s.name,
        address: s.address ?? null,
        stage,
        on: here,
        toGo,
        bar: here + toGo > 0 ? Math.round((1000 * here) / (here + toGo)) / 1000 : null,
        day: days,
        dayWords: days ? 'Day ' + days + ' on site' : null,
        who: names,
        crew: own,
        coming: due.map((x) => x.name),
        whoWords: [whoWords, dueWords].filter(Boolean).join(' · '),
        next: next ? { ...next, words: 'Next: ' + next.what + ' ' + dayLabel(next.day) + ', ' + next.when } : null,
        today: busyToday,
        finishing: !!s.finishing,
      };
    });
    siteRows.sort((a, b) => b.today - a.today || a.name.localeCompare(b.name, undefined, { numeric: true }));
    // ---- 2. paperwork ----
    const planned = new Set([
        ...seen.filter((i) => PLAN_OPEN.includes(i.status) && i.site).map((i) => i.site),
        ...runs.filter((r) => r.open).map((r) => r.site),
      ]),
      gearAt = new Set([...on].filter(([, n]) => n > 0).map(([id]) => id));
    const paperwork = {
      ...this.paperworkView(today, sites, {
        ops: ctx.ops,
        owner: ctx.perms.includes('company.manage'),
        planned,
        gearAt,
      }),
      canAdd: ctx.perms.includes('requests.create'),
    };
    // ---- 3. who's in today ----
    const roster = {
        atYard: [],
        onSite: [],
        driving: [],
        waiting: [],
        notBooked: [],
        tomorrow: { notAnswered: 0, cantMake: 0, words: null },
      },
      booked = new Set();
    for (const i of todays) {
      if (i.status === 'MISSED') continue; // it didn't go: shown once, under the bookings to sort
      if (i.type === 'WORKERS')
        for (const p of i.people) {
          const m = ctx.msgs.get(p.message),
            a = answerOf(p.message),
            n = label(p.person),
            sn = ctx.sites.get(i.site)?.name ?? 'the site';
          booked.add(p.person);
          const later = !p.moved && now < this.planAt(i.day, i.time);
          if (p.moved || a === 'YES')
            roster.onSite.push({
              id: p.person,
              name: n,
              site: i.site,
              siteName: sn,
              time: i.time,
              timeWords: timeWords(i.time),
              answer: a,
              here: !!p.moved && !p.homeAt,
              wentHome: !!p.homeAt,
              coming: later,
              words: later
                ? 'Going to ' + sn + ' at ' + timeWords(i.time)
                : n + ' · ' + sn + ' from ' + timeWords(i.time),
            });
          if (['WAITING', 'NO_ANSWER', 'NO'].includes(a) && !p.moved)
            roster.waiting.push({
              id: p.person,
              name: n,
              item: i.id,
              answer: a,
              reason: m?.answer?.reason ?? null,
              words:
                a === 'NO'
                  ? "Can't make it" + (m?.answer?.reason ? ': ' + m.answer.reason : '')
                  : a === 'WAITING'
                    ? "Hasn't answered yet"
                    : 'No answer',
              what: sn + ' at ' + timeWords(i.time),
            });
        }
      if (i.type === 'TRUCK' && i.driver && ctx.ops) {
        const m = ctx.msgs.get(i.message),
          a = answerOf(i.message),
          n = label(i.driver),
          tn = i.truck
            ? ctx.trucks.get(i.truck)?.name
            : i.hire?.truck
              ? (ctx.trucks.get(i.hire.truck)?.name ?? 'Hire truck')
              : 'Hire truck';
        booked.add(i.driver);
        roster.driving.push({
          id: i.driver,
          name: n,
          truckName: tn,
          item: i.id,
          answer: a,
          time: i.time,
          words: n + ' · ' + tn + ' from ' + timeWords(i.time),
        });
        if (['WAITING', 'NO_ANSWER', 'NO'].includes(a))
          roster.waiting.push({
            id: i.driver,
            name: n,
            item: i.id,
            answer: a,
            reason: m?.answer?.reason ?? null,
            words:
              a === 'NO'
                ? "Can't make it" + (m?.answer?.reason ? ': ' + m.answer.reason : '')
                : a === 'WAITING'
                  ? "Hasn't answered yet"
                  : 'No answer',
            what: 'Driving ' + tn,
          });
      }
    }
    if (ctx.ops && this.live()) {
      // a real yard: nobody signs on in the app yet, so nobody is "at the yard" or idle; the team not booked today is listed by name
      for (const w of workers)
        if (!w.away && !booked.has(w.id))
          roster.notBooked.push({
            id: w.id,
            kind: 'worker',
            name: this.teamLabel(w),
            roleWords: ROLE_WORDS[this.roleOf(w, kinds)],
            where: null,
          });
      for (const d of this.teamDrivers())
        if (!booked.has(d.id))
          roster.notBooked.push({ id: d.id, kind: 'driver', name: d.name, roleWords: 'Driver', where: null });
    } else if (ctx.ops) {
      for (const w of workers)
        if (kinds.get(w.location) === 'yard' && !w.away) {
          const role = this.roleOf(w, kinds);
          roster.atYard.push({
            id: w.id,
            name: this.teamLabel(w),
            role,
            roleWords: ROLE_WORDS[role],
            state: crewState(w),
            busy: crewBusy(w),
          });
        }
      for (const w of workers)
        if (kinds.get(w.location) === 'site' && !w.away && !booked.has(w.id)) {
          const role = this.roleOf(w, kinds);
          roster.notBooked.push({
            id: w.id,
            kind: 'worker',
            name: this.teamLabel(w),
            roleWords: ROLE_WORDS[role],
            where: ctx.sites.get(w.location)?.name ?? null,
          });
        }
      for (const d of this.teamDrivers())
        if (!booked.has(d.id))
          roster.notBooked.push({ id: d.id, kind: 'driver', name: d.name, roleWords: 'Driver', where: null });
    } else
      for (const w of workers)
        if (ctx.mine.has(w.location) && !w.away && !booked.has(w.id))
          roster.notBooked.push({
            id: w.id,
            kind: 'worker',
            name: this.teamLabel(w),
            roleWords: ROLE_WORDS[this.roleOf(w, kinds)],
            where: ctx.sites.get(w.location)?.name ?? null,
          });
    const rank = { NO: 0, NO_ANSWER: 1, WAITING: 2 };
    roster.waiting.sort((a, b) => rank[a.answer] - rank[b.answer] || a.name.localeCompare(b.name));
    {
      let n = 0,
        no = 0;
      for (const i of seen)
        if (i.day === tomorrow && PLAN_OPEN.includes(i.status)) {
          const ms =
            i.type === 'WORKERS'
              ? i.people.filter((p) => !p.moved).map((p) => p.message)
              : i.type === 'TRUCK' && i.driver && ctx.ops
                ? [i.message]
                : [];
          for (const mid of ms) {
            const a = answerOf(mid);
            if (a === 'WAITING' || a === 'NO_ANSWER') n++;
            else if (a === 'NO') no++;
          }
        }
      roster.tomorrow = {
        notAnswered: n,
        cantMake: no,
        words:
          [
            no ? plural(no, "person can't", "people can't") + ' make it tomorrow: pick someone else' : null,
            n ? plural(n, "person hasn't", "people haven't") + ' answered for tomorrow' : null,
          ]
            .filter(Boolean)
            .join(' · ') || null,
      };
    }
    roster.booked = booked.size;
    roster.words = roster.waiting.length
      ? plural(roster.waiting.length, 'person needs', 'people need') + ' sorting'
      : null;
    roster.sub =
      roster.words ??
      (roster.onSite.length || roster.driving.length
        ? 'Everyone who is booked has said yes'
        : 'Nobody booked to a site today');
    // ---- 4. yesterday & where we begin today ----
    const ydel = this.repo
      .all('delivery')
      .filter(
        (d) =>
          d.status === 'DELIVERED' &&
          this.planDayOfIso(d.completedAt) === yesterday &&
          ctx.sites.has(d.to) &&
          ctx.mine.has(d.to),
      );
    const yrt = this.repo
      .all('collection')
      .filter((o) => o.status === 'RETURNED' && this.planDayOfIso(o.returnedAt) === yesterday && ctx.mine.has(o.site));
    // a re-stack that found nothing to do isn't news
    const ydone = seen.filter(
      (i) =>
        i.status === 'DONE' &&
        this.planDayOfIso(i.doneAt) === yesterday &&
        i.type !== 'TRUCK' &&
        !(i.type === 'RESTACK' && !i.moved?.pieces && !i.moved?.stacked),
    );
    const yardJobs = ctx.ops
      ? cached(
          this.db,
          "SELECT COALESCE(SUM(json_extract(data,'$.jobsDone')),0) n FROM objects WHERE company_id=? AND kind='crewDay' AND json_extract(data,'$.day')=?",
        ).get(this.repo.company, yesterday).n
      : 0;
    const lines = [];
    const bySite = new Map();
    for (const d of ydel) {
      const e = bySite.get(d.to) ?? { pieces: 0, stillages: 0, known: true };
      e.stillages += (d.containers ?? []).length;
      if (d.pieces != null) e.pieces += d.pieces;
      else e.known = false;
      bySite.set(d.to, e);
    }
    for (const [sid, e] of bySite)
      lines.push({
        kind: 'delivery',
        words:
          'Delivered to ' +
          (ctx.sites.get(sid)?.name ?? 'a site') +
          ': ' +
          (e.known ? plural(e.pieces, 'piece') : plural(e.stillages, 'stillage')),
      });
    for (const o of yrt)
      lines.push({
        kind: 'collection',
        words:
          'Brought back from ' +
          (ctx.sites.get(o.site)?.name ?? 'a site') +
          (o.pieces != null ? ': ' + plural(o.pieces, 'piece') : ''),
      });
    for (const i of ydone) {
      const sn = ctx.sites.get(i.site)?.name ?? 'the site';
      lines.push({
        kind: i.type.toLowerCase(),
        words:
          i.type === 'MATERIALS'
            ? 'List for ' + sn + (i.leftOver ? ' part delivered' : ' delivered')
            : i.type === 'RESTACK'
              ? 'Re-stack: ' +
                [
                  i.moved?.pieces ? plural(i.moved.pieces, 'piece') + ' topped up' : null,
                  i.moved?.stacked ? plural(i.moved.stacked, 'empty', 'empties') + ' stacked' : null,
                ]
                  .filter(Boolean)
                  .join(', ')
              : plural(i.people.filter((p) => p.moved).length, 'worker') + ' at ' + sn,
      });
    }
    if (yardJobs) lines.push({ kind: 'jobs', words: 'The yard crew did ' + plural(yardJobs, 'job') });
    const yesterdayDone = {
      day: yesterday,
      dayLabel: dayLabel(yesterday),
      deliveries: ydel.length,
      collections: yrt.length,
      items: ydone.length,
      yardJobs,
      lines: lines.slice(0, 5),
      more: Math.max(0, lines.length - 5),
      quiet: !lines.length,
      words: lines.length ? null : 'A quiet day, nothing moved.',
    };
    const timeline = [
      ...todays
        .filter((i) => i.status !== 'MISSED')
        .map((i) => {
          const v = this.planItemView(i, ctx);
          return {
            kind: 'plan',
            type: i.type,
            id: i.id,
            sort: i.time,
            when: timeWords(i.time),
            words:
              i.type === 'TRUCK'
                ? (v.truckName ?? 'Truck') + (v.driverName ? ' · ' + v.driverName : '')
                : i.type === 'MATERIALS'
                  ? 'List for ' + (v.siteName ?? 'a site')
                  : i.type === 'WORKERS'
                    ? plural(i.count, 'worker') + ' → ' + (v.siteName ?? 'a site')
                    : 'Re-stack the yard',
            status: v.words,
            done: i.status === 'DONE',
            red: v.flags.red,
          };
        }),
      ...runs
        .filter((r) => r.day === today && !r.done)
        .map((r) => ({
          kind: r.kind,
          type: r.kind,
          id: r.id,
          sort: r.time ?? SLOT_TIME[r.slot ?? 'ANY'],
          when: r.time ? timeWords(r.time) : SLOT_WORDS[r.slot ?? 'ANY'],
          words:
            (r.kind === 'collection'
              ? 'Bring back from '
              : r.kind === 'trip'
                ? (r.runTruckName ?? 'A truck') + ' to '
                : 'Load for ') + (r.siteName ?? 'a site'),
          status: r.status,
          done: false,
          red: false,
        })),
    ].sort((a, b) => a.sort.localeCompare(b.sort) || a.words.localeCompare(b.words));
    const missed = missedItems.map((i) => ({
      id: i.id,
      day: i.day,
      dayLabel: dayLabel(i.day),
      type: i.type,
      words:
        (i.type === 'MATERIALS'
          ? 'List for ' + (ctx.sites.get(i.site)?.name ?? 'a site')
          : i.type === 'WORKERS'
            ? plural(i.count, 'worker') + ' → ' + (ctx.sites.get(i.site)?.name ?? 'a site')
            : i.type === 'TRUCK'
              ? 'Truck booking'
              : 'Re-stack') +
        ' · ' +
        dayLabel(i.day),
      status: i.status === 'MISSED' ? "Didn't go: pick a new day or cancel it" : "Didn't finish",
    }));
    const beginToday = {
      items: timeline.slice(0, 6),
      more: Math.max(0, timeline.length - 6),
      missed,
      words: timeline.length ? null : 'Nothing booked for today yet.',
    };
    // ---- 5. the business ----
    let business = null;
    if (ctx.ops) {
      let pieces = 0,
        gearSites = 0;
      for (const [sid, n] of on)
        if (n > 0 && ctx.sites.get(sid)) {
          pieces += n;
          gearSites++;
        }
      const liveTasks = this.tasks().filter(active),
        trucks = [...ctx.trucks.values()].filter((t) => !t.retired),
        busyTruck = (t) =>
          t.status !== 'AT_YARD' || !!t.game || liveTasks.some((x) => x.to === t.id || x.from === t.id);
      const crew = workers.filter((w) => kinds.get(w.location) === 'yard' && !w.away);
      business = {
        gear: {
          pieces,
          sites: gearSites,
          words: pieces
            ? plural(pieces, 'piece') + ' out on hire at ' + plural(gearSites, 'site')
            : 'No gear out on hire',
        },
        trucks: { busy: trucks.filter(busyTruck).length, all: trucks.length },
        crew: { busy: crew.filter(crewBusy).length, all: crew.length },
        money: null,
        moneyShown: false,
      };
      if (ctx.perms.includes('finance.view')) {
        const h = this.hire({}),
          noRates = !h.rates.length && !h.siteRates.length,
          missing = h.unpriced.length;
        // the Practice yard: everything built up since hire began is still to invoice; a real yard: what is unbilled past each
        // site's billedUpTo, and since when (ADR 0011)
        const u = this.live() ? this.unbilledView() : null;
        const built = u ? u.amount : (h.sites ?? []).reduce((n, r) => n + (r.accrued ?? 0), 0);
        business.moneyShown = true;
        business.money = noRates
          ? { noRates: true, words: "Set your prices to see what you're earning", setPrices: { view: 'HIRE' } }
          : {
              noRates: false,
              thisWeek: h.totals.thisWeek,
              thisMonth: h.totals.thisMonth,
              builtUp: built,
              toInvoice: built + hireGst(built),
              toInvoiceWords: u
                ? u.since
                  ? 'Unbilled since ' + dayLabel(u.since) + ' (incl. GST)'
                  : 'Nothing unbilled'
                : 'Built up since hire began, to invoice (incl. GST)',
              unbilled: u ? { amount: u.amount, incGst: u.incGst, since: u.since, days: u.days, words: u.words } : null,
              gstPercent: h.gstPercent,
              unpricedParts: missing,
              weekMissing: h.totals.weekMissing,
              monthMissing: h.totals.monthMissing,
              missingWords:
                missing || h.totals.weekMissing || h.totals.monthMissing
                  ? 'Some gear on hire has no price yet' + (missing ? ' (' + plural(missing, 'part') + ')' : '')
                  : null,
              setPrices: { view: 'HIRE' },
              footnote: u
                ? 'Ex GST unless marked. Statements are issued on the Hire page; your accounting package issues the invoice and records the payment.'
                : "Ex GST unless marked. The app doesn't record payments yet or send invoices, so this is what's built up, not what's been paid.",
            };
      }
    }
    // ---- head sentence ----
    const waiting = roster.waiting.length,
      nToday = timeline.length,
      nTomorrow =
        seen.filter((i) => i.day === tomorrow && PLAN_OPEN.includes(i.status)).length +
        runs.filter((r) => r.day === tomorrow && r.open).length,
      no = roster.tomorrow.cantMake;
    const sentence =
      (nToday ? plural(nToday, 'thing') + ' today' : 'Nothing planned today.') +
      (waiting ? ' · ' + plural(waiting, "person hasn't", "people haven't") + ' answered' : '') +
      (no
        ? (nToday ? ' · ' : ' ') + 'Tomorrow: ' + plural(no, "person can't", "people can't") + ' make it'
        : !nToday && nTomorrow
          ? ' Tomorrow: ' + plural(nTomorrow, 'thing') + '.'
          : '') +
      (missed.length ? ' · ' + plural(missed.length, 'booking needs', 'bookings need') + ' sorting' : '');
    return {
      today,
      todayLabel: dayLabel(today),
      yesterday,
      tomorrow,
      now: iso(now),
      paused: !!cfg?.paused,
      timeZone: ctx.cal.timeZone,
      rev: planRevision(this.db, this.repo.company),
      summary: { sentence, today: nToday, waiting, tomorrow: nTomorrow, cantMakeTomorrow: no, missed: missed.length },
      sites: siteRows,
      paperwork,
      roster,
      yesterdayDone,
      beginToday,
      business,
    };
  },
  // result.plan in /api/state: the plan revision and today's counts (the Today page refetches when rev changes).
  planSnapshot(result) {
    const p = this.auth.permissions(this.user);
    if (!p.includes('operations.manage') && !p.includes('sites.assigned')) return;
    const ctx = this.planCtx();
    const items = cached(this.db, RANGE)
      .all(this.repo.company, ctx.today, ctx.today)
      .map((r) => this.repo.decode(r))
      .filter((i) => i.status !== 'CANCELLED');
    this.planLoadMsgs(ctx, items);
    const mine = items.filter((i) => this.planVisible(i, ctx, items));
    let waiting = 0,
      red = 0;
    for (const i of mine) {
      const v = this.planItemView(i, ctx);
      if (v.flags.needsAnswer) waiting++;
      if (v.flags.red) red++;
    }
    result.plan = { rev: planRevision(this.db, this.repo.company), today: { items: mine.length, waiting, red } };
  },
  // Alerts (alerts.js alertsView): expired paperwork (high), a SWMS overdue for review (medium), paperwork due within 14 days (low), and people who can't make it or haven't answered
  // for today or tomorrow (medium). Target: the Today page on that day.
  planAlerts({ operations, sites, today }) {
    const out = [],
      months = this.paperMonths(),
      visible = new Map(sites.filter((s) => s.status === 'ACTIVE').map((s) => [s.id, s]));
    for (const p of this.repo.all('paperwork')) {
      if (p.archived || (p.site && !visible.has(p.site))) continue;
      const st = paperState(p, today, months);
      if (st.status === 'OK') continue;
      const sn = p.site ? visible.get(p.site).name : null;
      out.push({
        id: 'PAPERWORK:' + p.id,
        kind: 'PAPERWORK',
        severity: st.status === 'EXPIRED' ? (st.review ? 'medium' : 'high') : 'low',
        title: p.title + (sn ? ' – ' + sn : ' – whole company'),
        detail: st.words + (st.review ? ' · mark it reviewed on the Today page' : ' · renew it on the Today page'),
        target: { view: 'TODAY', day: today },
        site: p.site ?? null,
        paperwork: p.id,
        daysLate: st.status === 'EXPIRED' ? -st.days : 0,
      });
    }
    const now = this.planNow(),
      tomorrow = addDays(today, 1),
      ctx = { ops: operations, mine: new Set(visible.keys()) };
    const items = cached(this.db, RANGE)
      .all(this.repo.company, today, tomorrow)
      .map((r) => this.repo.decode(r))
      .filter((i) => PLAN_OPEN.includes(i.status) && (i.type === 'WORKERS' || i.type === 'TRUCK'));
    if (items.length)
      for (const row of cached(this.db, MSGS_FOR).all(this.repo.company, JSON.stringify(items.map((i) => i.id)))) {
        const m = this.repo.decode(row);
        if (!['DRIVE', 'WORK'].includes(m.subject)) continue;
        const it = items.find((i) => i.id === m.item);
        if (!it || !this.planVisible(it, ctx, items)) continue;
        if (it.type === 'WORKERS' && !it.people.some((p) => p.message === m.id && !p.moved)) continue;
        if (it.type === 'TRUCK' && it.message !== m.id) continue;
        const a = this.planAnswerOf(m, now);
        if (a !== 'NO' && a !== 'NO_ANSWER') continue;
        const what =
          m.subject === 'DRIVE'
            ? 'Driving on ' + dayLabel(m.day)
            : this.planSiteName(m.site) + ' on ' + dayLabel(m.day);
        out.push({
          id: 'ANSWER:' + m.id,
          kind: 'ANSWER',
          severity: 'medium',
          title: (m.personName || 'Someone') + (a === 'NO' ? " can't make it" : " hasn't answered"),
          detail:
            what +
            (a === 'NO' && m.answer?.reason ? ' · ' + m.answer.reason : '') +
            ' · ask someone else on the Today page',
          target: { view: 'TODAY', day: m.day },
          site: m.site ?? null,
          message: m.id,
        });
      }
    // bookings whose day passed without them going (a list that didn't go, or anything still open from an earlier day)
    for (const it of cached(this.db, LATE)
      .all(this.repo.company, addDays(today, -1))
      .map((r) => this.repo.decode(r))) {
      if (!this.planVisible(it, ctx, [])) continue;
      const sn = it.site ? (visible.get(it.site)?.name ?? 'a site') : null;
      out.push({
        id: 'MISSED:' + it.id,
        kind: 'MISSED',
        severity: 'high',
        title:
          (it.type === 'MATERIALS'
            ? 'List for ' + sn
            : it.type === 'WORKERS'
              ? 'Workers for ' + sn
              : it.type === 'TRUCK'
                ? 'Truck booking'
                : 'Re-stack') + " didn't go",
        detail: dayLabel(it.day) + (it.why ? ' · ' + it.why : '') + ' · pick a new day on the Today page',
        target: { view: 'TODAY', day: it.day },
        site: it.site ?? null,
        item: it.id,
      });
    }
    return out;
  },
};
