process.env.TZ = 'Australia/Sydney';
// The LIVE suite (ADR 0006): a real yard, driven only by people's commands and the business clock. Nothing here calls tick() to make
// anything happen; the engine is only called to prove it does nothing to a real yard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { atomic } from '../src/database.js';
import { Service } from '../src/service.js';
import { Simulation, tickCompany, startScheduler } from '../src/simulation.js';
import { clockRound } from '../src/domain/clock.js';
import { LIVE_OPS, COMING_NEXT } from '../src/domain/mode.js';
import { addDays } from '../src/domain/schedule.js';
import { liveFixture, records, D0 } from './helpers/live-fixture.js';
const D1 = addDays(D0, 1);
const person = () => ({
  name: 'Owner',
  email: randomUUID() + '@example.com',
  password: 'demonstration-password',
  systems: ['quickstage'],
});

test('every company is DEMO unless made LIVE; a mode never changes; the ledger of a real yard refuses engine rows', (t) => {
  const f = liveFixture(t, { setup: false });
  const mode = (id) => f.db.prepare('SELECT mode,time_zone FROM companies WHERE id=?').get(id);
  assert.deepEqual(
    { ...mode(f.owner.company_id) },
    { mode: 'DEMO', time_zone: 'Australia/Sydney' },
    'signed up: the Practice yard',
  );
  assert.deepEqual({ ...mode(f.company) }, { mode: 'LIVE', time_zone: 'Australia/Sydney' });
  assert.throws(() => f.db.prepare("UPDATE companies SET mode='DEMO' WHERE id=?").run(f.company), /mode never changes/);
  assert.throws(
    () => f.db.prepare("UPDATE companies SET mode='LIVE' WHERE id=?").run(f.owner.company_id),
    /mode never changes/,
    'no conversion of the Practice yard either',
  );
  f.db.prepare("UPDATE companies SET name='Renamed' WHERE id=?").run(f.company); // other changes are fine
  const engineRow = () =>
    f.db
      .prepare(
        "INSERT INTO ledger(id,company_id,actor,event,quantity,reason,command_key,created_at) VALUES(?,?,?,'PICKUP',1,'x','k',?)",
      )
      .run(randomUUID(), f.company, f.user.id, new Date().toISOString());
  assert.throws(engineRow, /records only what people did/, 'actor_kind defaults to ENGINE, refused in LIVE');
  const s = new Service(f.db);
  const live = s.authenticate(s.register({ ...person(), companyName: 'Signed up live', mode: 'LIVE' }));
  assert.equal(mode(live.company_id).mode, 'LIVE', 'a new company can sign up as a real yard');
  assert.throws(() => s.register({ ...person(), companyName: 'X', mode: 'SIM' }), /Practice yard or a real yard/);
  assert.throws(() => s.register({ ...person(), companyName: 'X', timeZone: 'Mars/Olympus' }), /valid time zone/);
});

