// @ts-check
// "Needs you" v1 (ADR 0010, audit H5/#17): one calm list for a real yard, built by deterministic rules over LIVE records only, each item
// with one action, at most 5 shown, dismissed with a reason. The board shows one chip ("Needs you · 3"); Today shows the top 5 card.
// Rules, in rank order: UNCONFIRMED_TRIP (the clock flagged a trip), RETURN_SHORT (a return not counted or not resolved; a site still
// looking), NO_DRIVER_YES (a truck booked tomorrow without the driver's yes by 5 pm), CLASH (a truck, a driver or a person booked twice
// on one day), the clock's booking flags (NOT_CONFIRMED, NOT_ASKED, NO_ANSWER, CANT_MAKE_IT), PAPERWORK (expired or due for review),
// UNPRICED_ON_HIRE (a product on hire with no rate). An item's id changes when its fact changes, so a dismissed one comes back only
// when something new happens. Nothing here writes, except needsYouDismiss.
import { requireRule } from './geometry.js';
import { cached } from '../database.js';
import { requireLive } from './mode.js';
import { addDays, dayLabel } from './schedule.js';
import { paperState } from './paperwork.js';
import { timeWords } from './plantime.js';
export const NEEDS_CAP = 5,
  NEEDS_DAYS = 14,
  NEEDS_YES_BY = '17:00',
  NEEDS_GRACE_MS = 60 * 60 * 1000;
export const NEEDS_RANK = {
  UNCONFIRMED_TRIP: 0,
  RETURN_SHORT: 1,
  NO_DRIVER_YES: 2,
  CLASH: 3,
  NOT_CONFIRMED: 4,
  NOT_ASKED: 4,
  NO_ANSWER: 4,
  CANT_MAKE_IT: 4,
  TASK_NOT_DONE: 4,
  ROSTER_DENIED: 4,
  PAPERWORK: 5,
  UNPRICED_ON_HIRE: 6,
};
/** @type {(n:number,one:string,many?:string)=>string} */
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
const RANGE =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='planItem' AND json_extract(data,'$.day') BETWEEN ? AND ? AND json_extract(data,'$.status') IN ('DRAFT','PLANNED','ACTIVE','MISSED') ORDER BY rowid";
const OPEN_LATE =
  "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='planItem' AND json_extract(data,'$.status') IN ('PLANNED','ACTIVE','MISSED') AND json_extract(data,'$.day')<? ORDER BY rowid";

