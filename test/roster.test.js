process.env.TZ = 'Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { planFixture, D0, L } from './helpers/plan-fixture.js';
import { addDays, weekdayOf } from '../src/domain/schedule.js';
import { planSimAnswer } from '../src/domain/plantime.js';
import { ROSTER_AHEAD } from '../src/domain/roster.js';
// Part 5 (owner brief 30 September 2026), the Practice yard: +1 worker, the roster calendar, the fortnight rule, the day-before ask and its
// simulated answer, the fire rule. The DEMO suite ticks and passes (plan-fixture); a real yard's rules are in live-roster-tasks.test.js.
const D1 = addDays(D0, 1);
const rows = (f, id) => f.sim.repo.all('rosterDay').filter((r) => r.person === id);
const asks = (f, id) => f.sim.repo.all('message').filter((m) => m.person === id && m.subject === 'ROSTER');

test('+1 worker: name, job (yard or onsite), where, phone and email are saved; job sets the role; the words when something is wrong', (t) => {
  const f = planFixture(t);
  const site = f.site('Bondi');
  const kev = f.cmd('teamAdd', { name: 'Kevin', job: 'YARD', mobile: '0412 000 111', email: 'Kev@Example.com' });
  assert.equal(kev.message, 'Kevin is in your team as a yard worker.');
  assert.deepEqual(
    [
      kev.person.role,
      kev.person.job,
      kev.person.jobWords,
      kev.person.email,
      kev.person.mobileWords,
      kev.person.whereId,
    ],
    ['YARDSMAN', 'YARD', 'Yard worker', 'kev@example.com', '0412 000 111', f.yard.id],
  );
  const jo = f.cmd('teamAdd', { name: 'Joanne', job: 'ONSITE', where: site.id });
  assert.equal(jo.message, 'Joanne is in your team as an onsite worker at Bondi.');
  assert.deepEqual(
    [jo.person.role, jo.person.job, jo.person.whereId, jo.person.where],
    ['SCAFFOLDER', 'ONSITE', site.id, 'Bondi'],
  );
  assert.equal(f.sim.repo.get(jo.person.id).location, site.id, 'stands with the site crew');
  assert.throws(() => f.cmd('teamAdd', { name: 'X', job: 'BOSS' }), /Choose Yard worker or Onsite worker\./);
  assert.throws(
    () => f.cmd('teamAdd', { name: 'X', job: 'YARD', email: 'not-an-email' }),
    /Enter an email like name@example\.com\./,
  );
  assert.throws(() => f.cmd('teamAdd', { name: 'X', job: 'YARD', where: 'nowhere' }), /Choose the yard or a site\./);
  // the old form still works (a leading hand or a driver), and update takes the new fields
  const lee = f.cmd('teamAdd', { name: 'Lee', role: 'LEADING_HAND' }).person;
  assert.equal(lee.job, 'ONSITE');
  const u = f.cmd('teamUpdate', { id: kev.person.id, email: 'kev2@example.com', job: 'ONSITE', where: site.id });
  assert.deepEqual([u.person.email, u.person.role, u.person.whereId], ['kev2@example.com', 'SCAFFOLDER', site.id]);
  const team = f.sim.teamView({ roster: true });
  assert.ok(team.jobs.length === 2 && team.places.some((p) => p.kind === 'site' && p.name === 'Bondi'));
  assert.ok(
    team.people.find((p) => p.name === 'Kevin').roster,
    'with ?roster=1 each worker carries the next fortnight',
  );
  assert.equal(f.sim.teamView().people.find((p) => p.name === 'Kevin').roster, undefined, 'the plain call stays cheap');
});