test('only an owner (or the person who runs the server) starts a real yard; it starts empty, with the owner as its owner', (t) => {
  const f = liveFixture(t, { setup: false });
  const s = new Service(f.db);
  const invite = (roles) => {
    const made = s.invite(f.owner, { email: randomUUID() + '@example.com', roles });
    const token = s.acceptInvitation({ token: made.token, name: 'Staff', password: 'demonstration-password' });
    return s.authenticate(token);
  };
  for (const roles of [['GENERAL_MANAGER'], ['SUPERVISOR']])
    assert.throws(() => s.createLiveCompany(invite(roles), { name: 'Mine' }), /Only an owner/, roles[0]);
  assert.throws(() => s.createLiveCompany(f.owner, { name: '' }), /Company name is required/);
  // the server administrator, even when not an owner of the company they are in
  const other = s.authenticate(s.register({ ...person(), companyName: 'Second' }));
  const admin = s.authenticate(
    s.acceptInvitation({
      token: s.invite(other, { email: f.owner.email, roles: ['SUPERVISOR'] }).token,
      password: 'demonstration-password',
    }),
  );
  assert.equal(admin.id, f.owner.id);
  assert.ok(s.isAdmin(admin) && !s.permissions(admin).includes('company.manage'));
  // one real yard per owner: from another company, or from inside the real yard, a second one is refused (the admin path: live-fixes)
  assert.throws(
    () => s.createLiveCompany(admin, { name: 'Admin real yard' }),
    (e) => e.status === 409 && /You already have a real yard: Tee Scaffolding/.test(e.message),
  );
  assert.throws(() => s.createLiveCompany({ ...f.owner, company_id: f.company }, { name: 'Again' }), /already have/);
  // the new company: the owner is its OWNER, its systems are the ones it was made from, nothing else is in it
  const me = { ...f.owner, company_id: f.company };
  assert.deepEqual(s.snapshot(me).roles, ['OWNER']);
  assert.deepEqual(
    s
      .snapshot(me)
      .systems.filter((x) => x.enabled)
      .map((x) => x.id),
    ['quickstage'],
  );
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM objects WHERE company_id=?').get(f.company).n, 0, 'no records');
  const snap = s.snapshot(me);
  assert.equal(snap.company.mode, 'LIVE');
  assert.equal(snap.company.timeZone, 'Australia/Sydney');
  assert.deepEqual(
    snap.memberships.map((m) => m.name + ':' + m.mode),
    ['tee:DEMO', 'Tee Scaffolding:LIVE', 'Second:DEMO'],
    'oldest first, each with its mode',
  );
  assert.equal(snap.canStartLive, true);
});

test('a real yard starts with its yard only; its sites get no invented crane, crew or address; simulation commands are refused', (t) => {
  const f = liveFixture(t, { setup: false });
  f.cmd('gameStart', { size: 'M' });
  assert.deepEqual(
    ['resource', 'truck', 'driver'].map((k) => f.sim.repo.all(k).length),
    [0, 0, 0],
    'no crew, forklifts or trucks until the owner adds them',
  );
  const site = f.cmd('gameSite', { name: 'Bondi' }).site;
  assert.equal(site.address, null, 'never "Demonstration site"');
  assert.equal(site.mode, 'LIVE');
  assert.equal(f.sim.repo.all('resource').length, 0, 'no "Crane 1" and no two workers');
  const truck = f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.sim.repo.all('yard')[0].id });
  assert.equal(truck.mode, 'LIVE');
  assert.equal(f.sim.repo.all('config')[0].jobs, false);
  // everything that moves stock, drives, runs the crew or answers for people stays in the Practice yard
  for (const action of [
    'gameSend',
    'gameCollect',
    'gameStop',
    'gameKeepOpen',
    'seed',
    'teamStart',
    'teamNames',
    'planRestack',
    'planReplies',
    'pause',
    'resources',
    'workerCommand',
    'dispatch',
    'loadTruck',
    'unload',
    'request',
    'requestCollection',
    'createJob',
    'commitLayout',
    'purgeDemo',
  ]) {
    assert.ok(!LIVE_OPS.has(action), action);
    assert.throws(
      () => f.cmd(action, {}),
      (e) => e.status === 409 && e.message === COMING_NEXT,
      action,
    );
  }
  // the Practice yard is not touched by any of it
  const demo = new Simulation(f.db, f.owner);
  assert.equal(demo.live(), false);
  assert.equal(demo.repo.all('yard').length, 0);
});

