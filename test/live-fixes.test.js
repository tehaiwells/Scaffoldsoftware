process.env.TZ = 'Australia/Sydney'; // the server's zone; the Perth company below keeps its own
// The real yard after its first review (Phase 1A part 1 fixes): Today and the phone view on company time, one real yard per owner, Remove
// site for a site with nothing recorded, people only by name, answers recorded for someone (ON_BEHALF), moving a day that ended "Not
// confirmed", and a clock that flags rather than ends. LIVE only: nothing here calls tick().
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { Service } from '../src/service.js';
import { atLocal } from '../src/domain/plantime.js';
import { addDays } from '../src/domain/schedule.js';
import { COMING_NEXT } from '../src/domain/mode.js';
import { liveFixture, records, D0 } from './helpers/live-fixture.js';
const D1 = addDays(D0, 1);
const person = () => ({
  name: 'Owner',
  email: randomUUID() + '@example.com',
  password: 'demonstration-password',
  systems: ['quickstage'],
});

test('Perth on a Sydney server: Today, the month, the phone view and "no answer" all agree with the business clock', (t) => {
  const f = liveFixture(t, { zone: 'Australia/Perth' });
  const truck = f.cmd('planTruck', { day: D1, time: '07:00', truck: f.truck.id, driver: f.team.Dave.id }).item;
  const ask = f.msgs(truck.id)[0];
  // 7:30 am in Sydney is 4:30 am in Perth: the 7 am Perth truck is still ahead, so Dave can still answer and nobody says "no answer"
  f.setTime(atLocal(D1, '07:30'));
  const view = f.sim.planMsgView(f.sim.repo.get(ask.id, 'message'), Date.now());
  assert.equal(view.canAnswer, true, 'the phone view is open until 7 am Perth');
  const today = f.sim.todayView();
  assert.equal(today.today, D1);
  const dave = today.roster.driving.find((x) => x.id === f.team.Dave.id);
  assert.equal(dave.answer, 'WAITING', 'not "no answer" before its time in Perth');
  f.pass();
  assert.ok(!/No answer yet/.test(f.item(truck.id).problem ?? ''), 'the clock agrees');
  // at 7:30 am Perth (10:30 am Sydney) the time has passed: all three say so together
  f.setTime(atLocal(D1, '10:30'));
  assert.equal(f.sim.planMsgView(f.sim.repo.get(ask.id, 'message'), Date.now()).canAnswer, false);
  assert.equal(f.sim.todayView().roster.driving.find((x) => x.id === f.team.Dave.id).answer, 'NO_ANSWER');
  f.pass();
  assert.match(f.item(truck.id).problem, /No answer yet from Dave/);
  assert.throws(
    () => f.cmd('messageAnswer', { id: ask.id, yes: true, via: 'PHONE_VIEW' }),
    /Too late to answer/,
    'the command agrees too',
  );
  // 1:30 am in Sydney is 10:30 pm the day before in Perth: Today, the month and the snapshot's calendar are still on Perth's day
  f.setTime(atLocal(D1, '01:30'));
  const v = f.sim.todayView(),
    month = f.sim.planMonth(D0.slice(0, 7));
  assert.equal(v.today, D0);
  assert.equal(month.today, D0);
  assert.equal(month.timeZone, 'Australia/Perth');
  assert.equal(f.sim.snapshot(0, { lean: true }).calendar.today, D0);
  assert.equal(f.sim.calendar().timeZone, 'Australia/Perth');
});

test('one real yard per owner; the person who runs the server may start one from a company they do not own', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const s = new Service(db);
  const admin = s.authenticate(s.register({ ...person(), companyName: 'First on this server' }));
  const other = s.authenticate(s.register({ ...person(), companyName: 'Someone else' }));
  const inOther = s.authenticate(
    s.acceptInvitation({
      token: s.invite(other, { email: admin.email, roles: ['SUPERVISOR'] }).token,
      password: 'demonstration-password',
    }),
  );
  assert.ok(s.isAdmin(inOther) && !s.permissions(inOther).includes('company.manage'));
  const made = s.createLiveCompany(inOther, { name: 'Admin real yard' });
  assert.equal(made.mode, 'LIVE');
  assert.throws(
    () => s.createLiveCompany(admin, { name: 'Another' }),
    (e) => e.status === 409 && /already have a real yard: Admin real yard/.test(e.message),
    'a double tap or a retry never makes a second real yard',
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM companies WHERE mode='LIVE'").get().n, 1);
  // another owner still starts their own
  assert.equal(s.createLiveCompany(other, { name: 'Their real yard' }).mode, 'LIVE');
});