test('picking days: rostered at once, cleared with a second tap, never a day that has gone; the calendar view says each status', (t) => {
  const f = planFixture(t);
  const kev = f.cmd('teamAdd', { name: 'Kevin', job: 'YARD' }).person;
  const days = [D1, addDays(D0, 2), addDays(D0, 3)];
  const r = f.cmd('rosterPick', { person: kev.id, days });
  assert.equal(r.message, 'Kevin rostered on 3 days.');
  assert.deepEqual(
    r.next14.map((d) => [d.day, d.status]),
    days.map((d) => [d, 'ROSTERED']),
  );
  assert.throws(() => f.cmd('rosterPick', { person: kev.id, days: [addDays(D0, -1)] }), /That day has gone\./);
  assert.throws(() => f.cmd('rosterPick', { person: kev.id, days: [] }), /Tap the days on the calendar\./);
  assert.equal(f.cmd('rosterPick', { person: kev.id, days: [D1] }).message, 'Kevin was already on those days.');
  const c = f.cmd('rosterClear', { person: kev.id, days: [addDays(D0, 2)] });
  assert.equal(c.message, 'Kevin taken off 1 day.');
  assert.equal(f.sim.rosterOf(kev.id, addDays(D0, 2)).status, 'REMOVED');
  const v = f.sim.rosterView({ person: kev.id, from: D0, to: addDays(D0, 6) });
  assert.deepEqual(
    v.days.map((d) => [d.day, d.status, d.statusWords]),
    [
      [D1, 'ROSTERED', 'Rostered'],
      [addDays(D0, 2), 'REMOVED', 'Off'],
      [addDays(D0, 3), 'ROSTERED', 'Rostered'],
    ],
  );
  assert.equal(v.days[0].whereName, 'Main yard');
  assert.equal(v.days[0].timeWords, '7:00 am');
  assert.ok(v.places.some((p) => p.kind === 'yard'));
  // picked again: a fresh rostered day
  f.cmd('rosterPick', { person: kev.id, days: [addDays(D0, 2)], time: '08:00' });
  assert.deepEqual(
    [f.sim.rosterOf(kev.id, addDays(D0, 2)).status, f.sim.rosterOf(kev.id, addDays(D0, 2)).time],
    ['ROSTERED', '08:00'],
  );
  const byDay = f.sim.rosterView({ day: D1 });
  assert.deepEqual(
    byDay.people.map((p) => p.name),
    ['Kevin'],
  );
  assert.throws(() => f.cmd('rosterView'), /Unknown command/);
});

test('the fortnight rule: a Mon–Fri pattern fills the next 14 days only; each day the clock adds one more; a removed day is never refilled; a picked day is not duplicated; ending the pattern clears only its own future days', (t) => {
  const f = planFixture(t);
  const kev = f.cmd('teamAdd', { name: 'Kevin', job: 'YARD' }).person;
  f.cmd('rosterPick', { person: kev.id, days: [addDays(D0, 3)] }); // a picked day inside the window
  f.cmd('rosterClear', { person: kev.id, days: [addDays(D0, 3)] });
  f.cmd('rosterPick', { person: kev.id, days: [addDays(D0, 4)] });
  const r = f.cmd('rosterPattern', { person: kev.id, kind: 'MON_FRI' });
  assert.match(r.message, /Kevin is on Mon–Fri: 9 days rostered, 14 days ahead at most\./);
  const expected = [];
  for (let d = 1; d <= ROSTER_AHEAD; d++) if (weekdayOf(addDays(D0, d)) <= 4) expected.push(addDays(D0, d));
  const on = () =>
    rows(f, kev.id)
      .filter((x) => x.status !== 'REMOVED')
      .map((x) => x.day)
      .sort();
  assert.deepEqual(
    on(),
    [...expected.filter((d) => d !== addDays(D0, 3)), addDays(D0, 4)].sort(),
    'the removed day stays removed, the picked Saturday stays and is not doubled',
  );
  assert.equal(rows(f, kev.id).filter((x) => x.day === addDays(D0, 4)).length, 1);
  assert.equal(rows(f, kev.id).find((x) => x.day === addDays(D0, 4)).source, 'PICKED', 'PICKED wins over PATTERN');
  assert.ok(!rows(f, kev.id).some((x) => x.day === D0), 'today is never filled by a pattern');
  assert.ok(!rows(f, kev.id).some((x) => x.day > addDays(D0, 14)), 'never further than a fortnight');
  // 100 passes the same day: nothing more
  const before = JSON.stringify(rows(f, kev.id));
  for (let i = 0; i < 100; i++) f.pass();
  assert.equal(JSON.stringify(rows(f, kev.id)), before);
  // the next day: one more day at the far end (D0+15 is a Wednesday)
  f.clock(D1, '06:00');
  f.pass();
  assert.deepEqual(
    rows(f, kev.id)
      .filter((x) => x.day > addDays(D0, 14))
      .map((x) => [x.day, x.source, x.createdBy]),
    [[addDays(D0, 15), 'PATTERN', 'clock']],
  );
  f.clock(addDays(D0, 5), '06:00'); // a Sunday: the window reaches the Friday after next, no weekend days
  f.pass();
  assert.ok(!rows(f, kev.id).some((x) => weekdayOf(x.day) > 4 && x.source === 'PATTERN'));
  const end = f.cmd('rosterPatternEnd', { person: kev.id });
  assert.match(end.message, /Pattern stopped for Kevin: \d+ days ahead cleared\./);
  const left = rows(f, kev.id).filter((x) => x.status !== 'REMOVED' && x.day > addDays(D0, 5));
  assert.deepEqual(
    left.map((x) => [x.day, x.source]),
    [[addDays(D0, 4), 'PICKED']].filter(([d]) => d > addDays(D0, 5)),
    'picked days stay',
  );
  assert.equal(f.sim.rosterPatternOf(kev.id), null);
  // Mon–Sat includes Saturdays
  f.cmd('rosterPattern', { person: kev.id, kind: 'MON_SAT', time: '06:30' });
  assert.ok(rows(f, kev.id).some((x) => weekdayOf(x.day) === 5 && x.status === 'ROSTERED' && x.time === '06:30'));
  assert.throws(() => f.cmd('rosterPattern', { person: kev.id, kind: 'WEEKENDS' }), /Choose Mon–Fri or Mon–Sat\./);
});