test('record keeping works in a real yard, and every ledger row is a person: PERSON, or IMPORT for opening stock; never ENGINE', (t) => {
  const f = liveFixture(t);
  const c = f.cmd('container', {
    name: 'OPEN-1',
    location: f.yard.id,
    type: 'STILLAGE',
    length: 2000,
    width: 1000,
    height: 1000,
    tare: 50000,
    x: 1000,
    y: 1000,
  });
  f.cmd('opening', { container: c.id, product: f.product.id, quantity: 7, reason: 'Opening count' });
  f.cmd('removeStock', { container: c.id, product: f.product.id, quantity: 2, reason: 'Damaged, thrown out' });
  f.cmd('stockRemoval', { location: f.yard.id, product: f.product.id, quantity: 1, reason: 'Sold' });
  const count = f.cmd('count', { scope: c.id });
  f.cmd('observe', { id: count.id, observed: [4], reason: 'Counted on the day' });
  f.cmd('approveCount', { id: count.id });
  assert.equal(f.sim.repo.quantity(c.id, f.product.id), 4, 'the count wins');
  const rows = f.db
    .prepare(
      'SELECT event,actor,actor_kind,origin,occurred_at,created_at FROM ledger WHERE company_id=? ORDER BY sequence',
    )
    .all(f.company);
  assert.ok(rows.length > 10);
  assert.ok(rows.every((r) => r.actor === f.user.id && r.occurred_at === r.created_at && /^command:/.test(r.origin)));
  assert.deepEqual([...new Set(rows.map((r) => r.actor_kind))].sort(), ['IMPORT', 'PERSON']);
  assert.equal(rows.find((r) => r.event === 'OPENING_BALANCE').actor_kind, 'IMPORT');
  assert.equal(rows.find((r) => r.event === 'STOCKTAKE_ADJUSTMENT').actor_kind, 'PERSON');
  const snap = f.sim.snapshot(0, { lean: true });
  assert.equal(snap.companyMode, 'LIVE');
  assert.equal(snap.mode, 'LIVE');
});

test('the Practice yard keeps its simulated day and writes ENGINE rows from the engine, PERSON rows from people', (t) => {
  const f = liveFixture(t, { setup: false });
  const demo = new Simulation(f.db, f.owner),
    cmd = (a, i = {}) => demo.execute(a, i, randomUUID());
  const { yard } = cmd('gameStart', { size: 'S' });
  assert.equal(demo.repo.all('resource').length, 6, 'the starter crew and forklifts, as before');
  assert.equal(demo.repo.all('truck').length, 2);
  const site = cmd('gameSite', { name: 'Bondi' }).site;
  assert.equal(site.address, 'Demonstration site');
  cmd('gameCatalogue');
  const p = demo.repo
    .all('product')
    .map((x) => demo.effective(x.id))
    .find((x) => x.unitWeight > 0 && x.packQuantity == null);
  cmd('gameAddStock', { lines: [{ product: p.id, quantity: 10 }] });
  cmd('gameSend', { site: site.id, lines: [{ product: p.id, quantity: 10 }] });
  for (let i = 0; i < 400 && !demo.repo.all('delivery').some((d) => d.status === 'DELIVERED'); i++)
    atomic(f.db, () => demo.tick(1000));
  const kinds = f.db
    .prepare('SELECT actor_kind,COUNT(*) n FROM ledger WHERE company_id=? GROUP BY actor_kind')
    .all(f.owner.company_id);
  assert.ok(kinds.find((k) => k.actor_kind === 'ENGINE')?.n > 0, 'the simulated crane lifts are the engine');
  assert.ok(kinds.find((k) => k.actor_kind === 'PERSON')?.n > 0);
  assert.ok(yard);
});