/** @type {Record<string,any> & ThisType<any>} */
export const needsMethods = {
  // The list: {count, items (at most 5), more, dismissed}. Empty outside a real yard or for someone without operations.manage.
  needsYou() {
    if (!this.live() || !this.auth.permissions(this.user).includes('operations.manage'))
      return { count: 0, items: [], more: 0, cap: NEEDS_CAP };
    const now = this.planNow(),
      cal = this.planNowCal(),
      today = cal.today,
      tomorrow = addDays(today, 1);
    /** @type {any[]} */
    const items = [];
    const push = (/** @type {any} */ x) => items.push({ ...x, rank: NEEDS_RANK[x.kind] ?? 9 });
    // trips the clock flagged, and returns short
    for (const t of this.tripRows('trip', "json_type(data,'$.flag')='object'")) {
      const f = t.flag;
      if (!f) continue;
      if (f.code === 'UNCONFIRMED_TRIP')
        push({
          id: 'UNCONFIRMED_TRIP:' + t.id + ':' + f.since,
          kind: 'UNCONFIRMED_TRIP',
          words: this.tripLabel(t) + ' to ' + this.planSiteName(t.site) + ': ' + f.words,
          action: { label: 'Confirm', view: 'TRIPS', trip: t.id },
          since: f.since,
          site: t.site,
        });
      else if (f.code === 'RETURN_SHORT')
        push({
          // the id says which fact: not counted, or how many are missing; a count that comes up short is a new item (a dismissal lapses)
          id:
            'RETURN_SHORT:' +
            t.id +
            ':' +
            (t.countPending
              ? 'count'
              : 'short' +
                (t.notBack ?? []).reduce((/** @type {number} */ n, /** @type {any} */ l) => n + l.quantity, 0)) +
            ':' +
            f.since,
          kind: 'RETURN_SHORT',
          words: this.tripLabel(t) + ' from ' + this.planSiteName(t.site) + ': ' + f.words,
          action: { label: t.countPending ? 'Count' : 'Sort it out', view: 'TRIPS', trip: t.id },
          since: f.since,
          site: t.site,
        });
    }
    for (const s of this.repo.all('site'))
      if (s.status === 'ACTIVE' && s.looking)
        push({
          id: 'RETURN_SHORT:site:' + s.id + ':' + s.looking.since,
          kind: 'RETURN_SHORT',
          words:
            s.name +
            ': still looking for ' +
            plural(s.looking.missing, 'piece') +
            ' since ' +
            dayLabel(this.planDayOfIso(s.looking.since)),
          action: { label: 'Finish site', view: 'SITES', site: s.id },
          since: s.looking.since,
          site: s.id,
        });
    // tomorrow's trucks without the driver's yes by 5 pm today
    const ahead = cached(this.db, RANGE)
      .all(this.repo.company, today, addDays(today, NEEDS_DAYS))
      .map((/** @type {any} */ r) => this.repo.decode(r));
    if (now >= this.clockAt(today, NEEDS_YES_BY))
      for (const it of ahead) {
        if (
          it.type !== 'TRUCK' ||
          it.day !== tomorrow ||
          !['PLANNED', 'ACTIVE'].includes(it.status) ||
          (!it.truck && !it.hire)
        )
          continue;
        const m = this.planMsg(it.message);
        if (m?.status === 'YES') continue;
        // a calm chip, not an alarm: an ask that went out after 5 pm gets an hour before "no yes" is worth a call
        const askedAt = Date.parse(m?.sentAt ?? it.sentAt ?? it.createdAt ?? '') || 0;
        if (askedAt >= this.clockAt(today, NEEDS_YES_BY) && now - askedAt < NEEDS_GRACE_MS) continue;
        const name = it.driver ? this.planName(it.driver) : null;
        push({
          id: 'NO_DRIVER_YES:' + it.id + ':' + it.day + ':' + (m?.id ?? 'none'),
          kind: 'NO_DRIVER_YES',
          words:
            this.planWhat(it) +
            ' tomorrow ' +
            timeWords(it.time) +
            ': ' +
            (name ? name + (m?.status === 'NO' ? " can't make it" : ' has not said yes') : 'no driver named'),
          action: name
            ? { label: 'Call ' + name, view: 'TODAY', day: it.day, item: it.id }
            : { label: 'Pick a driver', view: 'TODAY', day: it.day, item: it.id },
          since: it.updatedAt ?? it.createdAt,
          item: it.id,
        });
      }
    // clashes: a truck, a driver or a person twice on one day
    const byDay = new Map();
    for (const it of ahead) {
      if (it.status === 'MISSED') continue;
      let d = byDay.get(it.day);
      if (!d) byDay.set(it.day, (d = { trucks: new Map(), drivers: new Map(), people: new Map() }));
      const put = (/** @type {Map<string,any[]>} */ m, /** @type {string} */ k) => m.set(k, [...(m.get(k) ?? []), it]);
      if (it.type === 'TRUCK') {
        if (it.truck) put(d.trucks, it.truck);
        if (it.driver) put(d.drivers, it.driver);
      }
      if (it.type === 'WORKERS')
        for (const p of it.people) if (!(this.planMsg(p.message)?.status === 'NO' && !p.moved)) put(d.people, p.person);
    }
    for (const [day, d] of byDay)
      for (const [what, m] of [
        ['truck', d.trucks],
        ['driver', d.drivers],
        ['person', d.people],
      ])
        for (const [id, list] of m)
          if (list.length > 1)
            push({
              id:
                'CLASH:' +
                what +
                ':' +
                id +
                ':' +
                day +
                ':' +
                list
                  .map((/** @type {any} */ x) => x.id)
                  .sort()
                  .join(','),
              kind: 'CLASH',
              words:
                this.planName(id, 'Someone') +
                ' is booked ' +
                list.length +
                ' times on ' +
                dayLabel(day) +
                (what === 'person'
                  ? ' (' + list.map((/** @type {any} */ x) => this.planSiteName(x.site)).join(', ') + ')'
                  : ''),
              action: { label: 'Move one', view: 'TODAY', day, item: list[0].id },
              since: day,
            });
    // the clock's flags on bookings: not confirmed, not asked in time, no answer, can't make it (today, tomorrow and anything left open)
    const late = cached(this.db, OPEN_LATE)
      .all(this.repo.company, today)
      .map((/** @type {any} */ r) => this.repo.decode(r));
    const seen = new Set();
    for (const it of [...late, ...ahead]) {
      if (seen.has(it.id) || !['PLANNED', 'ACTIVE', 'MISSED'].includes(it.status)) continue;
      seen.add(it.id);
      const what = this.planWhat(it) + ' ' + dayLabel(it.day);
      if (it.stage === 'UNCONFIRMED' || it.status === 'MISSED')
        push({
          id: 'NOT_CONFIRMED:' + it.id + ':' + (it.unconfirmedAt ?? it.missedAt ?? it.day),
          kind: 'NOT_CONFIRMED',
          words: what + ': ' + (it.why ?? 'not confirmed'),
          action: {
            label: it.type === 'TRUCK' || it.type === 'MATERIALS' ? 'Confirm or move' : 'Mark done or move',
            view: 'TODAY',
            day: it.day,
            item: it.id,
          },
          since: it.unconfirmedAt ?? it.missedAt ?? it.day,
          item: it.id,
        });
      else if (it.day > tomorrow) continue;
      else if (/^Not asked in time/.test(it.problem ?? ''))
        push({
          id: 'NOT_ASKED:' + it.id + ':' + (it.notAsked ?? it.day),
          kind: 'NOT_ASKED',
          words: what + ': ' + it.problem,
          action: { label: 'Call them', view: 'TODAY', day: it.day, item: it.id },
          since: it.notAsked ?? it.day,
          item: it.id,
        });
      else if (/can't make it/.test(it.problem ?? ''))
        push({
          id: 'CANT_MAKE_IT:' + it.id + ':' + (it.heard ?? it.day),
          kind: 'CANT_MAKE_IT',
          words: what + ': ' + it.problem,
          action: { label: 'Ask someone else', view: 'TODAY', day: it.day, item: it.id },
          since: it.updatedAt ?? it.day,
          item: it.id,
        });
      else if (/^No answer yet/.test(it.problem ?? ''))
        push({
          id: 'NO_ANSWER:' + it.id + ':' + (it.message ?? it.day),
          kind: 'NO_ANSWER',
          words: what + ': ' + it.problem,
          action: { label: 'Call them', view: 'TODAY', day: it.day, item: it.id },
          since: it.updatedAt ?? it.day,
          item: it.id,
        });
    }
    // part 5: a task the day ended on with nobody confirming it, and a rostered day tomorrow the person said no to (roster.js, tasks.js)
    if (typeof this.taskDayRows === 'function')
      for (const t of cached(
        this.db,
        "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind='workTask' AND json_extract(data,'$.status')='OPEN' AND json_type(data,'$.flag')='object' ORDER BY rowid",
      )
        .all(this.repo.company)
        .map((/** @type {any} */ r) => this.repo.decode(r)))
        push({
          id: 'TASK_NOT_DONE:' + t.id + ':' + t.flag.since,
          kind: 'TASK_NOT_DONE',
          words: t.name + ' ' + dayLabel(t.day) + ': ' + t.flag.words,
          action: { label: 'Open Task progress', view: 'PROGRESS', day: t.day, task: t.id },
          since: t.flag.since,
          item: t.id,
        });
    if (typeof this.rosterDayRows === 'function')
      for (const r of this.rosterDayRows(tomorrow))
        if (r.status === 'DENIED' && this.teamPerson(r.person))
          push({
            id: 'ROSTER_DENIED:' + r.id + ':' + (r.answeredAt ?? r.day),
            kind: 'ROSTER_DENIED',
            words: this.planName(r.person) + ' can’t work tomorrow. Roster someone else.',
            action: { label: 'Open Workers', view: 'WORKERS', person: r.person, day: r.day },
            since: r.answeredAt ?? r.day,
            item: r.id,
          });
    // paperwork expired or due for review
    const months = this.paperMonths?.();
    for (const p of this.repo.all('paperwork')) {
      if (p.archived) continue;
      const st = paperState(p, today, months);
      if (st.status !== 'EXPIRED') continue;
      push({
        id: 'PAPERWORK:' + p.id + ':' + st.status + ':' + (p.expiresOn ?? p.reviewedOn ?? ''),
        kind: 'PAPERWORK',
        words: p.title + (p.site ? ' · ' + this.planSiteName(p.site) : '') + ': ' + st.words,
        action: { label: st.review ? 'Mark reviewed' : 'Renew', view: 'TODAY', day: today, paperwork: p.id },
        since: today,
      });
    }
    // a product on hire with no rate
    try {
      for (const u of this.hire({}).unpriced ?? [])
        push({
          id: 'UNPRICED_ON_HIRE:' + (u.id ?? u.product),
          kind: 'UNPRICED_ON_HIRE',
          words:
            (u.name ?? this.planName(u.id ?? u.product, 'A part')) +
            ' is on hire with no rate' +
            (u.onHire ? ' (' + plural(u.onHire, 'piece') + ')' : ''),
          action: { label: 'Set a rate', view: 'HIRE', product: u.id ?? u.product },
          since: today,
        });
    } catch {}
    // one item per booking: the clock's own flag on a truck booking (can't make it, no answer, not asked) says it better than NO_DRIVER_YES
    const flagged = new Set(
      items
        .filter((x) => ['CANT_MAKE_IT', 'NO_ANSWER', 'NOT_ASKED', 'NOT_CONFIRMED'].includes(x.kind))
        .map((x) => x.item),
    );
    const dismissed = new Set(this.repo.all('needsDismissal').map((/** @type {any} */ d) => d.key));
    const live = items.filter((x) => !dismissed.has(x.id) && !(x.kind === 'NO_DRIVER_YES' && flagged.has(x.item)));
    live.sort(
      (a, b) =>
        a.rank - b.rank || String(a.since ?? '').localeCompare(String(b.since ?? '')) || a.id.localeCompare(b.id),
    );
    return {
      count: live.length,
      items: live.slice(0, NEEDS_CAP).map(({ rank, ...x }) => x),
      more: Math.max(0, live.length - NEEDS_CAP),
      cap: NEEDS_CAP,
      dismissed: dismissed.size,
    };
  },
  // Dismiss one item with a reason. It stays dismissed until its fact changes (a new id).
  needsYouDismiss(/** @type {any} */ input) {
    requireLive(this);
    const id = input?.id,
      reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
    requireRule(typeof id === 'string' && id.length > 0 && id.length <= 300, 'Choose what to dismiss.');
    requireRule(reason.length >= 2 && reason.length <= 200, 'Say why (a few words).');
    const had = this.repo.all('needsDismissal').find((/** @type {any} */ d) => d.key === id);
    if (!had)
      this.repo.add('needsDismissal', {
        key: id,
        reason,
        by: this.user.id,
        byName: this.user.name ?? 'Someone',
        at: new Date(this.planNow()).toISOString(),
      });
    return { ok: true, id, needsYou: this.needsYou(), message: 'Dismissed: ' + reason };
  },
};