test('the day-before ask: at 3 pm for tomorrow, at once when picked later, never once the day has begun; the simulated answer confirms or denies the day at once', (t) => {
  const f = planFixture(t);
  const kev = f.cmd('teamAdd', { name: 'Kevin', job: 'YARD' }).person,
    jo = f.cmd('teamAdd', { name: 'Joanne', job: 'ONSITE' }).person;
  f.cmd('rosterPick', { person: kev.id, days: [D1, addDays(D0, 2)] });
  f.clock(D0, '14:59');
  f.pass();
  assert.equal(asks(f, kev.id).length, 0, 'not before 3 pm');
  f.clock(D0, '15:00');
  f.pass();
  const [m] = asks(f, kev.id);
  assert.equal(asks(f, kev.id).length, 1, 'one ask, for tomorrow only');
  assert.deepEqual(
    [m.status, m.day, m.time, m.needsAnswer, m.itemType, m.item, m.about.kind],
    ['SENT', D1, '07:00', true, 'ROSTER', null, 'rosterDay'],
  );
  assert.equal(
    m.text,
    "Hi Kevin, you're on tomorrow (Wed 14 Oct) at Main yard from 7:00 am. Please reply Confirm or Deny. – Tee Scaffolding",
  );
  assert.equal(f.sim.rosterOf(kev.id, D1).message, m.id);
  assert.ok(f.sim.repo.all('notification').some((n) => n.body === 'Asked Kevin about Wed 14 Oct (Main yard).'));
  // picked after 3 pm: asked at once
  f.clock(D0, '16:00');
  f.cmd('rosterPick', { person: jo.id, days: [D1] });
  assert.equal(asks(f, jo.id).length, 1);
  // the simulated reply (the Practice yard only): the day becomes CONFIRMED or DENIED at the fixed delay
  const s = planSimAnswer(m);
  f.at(L(D0, '15:00') + s.delaySec * 1000 - 1000);
  f.pass();
  assert.equal(f.sim.rosterOf(kev.id, D1).status, 'ROSTERED');
  f.at(L(D0, '15:00') + s.delaySec * 1000);
  f.pass();
  assert.equal(f.sim.rosterOf(kev.id, D1).status, s.yes ? 'CONFIRMED' : 'DENIED');
  assert.equal(f.sim.rosterOf(kev.id, D1).answer.via, 'SIMULATED');
  const v = f.sim.rosterView({ person: kev.id, from: D1, to: D1 }).days[0];
  assert.equal(v.answer, s.yes ? 'YES' : 'NO');
  // the office answering for someone: ON_BEHALF, and the day follows at once
  const jm = asks(f, jo.id)[0];
  const ans = f.cmd('messageAnswer', { id: jm.id, yes: false, reason: 'Crook' });
  assert.equal(ans.message, 'Got it. The office will sort it.');
  assert.deepEqual([ans.rosterDay.status, ans.rosterDay.reason], ['DENIED', 'Crook']);
  assert.ok(
    f.sim.repo
      .all('notification')
      .some((n) => n.title === 'Can’t work' && /Joanne can’t work on Wed 14 Oct: Crook/.test(n.body)),
  );
  // a denied day picked again asks again (attempt 2) while the day has not begun
  f.cmd('rosterPick', { person: jo.id, days: [D1] });
  assert.equal(asks(f, jo.id).length, 2);
  assert.equal(asks(f, jo.id)[1].attempt, 2);
  assert.equal(f.sim.rosterOf(jo.id, D1).status, 'ROSTERED');
  // too late: the day has begun and nobody was asked (the app was closed from 3 pm): flagged, never sent
  const sam = f.cmd('teamAdd', { name: 'Samuel', job: 'ONSITE' }).person;
  f.clock(D0, '10:00');
  f.cmd('rosterPick', { person: sam.id, days: [D1] });
  f.clock(D1, '06:30');
  f.pass();
  assert.equal(asks(f, sam.id).length, 0);
  assert.ok(f.sim.rosterOf(sam.id, D1).notAsked);
  assert.ok(f.sim.repo.all('notification').some((n) => n.body === "Samuel wasn't asked about today. Call them."));
  assert.equal(f.sim.rosterView({ person: sam.id, from: D1, to: D1 }).days[0].answer, 'NOT_ASKED');
  // a day picked for today after it began is simply not asked, and not flagged
  f.cmd('rosterPick', { person: kev.id, days: [addDays(D1, 0)] });
  f.pass();
  assert.equal(f.sim.repo.all('notification').filter((n) => /Kevin wasn't asked/.test(n.body)).length, 0);
});

test('fired: the next fortnight of rostered days goes, the pattern ends, open asks are called off, today stays', (t) => {
  const f = planFixture(t);
  const kev = f.cmd('teamAdd', { name: 'Kevin', job: 'YARD' }).person;
  f.cmd('rosterPattern', { person: kev.id, kind: 'MON_SAT' });
  f.cmd('rosterPick', { person: kev.id, days: [D0, addDays(D0, 20)] });
  f.clock(D0, '15:00');
  f.pass();
  assert.equal(asks(f, kev.id).length, 1);
  f.cmd('teamRemove', { id: kev.id });
  const all = rows(f, kev.id);
  assert.equal(all.find((x) => x.day === D0).status, 'ROSTERED', "today's row stays: they may already be at work");
  assert.ok(all.filter((x) => x.day > D0).every((x) => x.status === 'REMOVED' && x.removedWhy === 'left the team'));
  assert.equal(asks(f, kev.id)[0].status, 'CALLED_OFF');
  assert.equal(f.sim.rosterPatternOf(kev.id), null);
  f.clock(D1, '06:00');
  f.pass();
  assert.ok(
    !rows(f, kev.id).some((x) => x.day > addDays(D0, 14) && x.status !== 'REMOVED'),
    'the clock fills nothing for someone gone',
  );
});

test('the phone view of a worker in the Practice yard carries their roster and their day; a message about a roster day answers through messageAnswer only', (t) => {
  const f = planFixture(t);
  const kev = f.cmd('teamAdd', { name: 'Kevin', job: 'YARD' }).person;
  f.cmd('rosterPick', { person: kev.id, days: [D0, D1] });
  f.clock(D0, '15:00');
  f.pass();
  const pv = f.sim.personView('worker', kev.id);
  assert.deepEqual(
    [pv.roster.today.status, pv.roster.tomorrow.status, pv.roster.tomorrow.answer],
    ['ROSTERED', 'ROSTERED', 'WAITING'],
  );
  assert.deepEqual(pv.myDay, { today: D0, tasks: [], tomorrow: [] });
  const m = asks(f, kev.id)[0];
  assert.throws(() => f.cmd('messageSeen', { id: m.id }), /Answer this one with the two buttons\./);
  const r = f.sim.execute('messageAnswer', { id: m.id, yes: true, via: 'PHONE_VIEW' }, randomUUID());
  assert.equal(r.message, 'Thanks. See you then.');
  assert.equal(f.sim.rosterOf(kev.id, D1).status, 'CONFIRMED');
  assert.equal(f.sim.rosterOf(kev.id, D1).answer.via, 'PHONE_VIEW');
  // the crew-day view (the office's phone page) has the same
  const cd = f.sim.crewDay(kev.id);
  assert.equal(cd.roster.tomorrow.status, 'CONFIRMED');
});
