process.env.TZ = 'Australia/Sydney';
// Asked = sent = delivered (audit #3, ADR 0009): 1,000 random orders in a real yard, sends and bring-backs mixed, each booked on a truck and
// confirmed with the one-tap defaults. For every order: requested = held = loaded = delivered (or collected = returned). Throughout: no
// balance is ever negative, every piece is somewhere, and the ledger and the confirmations only grow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveFixture, D0 } from './helpers/live-fixture.js';
import { addDays } from '../src/domain/schedule.js';

// A small deterministic generator (mulberry32), so a failure can be replayed with its seed.
const rng = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

test('1,000 random orders: requested = held = loaded = delivered, exact pieces, nothing negative, nothing lost', (t) => {
  const seed = Number(process.env.PROPERTY_SEED ?? 20260930),
    rand = rng(seed),
    pick = (a) => a[Math.floor(rand() * a.length)],
    between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const f = liveFixture(t);
  const products = f.sim.repo
    .all('product')
    .map((x) => f.sim.effective(x.id))
    .filter((x) => x.unitWeight > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 4);
  for (const p of products) f.cmd('gameAddStock', { lines: [{ product: p.id, quantity: 400 }] });
  const sites = [f.site, f.cmd('gameSite', { name: 'Manly' }).site, f.cmd('gameSite', { name: 'Coogee' }).site];
  // two trucks, each with its own driver (a driver drives one truck a day)
  const trucks = [
    { truck: f.truck, driver: f.team.Dave },
    {
      truck: f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id }),
      driver: f.cmd('teamAdd', { name: 'Bill', role: 'DRIVER' }).person,
    },
  ];
  const total = new Map(products.map((p) => [p.id, 0]));
  for (const c of f.sim.containers())
    for (const p of products) total.set(p.id, total.get(p.id) + f.sim.repo.quantity(c.id, p.id));
  // free pieces now at a place (what an order can hold)
  const free = (loc) => new Map(f.sim.orderItems(loc).items.map((i) => [i.product, i.free]));
  let ledgerRows = 0,
    confirmed = 0,
    sends = 0,
    backs = 0;
  for (let n = 0; n < Number(process.env.PROPERTY_ORDERS ?? 1000); n++) {
    // a new working day every 8 orders, as a real yard's trucks do a handful of runs a day
    if (n % 8 === 0) f.clock(addDays(D0, n / 8), '09:00');
    const site = pick(sites);
    // a send while the yard has stock, a bring-back while the site has some (either way round when one side is empty)
    let back = rand() < 0.45,
      from = free(back ? site.id : f.yard.id),
      choices = products.filter((p) => (from.get(p.id) ?? 0) > 0);
    if (!choices.length) {
      back = !back;
      from = free(back ? site.id : f.yard.id);
      choices = products.filter((p) => (from.get(p.id) ?? 0) > 0);
    }
    assert.ok(choices.length, 'something to send or bring back at order ' + n + ' (seed ' + seed + ')');
    const lines = [];
    for (const p of choices)
      if (!lines.length || rand() < 0.35)
        lines.push({ product: p.id, quantity: between(1, Math.min(from.get(p.id), 60)) });
    const made = f.cmd(back ? 'bringBackCreate' : 'orderCreate', { site: site.id, lines }).order;
    for (const l of made.lines) assert.equal(l.held, l.requested, `order ${n}: held what it asked for (seed ${seed})`);
    const run = pick(trucks),
      trip = f.cmd('tripBook', { orders: [made.id], truck: run.truck.id, driver: run.driver.id }).trip;
    if (back) {
      f.cmd('tripCollected', { trip: trip.id });
      f.cmd('tripReturned', { trip: trip.id });
      backs++;
    } else {
      if (rand() < 0.3) f.cmd('packConfirmed', { trip: trip.id });
      f.cmd('tripLoaded', { trip: trip.id });
      f.cmd('tripDelivered', { trip: trip.id, receivedBy: 'Site ' + (n % 7) });
      sends++;
    }
    const o = f.sim.repo.get(made.id, 'order');
    for (const l of o.lines) {
      const asked = lines.find((x) => x.product === l.product).quantity;
      if (back)
        assert.deepEqual(
          [l.requested, l.collected, l.returned],
          [asked, asked, asked],
          `bring-back ${n} (seed ${seed})`,
        );
      else assert.deepEqual([l.requested, l.loaded, l.delivered], [asked, asked, asked], `order ${n} (seed ${seed})`);
    }
    assert.equal(o.status, back ? 'RETURNED' : 'DELIVERED');
    if (n % 50 === 49) {
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM contents WHERE quantity<0').get().n, 0);
      const rows = f.db.prepare('SELECT COUNT(*) n FROM ledger WHERE company_id=?').get(f.company).n,
        conf = f.db.prepare('SELECT COUNT(*) n FROM trip_confirmation WHERE company_id=?').get(f.company).n;
      assert.ok(rows > ledgerRows && conf > confirmed, 'append only: they only grow');
      ledgerRows = rows;
      confirmed = conf;
      for (const p of products) {
        let sum = 0,
          onTrucks = 0;
        for (const c of f.sim.containers()) {
          const q = f.sim.repo.quantity(c.id, p.id);
          sum += q;
          if (f.sim.repo.get(c.location).kind === 'truck') onTrucks += q;
        }
        assert.equal(sum, total.get(p.id), 'every piece is somewhere');
        assert.equal(onTrucks, 0, 'nothing left on a truck');
      }
    }
  }
  if (!process.env.PROPERTY_ORDERS) assert.ok(sends > 400 && backs > 250, sends + ' sends, ' + backs + ' bring-backs');
  // every movement row of the real yard is a person's, and every one of them is exact (never more than a container held)
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE company_id=? AND actor_kind='ENGINE'").get(f.company).n,
    0,
  );
  assert.equal(
    f.sim.repo.all('reservation').filter((r) => r.active && r.order).length,
    0,
    'every hold was used or let go',
  );
});