test('Remove site in a real yard: a site with nothing recorded goes (with Undo); one with scaffolding recorded is refused in plain words', (t) => {
  const f = liveFixture(t);
  const typo = f.cmd('gameSite', { name: 'Bondii' }).site;
  const r = f.cmd('gameRemoveSite', { site: typo.id });
  assert.equal(r.removed, true);
  // a real yard never deletes a site (retention, ADR 0011): it is archived with its history, off the map, and Undo opens it again
  const kept = f.sim.repo.get(typo.id, 'site');
  assert.equal(kept.status, 'ARCHIVED', 'kept, off the map');
  assert.equal(kept.neverUsed, true);
  assert.ok(!f.sim.snapshot().sites.some((x) => x.id === typo.id && x.status === 'ACTIVE'), 'gone from the map');
  f.cmd('gameRestoreSite', { undo: r.undo });
  assert.equal(f.sim.repo.get(typo.id, 'site').status, 'ACTIVE', 'Undo puts it back');
  assert.equal(f.sim.repo.all('resource').filter((x) => x.location === typo.id).length, 0, 'no invented crane or crew');
  // scaffolding recorded at a site: it would need the simulated crew to bring it back
  const c = f.cmd('container', {
    name: 'AT-SITE-1',
    location: f.site.id,
    type: 'STILLAGE',
    length: 2000,
    width: 1000,
    height: 1000,
    tare: 50000,
    x: 5000,
    y: 5000,
  });
  f.cmd('opening', { container: c.id, product: f.product.id, quantity: 5, reason: 'Opening count at the site' });
  assert.throws(
    () => f.cmd('gameRemoveSite', { site: f.site.id, bringBack: true }),
    (e) => e.status === 409 && e.message !== COMING_NEXT,
  );
  assert.equal(f.sim.repo.get(f.site.id, 'site').status, 'ACTIVE');
  assert.ok(!f.sim.repo.get(f.site.id, 'site').finishing, 'nothing starts bringing it back');
  assert.ok(!f.sim.repo.all('collection').length && !f.sim.repo.all('gameOrder').length);
  // a used site with nothing left there is archived, and opens again without an invented crew
  const used = f.cmd('gameSite', { name: 'Coogee' }).site;
  f.cmd('planWorkers', { day: D1, time: '07:00', site: used.id, count: 1 });
  const gone = f.cmd('gameRemoveSite', { site: used.id });
  assert.ok(gone.archived || gone.removed);
  if (gone.archived) {
    f.cmd('gameReopen', { site: used.id });
    assert.equal(f.sim.repo.all('resource').filter((x) => x.location === used.id).length, 0);
  }
});

test('people in a real yard are added by name: +1 worker is refused; forklifts, trucks and stillages are records', (t) => {
  const f = liveFixture(t);
  assert.throws(
    () => f.cmd('quickAdjust', { kind: 'WORKER', delta: 1, location: f.yard.id }),
    /Add people by name on Workers, Your team/,
  );
  assert.ok(!f.sim.repo.all('resource').some((r) => /^Worker \d/.test(r.name)), 'no anonymous "Worker 1"');
  const fork = f.cmd('quickAdjust', { kind: 'FORKLIFT', delta: 1, location: f.yard.id });
  assert.equal(fork.type, 'FORKLIFT');
});

test('an answer the office records for someone is ON_BEHALF of them, and the phone view in a real yard is stored as the office', (t) => {
  const f = liveFixture(t);
  const truck = f.cmd('planTruck', { day: D1, time: '07:00', truck: f.truck.id, driver: f.team.Dave.id }).item;
  const ask = f.msgs(truck.id)[0],
    key = randomUUID();
  f.cmd('messageAnswer', { id: ask.id, yes: true, via: 'PHONE_VIEW' }, key);
  const m = f.sim.repo.get(ask.id, 'message');
  assert.equal(m.answer.via, 'OFFICE', 'nobody signs in on their phone yet: the office recorded it');
  assert.equal(m.answer.by, f.user.id);
  const row = f.db
    .prepare('SELECT actor,actor_kind,on_behalf_of,origin FROM ledger WHERE company_id=? AND command_key=?')
    .get(f.company, key);
  assert.deepEqual(
    { ...row },
    {
      actor: f.user.id,
      actor_kind: 'ON_BEHALF',
      on_behalf_of: f.team.Dave.id,
      origin: 'command:messageAnswer',
    },
  );
  // the next command is the person's own again
  const k2 = randomUUID();
  f.cmd('teamAdd', { name: 'Mia', role: 'SCAFFOLDER' }, k2);
  assert.equal(
    f.db.prepare('SELECT actor_kind FROM ledger WHERE company_id=? AND command_key=?').get(f.company, k2).actor_kind,
    'PERSON',
  );
});

