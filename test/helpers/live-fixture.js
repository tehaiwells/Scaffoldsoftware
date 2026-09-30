// A real yard (LIVE company) for the LIVE suite (ADR 0006): made the way the owner makes it (his Practice yard first, then "Start your real
// yard"), set up with the board's own commands, and driven only by commands and the business clock. It never calls tick() or the engine.
// No tests of its own. The caller sets process.env.TZ before importing anything when it cares which zone the server runs in.
import { randomUUID } from 'node:crypto';
import { openDatabase, atomic } from '../../src/database.js';
import { Service } from '../../src/service.js';
import { Simulation } from '../../src/simulation.js';
import { zoneAt } from '../../src/domain/zonetime.js';
import { gpPerStillage } from '../../public/game-pick.js';
export const D0 = '2026-10-13'; // a Tuesday
const mocked = new WeakSet();
export function liveFixture(t, { zone = 'Australia/Sydney', now = zoneAt(D0, '09:00', zone), setup = true } = {}) {
  if (mocked.has(t)) t.mock.timers.setTime(now);
  else {
    t.mock.timers.enable({ apis: ['Date'], now });
    mocked.add(t);
  }
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const auth = new Service(db);
  const owner = auth.authenticate(
    auth.register({
      name: 'Tee',
      companyName: 'tee',
      email: randomUUID() + '@example.com',
      password: 'demonstration-password',
      systems: ['quickstage'],
    }),
  );
  const made = auth.createLiveCompany(owner, { name: 'Tee Scaffolding', timeZone: zone });
  const user = { ...owner, company_id: made.id };
  const sim = new Simulation(db, user);
  const cmd = (action, input = {}, key = randomUUID()) => sim.execute(action, input, key);
  const at = (day, hm) => zoneAt(day, hm, zone);
  const clock = (day, hm) => t.mock.timers.setTime(at(day, hm)),
    setTime = (ms) => t.mock.timers.setTime(ms);
  // one pass of the business clock at the (mocked) time, in its own transaction as the timer runs it
  const pass = () => atomic(db, () => sim.clockPass(sim.planNow()));
  const item = (id) => sim.repo.get(id, 'planItem'),
    msgs = (id) => sim.repo.all('message').filter((m) => m.item === id);
  const f = { db, auth, owner, user, sim, cmd, zone, at, clock, setTime, pass, item, msgs, company: made.id };
  if (!setup) return f;
  const { yard } = cmd('gameStart', { size: 'S' });
  cmd('gameCatalogue');
  const lift = sim.gameLift(yard);
  const p = sim.repo
    .all('product')
    .map((x) => sim.effective(x.id))
    .filter((x) => x.packQuantity == null && x.unitWeight > 0 && gpPerStillage(x, lift) >= 10)
    .sort((a, b) => a.name.localeCompare(b.name))[0];
  const per = gpPerStillage(p, lift);
  cmd('gameAddStock', { lines: [{ product: p.id, quantity: per * 3 }] });
  const site = cmd('gameSite', { name: 'Bondi', address: '1 Campbell Parade, Bondi' }).site;
  const truck = cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: yard.id, payload: 12500000 });
  const team = {};
  for (const [name, role] of [
    ['Dave', 'DRIVER'],
    ['Kev', 'YARDSMAN'],
    ['Jo', 'SCAFFOLDER'],
    ['Sam', 'SCAFFOLDER'],
  ])
    team[name] = cmd('teamAdd', { name, role }).person;
  return Object.assign(f, { yard, product: p, per, site, truck, team });
}
// What the business clock may write on a booking (clock.js): its asks, flags, history and stage. Everything else on it must stay as booked.
const PLAN_FLAGS = [
  'version',
  'updatedAt',
  'problem',
  'log',
  'stage',
  'why',
  'unconfirmedAt',
  'notAsked',
  'heard',
  'message',
  'packer',
  'packMessage',
];
// Everything a real yard holds that is not a message, a notification or a flag on a booking: stock, stillages, trucks, people, sites, the
// bookings themselves (day, time, who and what; open or not), the ledger, the commands. The clock and the engine must leave all of it exactly
// as it was (the LIVE invariant): a clock that marked a booking DONE, moved someone or held stock would show here.
export function records(db, company) {
  const rows = (sql) => JSON.stringify(db.prepare(sql).all(company));
  const plan = db
    .prepare("SELECT id,data FROM objects WHERE company_id=? AND kind='planItem' ORDER BY id")
    .all(company)
    .map((r) => {
      const d = JSON.parse(r.data);
      for (const k of PLAN_FLAGS) delete d[k];
      d.status = ['PLANNED', 'ACTIVE'].includes(d.status) ? 'OPEN' : d.status; // under way is a label; DONE or CANCELLED is not
      if (Array.isArray(d.people)) d.people = d.people.map(({ message, notAsked, ...p }) => p);
      return [r.id, d];
    });
  return {
    plan: JSON.stringify(plan),
    objects: rows(
      "SELECT id,kind,data,version FROM objects WHERE company_id=? AND kind NOT IN ('message','notification','planItem','clockState') ORDER BY id",
    ),
    contents: rows('SELECT * FROM contents WHERE company_id=? ORDER BY container_id,product_id'),
    ledger: rows('SELECT * FROM ledger WHERE company_id=? ORDER BY sequence'),
    commands: rows('SELECT * FROM commands WHERE company_id=? ORDER BY key'),
  };
}