test('the LIVE invariant: 10,000 engine rounds and 10,000 clock passes leave a real yard as it was, apart from messages and flags', (t) => {
  const f = liveFixture(t);
  f.cmd('planTruck', { day: D1, time: '07:00', truck: f.truck.id, driver: f.team.Dave.id });
  f.cmd('planWorkers', { day: D1, time: '07:00', site: f.site.id, count: 2 });
  f.cmd('planMaterials', { day: D1, time: '08:00', site: f.site.id, lines: [{ product: f.product.id, quantity: 10 }] });
  f.cmd('planWorkers', { day: addDays(D0, 2), time: '09:00', site: f.site.id, count: 1 });
  const before = records(f.db, f.company);
  // the engine, every way in: the scheduler's per-company step, a full tick and the quiet tick
  for (let i = 0; i < 10000; i++)
    atomic(f.db, () => {
      tickCompany(f.db, { company_id: f.company, id: f.user.id }, 250);
      f.sim.tick(250);
      f.sim.tickJobs(250);
    });
  assert.deepEqual(records(f.db, f.company), before, 'the engine did nothing');
  assert.equal(f.sim.repo.all('message').filter((m) => m.status === 'SENT').length, 1, 'only the ask sent at booking');
  // the clock, every 36 s for four days (10,000 passes)
  const start = Date.now();
  for (let i = 0; i < 10000; i++) {
    f.setTime(start + i * 36000);
    clockRound(f.db, Simulation, Date.now());
  }
  assert.deepEqual(records(f.db, f.company), before, 'the clock moved and completed nothing');
  const items = f.sim.repo.all('planItem'),
    msgs = f.sim.repo.all('message');
  assert.ok(
    items.every((i) => i.status !== 'DONE' && i.stage === 'UNCONFIRMED'),
    'every day ended not confirmed',
  );
  assert.ok(!items.some((i) => (i.log ?? []).some((l) => /Day done|Delivered|is at /.test(l.text))));
  assert.equal(msgs.filter((m) => m.status === 'SENT' || m.closedAt).length, msgs.length, 'every ask went out');
  assert.ok(!msgs.some((m) => m.answer), 'nobody answered by themselves');
  assert.ok(!f.sim.repo.all('resource').some((r) => r.away), 'nobody was moved to a site');
});

test('the scheduler never picks a real yard', async (t) => {
  const f = liveFixture(t);
  t.mock.timers.reset();
  const before = records(f.db, f.company);
  const stop = startScheduler(f.db);
  await new Promise((r) => setTimeout(r, 700));
  stop();
  assert.deepEqual(records(f.db, f.company), before);
});

test('Today in a real yard: asks go out, answers are recorded by the office, nothing is done by itself; cancel works', (t) => {
  const f = liveFixture(t);
  const truck = f.cmd('planTruck', { day: D1, time: '07:00', truck: f.truck.id, driver: f.team.Dave.id }).item;
  const ask = f.msgs(truck.id)[0];
  assert.equal(ask.status, 'SENT', 'the driver is asked at booking');
  assert.match(ask.text, /^Hi Dave, can you drive T-01/);
  // hours later, still no answer (no simulated reply): one reminder, then "no answer yet" once its time has come
  f.clock(D0, '12:00');
  f.pass();
  assert.equal(f.sim.repo.get(ask.id, 'message').status, 'SENT');
  assert.ok(f.sim.repo.get(ask.id, 'message').remindedAt, 'reminded once');
  f.clock(D0, '14:00');
  f.pass();
  assert.equal(f.sim.repo.all('notification').filter((n) => n.title === 'Reminder sent').length, 1, 'only once');
  f.cmd('messageAnswer', { id: ask.id, yes: true });
  assert.equal(f.sim.repo.get(ask.id, 'message').answer.via, 'OFFICE');
  assert.equal(f.item(truck.id).stage, 'READY');
  f.clock(D1, '07:30');
  f.pass();
  assert.equal(f.item(truck.id).status, 'ACTIVE');
  assert.equal(f.sim.repo.get(f.truck.id, 'truck').status, 'AT_YARD', 'the truck never leaves by itself');
  f.clock(D1, '17:00');
  f.pass();
  const done = f.item(truck.id);
  assert.equal(done.stage, 'UNCONFIRMED');
  assert.equal(
    done.problem,
    'Not confirmed: nobody recorded that it went. Nothing is marked done until someone confirms it.',
  );
  const w = f.cmd('planWorkers', { day: addDays(D0, 3), time: '07:00', site: f.site.id, count: 1 }).item;
  f.cmd('planCancel', { id: w.id });
  assert.equal(f.item(w.id).status, 'CANCELLED');
  assert.throws(
    () => f.cmd('planRestack', { day: D1 }),
    (e) => e.status === 409,
  );
});