test('a day that ended "Not confirmed" moves to a new day and starts again: asked again, open, no stale flags', (t) => {
  const f = liveFixture(t);
  const truck = f.cmd('planTruck', { day: D1, time: '07:00', truck: f.truck.id, driver: f.team.Dave.id }).item;
  const workers = f.cmd('planWorkers', { day: D1, time: '07:00', site: f.site.id, count: 1 }).item;
  const list = f.cmd('planMaterials', {
    day: D1,
    time: '08:00',
    site: f.site.id,
    lines: [{ product: f.product.id, quantity: 10 }],
  }).item;
  f.clock(D1, '17:30');
  f.pass();
  for (const id of [truck.id, workers.id, list.id]) assert.equal(f.item(id).stage, 'UNCONFIRMED', id);
  const D3 = addDays(D0, 3);
  for (const id of [truck.id, workers.id, list.id]) {
    const r = f.cmd('planMove', { id, day: D3 });
    assert.equal(r.changed, true);
    const it = f.item(id);
    assert.equal(it.status, 'PLANNED', it.type);
    assert.ok(it.stage !== 'UNCONFIRMED' && !it.unconfirmedAt && !it.why && !it.problem, it.type);
  }
  assert.ok(!/Bring it back from the yard board/.test(JSON.stringify(f.item(list.id))));
  // the new day: Dave is asked again at once, the worker at 3 pm the day before, and nothing is done by itself
  assert.ok(
    f.msgs(truck.id).some((m) => m.status === 'SENT' && m.day === D3),
    'the driver is asked again',
  );
  f.clock(addDays(D3, -1), '15:00');
  f.pass();
  assert.ok(
    f.item(workers.id).people.every((p) => p.message),
    'asked again at 3 pm the day before',
  );
  assert.ok([truck.id, workers.id, list.id].every((id) => f.item(id).status !== 'DONE'));
  assert.throws(() => f.cmd('planMove', { id: list.id, day: D3 }) && f.cmd('planMove', { id: list.id, day: D1 }));
});

test('the clock flags a list whose site is gone and leaves it for the office to cancel; it never ends a booking itself', (t) => {
  const f = liveFixture(t);
  const list = f.cmd('planMaterials', {
    day: D1,
    time: '08:00',
    site: f.site.id,
    lines: [{ product: f.product.id, quantity: 10 }],
  }).item;
  // inconsistent data (normally Remove site cancels its lists first): the site is archived behind the planner's back
  const site = f.sim.repo.get(f.site.id, 'site');
  f.sim.repo.save({ ...site, status: 'ARCHIVED' });
  f.pass();
  const it = f.item(list.id);
  assert.ok(['PLANNED', 'ACTIVE'].includes(it.status), 'still open');
  assert.match(it.problem, /Bondi was removed\. Cancel this list\./);
  f.pass();
  assert.equal(f.item(list.id).log.filter((l) => /was removed/.test(l.text)).length, 1, 'said once');
  f.cmd('planCancel', { id: list.id });
  assert.equal(f.item(list.id).status, 'CANCELLED', 'the office cancels it');
});

test('catch-up after a whole day off: nobody was ever asked, so the day says "not asked in time", not "nobody said they were coming"', (t) => {
  const f = liveFixture(t);
  const w = f.cmd('planWorkers', { day: D1, time: '07:00', site: f.site.id, count: 2 }).item;
  const before = records(f.db, f.company);
  f.clock(D1, '18:00'); // off from 9 am the day before (before the 3 pm ask) until after 5 pm on the day
  f.pass();
  const it = f.item(w.id);
  assert.equal(it.stage, 'UNCONFIRMED');
  assert.match(it.problem, /^Not confirmed: not asked in time \(nobody got the ask\)\./);
  assert.ok(it.people.every((p) => p.notAsked && !p.message));
  assert.equal(f.msgs(w.id).length, 0, 'never sent late');
  assert.deepEqual(records(f.db, f.company), before, 'flags only');
});

test("Who's in today in a real yard: nobody is at the yard or idle; the team is listed by name as not booked", (t) => {
  const f = liveFixture(t);
  const v = f.sim.todayView();
  assert.deepEqual(v.roster.atYard, []);
  assert.deepEqual(v.roster.notBooked.map((x) => x.name).sort(), ['Dave', 'Jo', 'Kev', 'Sam']);
  assert.ok(v.roster.notBooked.every((x) => x.where === null));
});
