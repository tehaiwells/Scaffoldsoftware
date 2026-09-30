process.env.TZ = 'Australia/Sydney';
// Back & counted with a resolution (ADR 0010, audit #4 and H3): count later and the clock's RETURN_SHORT flag; every missing piece ends
// in exactly one outcome; LOST is charged at the replacement value; DAMAGED goes to quarantine and is never picked; STILL_ON_SITE keeps
// hire going; the one site-finish question and 0 unaccounted at a closed site; one definition of "available"; intake costs; values are
// the owner's. Nothing here ticks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Simulation } from '../src/simulation.js';
import { LIVE_OPS } from '../src/domain/mode.js';
import { addDays } from '../src/domain/schedule.js';
import { availableOf } from '../src/domain/stock-math.js';
import { crewLink, crewClaim, crewAuthenticate } from '../src/crew-auth.js';
import { liveFixture, D0 } from './helpers/live-fixture.js';
const D1 = addDays(D0, 1);
function phone(f, person) {
  const made = crewLink(f.auth, f.user, { person: person.id });
  const claimed = crewClaim(f.auth, { token: made.token, label: 'Test phone' });
  const sim = new Simulation(f.db, crewAuthenticate(f.db, claimed.token));
  return { sim, cmd: (a, i = {}, key = randomUUID()) => sim.execute(a, i, key) };
}
// A general manager of the real yard (operations, no company.manage).
function manager(f) {
  const made = f.auth.invite(f.user, { email: randomUUID() + '@example.com', roles: ['GENERAL_MANAGER'] });
  const token = f.auth.acceptInvitation({ token: made.token, name: 'GM', password: 'demonstration-password' });
  const sim = new Simulation(f.db, f.auth.authenticate(token));
  return { sim, cmd: (a, i = {}, key = randomUUID()) => sim.execute(a, i, key) };
}
function where(f, product) {
  const out = { yard: 0, site: 0, truck: 0, quarantine: 0 };
  for (const c of f.sim.containers()) {
    const q = f.sim.repo.quantity(c.id, product);
    if (!q) continue;
    if (c.quarantine) out.quarantine += q;
    else out[f.sim.repo.get(c.location).kind] += q;
  }
  return out;
}
const ledger = (f, sql = '1=1') =>
  f.db.prepare(`SELECT * FROM ledger WHERE company_id=? AND ${sql} ORDER BY sequence`).all(f.company);
const charges = (f) => f.db.prepare('SELECT * FROM charge_lines WHERE company_id=? ORDER BY sequence').all(f.company);
// Deliver n pieces to the site on D0 and bring `back` of them on a collection trip: returns the collection trip (not yet Back at yard).
function outAndBack(f, n, back = n) {
  const o = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: n }] }).order;
  const out = f.cmd('tripBook', { orders: [o.id], truck: f.truck.id, driver: f.team.Dave.id }).trip;
  f.clock(D0, '09:30');
  f.cmd('tripLoaded', { trip: out.id });
  f.clock(D0, '10:00');
  f.cmd('tripDelivered', { trip: out.id, receivedBy: 'J. Smith' });
  f.cmd('tripReturned', { trip: out.id });
  const b = f.cmd('bringBackCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: back }] }).order;
  const coll = f.cmd('tripBook', { orders: [b.id], truck: f.truck.id, driver: f.team.Dave.id, time: '13:00' }).trip;
  f.clock(D0, '13:30');
  f.cmd('tripCollected', { trip: coll.id });
  return { out, coll, o, b };
}

test('the return commands are on the LIVE allow-list and refused in the Practice yard; charge lines are LIVE and append-only', (t) => {
  const f = liveFixture(t);
  for (const a of ['returnCount', 'returnResolve', 'quarantineResolve', 'siteFinish', 'productValue'])
    assert.ok(LIVE_OPS.has(a), a);
  const demo = new Simulation(f.db, f.owner);
  for (const a of ['returnCount', 'returnResolve', 'quarantineResolve', 'siteFinish'])
    assert.throws(
      () => demo.execute(a, { trip: 'x', site: 'x', product: 'x' }, randomUUID()),
      (e) => e.status === 409 && /real yard/.test(e.message),
      a,
    );
  assert.throws(
    () =>
      f.db
        .prepare("INSERT INTO charge_lines VALUES(NULL,'x',?,'s',NULL,'p',1,100,100,'LOST',NULL,'a','b','u',NULL,'k')")
        .run(f.owner.company_id),
    /real yard only/,
  );
});

test('count later: Back at yard with nothing counted, the clock flags RETURN_SHORT at the end of the day, the yard counts from its phone', (t) => {
  const f = liveFixture(t);
  const { coll } = outAndBack(f, 10);
  f.clock(D0, '14:00');
  const r = f.cmd('tripReturned', { trip: coll.id, countLater: true });
  assert.equal(r.trip.state, 'RETURNED');
  assert.equal(r.trip.countPending, true);
  assert.equal(r.trip.stateWords, 'Back at yard, not counted yet');
  assert.deepEqual(
    where(f, f.product.id),
    { yard: f.per * 3 - 10, site: 0, truck: 10, quarantine: 0 },
    'nothing counted, nothing moved',
  );
  assert.equal(f.sim.repo.get(f.truck.id, 'truck').status, 'AT_YARD', 'the truck is home');
  // the clock: not before the day ends
  f.clock(D0, '16:59');
  f.pass();
  assert.equal(f.sim.repo.get(coll.id, 'trip').flag, null);
  f.clock(D0, '17:01');
  f.pass();
  const flagged = f.sim.repo.get(coll.id, 'trip');
  assert.equal(flagged.flag.code, 'RETURN_SHORT');
  assert.match(flagged.flag.words, /Not counted yet/);
  assert.equal(f.sim.repo.all('notification').filter((n) => n.title === 'Return short').length, 1, 'said once');
  f.pass();
  assert.equal(f.sim.repo.all('notification').filter((n) => n.title === 'Return short').length, 1);
  assert.ok(f.sim.needsYou().items.some((i) => i.kind === 'RETURN_SHORT' && i.action.label === 'Count'));
  // a driver's phone cannot count; a yard hand's can (the YARD role), and it shows the return to count
  const dave = phone(f, f.team.Dave),
    kev = phone(f, f.team.Kev);
  assert.throws(
    () => dave.cmd('returnCount', { trip: coll.id, lines: [{ product: f.product.id, quantity: 10 }] }),
    (e) => e.status === 403,
  );
  assert.deepEqual(
    kev.sim.crewMe().returns.map((x) => x.id),
    [coll.id],
  );
  assert.throws(() => f.cmd('returnResolve', { trip: coll.id, lines: [] }), /Count it first/);
  const counted = kev.cmd('returnCount', { trip: coll.id, lines: [{ product: f.product.id, quantity: 8 }] });
  assert.match(counted.message, /Counted back: 8 pieces · 2 pieces not back/);
  assert.deepEqual(where(f, f.product.id), { yard: f.per * 3 - 2, site: 0, truck: 2, quarantine: 0 });
  const tr = f.sim.repo.get(coll.id, 'trip');
  assert.equal(tr.countPending, false);
  assert.equal(tr.count.kind, 'PERSON');
  assert.deepEqual(tr.notBack, [{ product: f.product.id, quantity: 2 }]);
  assert.equal(tr.flag.code, 'RETURN_SHORT', 'still short: the flag stays until the pieces are resolved');
  assert.equal(
    ledger(f, "event='RETURNED'").reduce((s, r) => s + r.quantity, 0),
    8,
    'the count moved 8 truck -> yard as a return',
  );
  assert.throws(() => kev.cmd('returnCount', { trip: coll.id }), /counted when it came back/);
});

test('every missing piece gets exactly one outcome: still on site (hire continues), lost (charged), damaged (quarantined), our loss (the owner)', (t) => {
  const f = liveFixture(t);
  const { coll } = outAndBack(f, 20);
  f.clock(D0, '14:00');
  f.cmd('tripReturned', { trip: coll.id, lines: [{ product: f.product.id, quantity: 16 }] });
  let tr = f.sim.repo.get(coll.id, 'trip');
  assert.deepEqual(tr.notBack, [{ product: f.product.id, quantity: 4 }]);
  const gm = manager(f);
  // over-resolving is refused; our loss needs the owner
  assert.throws(
    () => f.cmd('returnResolve', { trip: coll.id, lines: [{ product: f.product.id, quantity: 5, outcome: 'LOST' }] }),
    /Only 4 .* are missing/,
  );
  assert.throws(
    () =>
      gm.cmd('returnResolve', { trip: coll.id, lines: [{ product: f.product.id, quantity: 1, outcome: 'OUR_LOSS' }] }),
    (e) => e.status === 403,
  );
  // lost needs a replacement value (the owner's) or a typed value, never silence
  assert.throws(
    () => f.cmd('returnResolve', { trip: coll.id, lines: [{ product: f.product.id, quantity: 1, outcome: 'LOST' }] }),
    /has no replacement value yet/,
  );
  assert.throws(
    () => gm.cmd('productValue', { product: f.product.id, replacementValue: 4250 }),
    (e) => e.status === 403,
    'owner only',
  );
  f.cmd('productValue', { product: f.product.id, replacementValue: 4250 });
  assert.equal(f.sim.effective(f.product.id).replacementValue, 4250);
  const hireBefore = f.sim.hire({ site: f.site.id }).sites.find((s) => s.id === f.site.id);
  assert.equal(hireBefore?.onHire ?? false, false, 'everything was collected: nothing on hire');
  const r = f.cmd('returnResolve', {
    trip: coll.id,
    lines: [
      { product: f.product.id, quantity: 1, outcome: 'LOST', reason: 'Fell off at the lights' },
      { product: f.product.id, quantity: 1, outcome: 'STILL_ON_SITE' },
      { product: f.product.id, quantity: 1, outcome: 'DAMAGED', reason: 'Bent' },
      { product: f.product.id, quantity: 1, outcome: 'OUR_LOSS', reason: 'Dropped in the yard' },
    ],
  });
  assert.match(r.message, /still at Bondi, hire continues/);
  assert.match(r.message, /lost, charged at \$42\.50/);
  assert.match(r.message, /Every piece is accounted for/);
  tr = f.sim.repo.get(coll.id, 'trip');
  assert.deepEqual(tr.notBack, []);
  assert.equal(tr.flag, null);
  assert.equal(tr.resolutions.length, 4);
  assert.deepEqual(
    tr.resolutions.map((x) => x.outcome),
    ['STILL_ON_SITE', 'LOST', 'DAMAGED', 'OUR_LOSS'],
    'still on site is settled first (hire reopens the same lots)',
  );
  assert.equal(tr.resolutions.find((x) => x.outcome === 'OUR_LOSS').approvedBy, f.user.id);
  assert.deepEqual(where(f, f.product.id), { yard: f.per * 3 - 20 + 16, site: 1, truck: 0, quarantine: 1 });
  // the ledger says what happened to each, as a person's rows
  assert.deepEqual(
    ledger(f, "event IN ('STILL_ON_SITE','LOST','DAMAGED','WRITTEN_OFF')").map((x) => [
      x.event,
      x.quantity,
      x.actor_kind,
    ]),
    [
      ['STILL_ON_SITE', 1, 'PERSON'],
      ['LOST', 1, 'PERSON'],
      ['DAMAGED', 1, 'PERSON'],
      ['WRITTEN_OFF', 1, 'PERSON'],
    ],
  );
  // LOST: a charge line at the replacement value, for the site, append-only
  const ch = charges(f);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].site_id, f.site.id);
  assert.equal(ch[0].unit_value, 4250);
  assert.equal(ch[0].amount, 4250);
  assert.equal(ch[0].reason, 'LOST');
  assert.equal(ch[0].source, coll.id);
  assert.throws(() => f.db.prepare('UPDATE charge_lines SET amount=1').run(), /append only/);
  assert.throws(() => f.db.prepare('DELETE FROM charge_lines').run(), /append only/);
  assert.equal(f.sim.chargeLines(f.site.id)[0].amount, 4250);
  // STILL_ON_SITE: hire continues from the delivered day (the same lot, reopened), 1 piece on hire
  const hire = f.sim.hire({ site: f.site.id });
  const row = hire.sites.find((s) => s.id === f.site.id);
  assert.equal(row.pieces, 1);
  assert.equal(row.since, D0);
  assert.equal(f.sim.liveBoard().sites[f.site.id].pieces, 1);
  // DAMAGED: in the yard's quarantine container, never picked: the free count leaves it out and an order for everything free is exact
  const q = f.sim.containers().find((c) => c.quarantine);
  assert.equal(q.condition, 'QUARANTINED');
  assert.equal(f.sim.repo.quantity(q.id, f.product.id), 1);
  const free = f.sim.orderItems(f.yard.id).items.find((i) => i.product === f.product.id).free;
  assert.equal(free, f.per * 3 - 20 + 16, 'quarantine is not free stock');
  const big = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: free + 1 }] });
  assert.equal(big.order.lines[0].held, free, 'never a piece from quarantine');
  assert.ok(!f.sim.repo.all('reservation').some((x) => x.container === q.id));
  f.cmd('orderCancel', { id: big.order.id });
  // no second outcome for a piece already resolved
  assert.throws(
    () => f.cmd('returnResolve', { trip: coll.id, lines: [{ product: f.product.id, quantity: 1, outcome: 'LOST' }] }),
    /Nothing is missing/,
  );
  // quarantine later: repaired back into stock; scrapped; charged to the site it came from
  f.cmd('quarantineResolve', { product: f.product.id, quantity: 1, outcome: 'REPAIRED' });
  assert.deepEqual(where(f, f.product.id), { yard: f.per * 3 - 20 + 17, site: 1, truck: 0, quarantine: 0 });
  assert.equal(ledger(f, "event='REPAIRED'").length, 1);
  assert.throws(
    () => f.cmd('quarantineResolve', { product: f.product.id, quantity: 1, outcome: 'SCRAPPED' }),
    /Only 0 /,
  );
});

test('the site-finish question: sent N · back M · K missing; charge or write off closes the site with 0 unaccounted; still looking keeps it open', (t) => {
  const f = liveFixture(t);
  f.cmd('productValue', { values: [{ product: f.product.id, replacementValue: 1000 }] });
  const { coll } = outAndBack(f, 10, 6);
  f.clock(D0, '14:00');
  f.cmd('tripReturned', { trip: coll.id, lines: [{ product: f.product.id, quantity: 5 }] });
  let acc = f.sim.siteAccount(f.site.id);
  assert.deepEqual(
    [acc.sent, acc.back, acc.onSite, acc.unresolved, acc.charged, acc.writtenOff, acc.missing],
    [10, 5, 4, 1, 0, 0, 5],
  );
  assert.equal(acc.unaccounted, 1, 'the unresolved piece: nobody has said what happened to it');
  assert.equal(acc.words, 'sent 10 · back 5 · 5 missing');
  // an open order for the site: not yet
  const o = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 1 }] }).order;
  assert.throws(() => f.cmd('siteFinish', { site: f.site.id, outcome: 'CHARGE' }), /Cancel it first/);
  f.cmd('orderCancel', { id: o.id });
  // still looking: open, flagged on Needs you, nothing moves
  const looking = f.cmd('siteFinish', {
    site: f.site.id,
    outcome: 'STILL_LOOKING',
    reason: 'Foreman is checking the back',
  });
  assert.match(looking.message, /stays open: sent 10 · back 5 · 5 missing/);
  assert.equal(f.sim.repo.get(f.site.id, 'site').status, 'ACTIVE');
  assert.equal(f.sim.repo.get(f.site.id, 'site').looking.missing, 5);
  assert.ok(f.sim.needsYou().items.some((i) => i.kind === 'RETURN_SHORT' && i.action.label === 'Finish site'));
  assert.equal(charges(f).length, 0);
  // write off needs the owner; charge by the office: the 4 on record and the 1 unresolved from the trip, all charged, site closed
  const gm = manager(f);
  assert.throws(
    () => gm.cmd('siteFinish', { site: f.site.id, outcome: 'WRITE_OFF' }),
    (e) => e.status === 403,
  );
  const done = gm.cmd('siteFinish', { site: f.site.id, outcome: 'CHARGE', reason: 'Not returned' });
  assert.match(done.message, /Bondi finished: sent 10 · back 5 · 5 missing · 5 pieces charged/);
  const site = f.sim.repo.get(f.site.id, 'site');
  assert.equal(site.status, 'ARCHIVED');
  assert.equal(site.looking, null);
  assert.equal(site.finish.charged, 5);
  acc = f.sim.siteAccount(f.site.id);
  assert.deepEqual(
    [acc.sent, acc.back, acc.onSite, acc.unresolved, acc.charged, acc.writtenOff, acc.missing],
    [10, 5, 0, 0, 5, 0, 0],
  );
  assert.equal(acc.unaccounted, 0, 'unaccounted pieces = 0 at a closed site');
  assert.equal(acc.sent - acc.back - acc.onSite - acc.charged - acc.writtenOff, 0);
  const ch = charges(f);
  assert.equal(
    ch.reduce((s, c) => s + c.quantity, 0),
    5,
  );
  assert.deepEqual(ch.map((c) => c.reason).sort(), ['LOST', 'SITE_FINISH']);
  assert.ok(ch.every((c) => c.unit_value === 1000));
  assert.equal(f.sim.hire({ site: f.site.id }).sites.find((s) => s.id === f.site.id)?.pieces ?? 0, 0, 'hire ended');
  assert.equal(f.sim.containers().filter((c) => c.location === f.site.id).length, 0, "nothing on the site's record");
  assert.equal(f.sim.repo.get(coll.id, 'trip').notBack.length, 0);
  assert.throws(() => f.cmd('siteFinish', { site: f.site.id, outcome: 'CHARGE' }), /already finished/);
  // a second site, written off by the owner: 0 unaccounted too, no charge
  const s2 = f.cmd('gameSite', { name: 'Manly' }).site;
  const o2 = f.cmd('orderCreate', { site: s2.id, lines: [{ product: f.product.id, quantity: 3 }] }).order;
  const tr2 = f.cmd('tripBook', { orders: [o2.id], truck: f.truck.id, driver: f.team.Dave.id, day: D1 }).trip;
  f.clock(D1, '08:00');
  f.cmd('tripLoaded', { trip: tr2.id });
  f.cmd('tripDelivered', { trip: tr2.id, receivedBy: 'Pat' });
  f.cmd('tripReturned', { trip: tr2.id });
  const wo = f.cmd('siteFinish', { site: s2.id, outcome: 'WRITE_OFF', reason: 'Builder went bust' });
  assert.match(wo.message, /3 pieces written off/);
  const acc2 = f.sim.siteAccount(s2.id);
  assert.deepEqual(
    [acc2.sent, acc2.back, acc2.writtenOff, acc2.charged, acc2.missing, acc2.unaccounted],
    [3, 0, 3, 0, 0, 0],
  );
  assert.equal(f.sim.repo.get(s2.id, 'site').finish.approvedBy, f.user.id);
  assert.equal(
    charges(f).reduce((s, c) => s + c.quantity, 0),
    5,
    'no charge for a write-off',
  );
  // Remove site in a real yard points at the question when scaffolding is still on record
  const s3 = f.cmd('gameSite', { name: 'Coogee' }).site;
  const o3 = f.cmd('orderCreate', { site: s3.id, lines: [{ product: f.product.id, quantity: 2 }] }).order;
  const tr3 = f.cmd('tripBook', {
    orders: [o3.id],
    truck: f.truck.id,
    driver: f.team.Dave.id,
    day: D1,
    time: '10:00',
  }).trip;
  f.clock(D1, '10:30');
  f.cmd('tripLoaded', { trip: tr3.id });
  f.cmd('tripDelivered', { trip: tr3.id, receivedBy: 'Pat' });
  f.cmd('tripReturned', { trip: tr3.id });
  assert.throws(() => f.cmd('gameRemoveSite', { site: s3.id }), /still scaffolding recorded at Coogee/);
});

test('one definition of "available": the register, the stock blocks and the minimum rule agree once a stillage is damaged', (t) => {
  const f = liveFixture(t);
  const all = f.sim.containers(),
    c = all.find(
      (x) =>
        x.location === f.yard.id && f.sim.repo.quantity(x.id, f.product.id) > 0 && !all.some((o) => o.support === x.id),
    );
  f.cmd('condition', { id: c.id, condition: 'DAMAGED', reason: 'Bent frame' });
  f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 3 }] });
  const snap = f.sim.snapshot();
  const reg = snap.register.find((r) => r.product === f.product.id),
    block = snap.stock[f.yard.id].rows.find((r) => r.product === f.product.id);
  assert.equal(reg.quantity, f.per * 3);
  assert.equal(reg.unserviceable, f.per);
  assert.equal(reg.reserved, 3);
  assert.equal(reg.available, f.per * 3 - f.per - 3, 'quantity - reserved - unserviceable');
  assert.equal(reg.available, block.free, 'the register and the stock block say the same number');
  assert.equal(reg.available, availableOf(reg));
  assert.equal(snap.availability.serviceablePieces, f.per * 3 - f.per - 3);
  assert.equal(
    f.sim.orderItems(f.yard.id).items.find((i) => i.product === f.product.id).free,
    reg.available,
    'the picker too',
  );
  // a real yard's picks never touch the damaged stillage
  assert.ok(!f.sim.repo.all('reservation').some((r) => r.container === c.id));
});

test("Add stock in a real yard keeps the cost side: unit cost, supplier, reference, received on; values are the owner's, in bulk too", (t) => {
  const f = liveFixture(t);
  f.cmd('gameAddStock', {
    lines: [{ product: f.product.id, quantity: 5 }],
    unitCost: 3900,
    supplier: 'Acme Scaffold',
    reference: 'INV-1001',
    receivedOn: D0,
  });
  const intakes = f.sim.repo.all('intake');
  assert.equal(intakes.length, 1);
  assert.deepEqual(
    [
      intakes[0].product,
      intakes[0].quantity,
      intakes[0].unitCost,
      intakes[0].supplier,
      intakes[0].reference,
      intakes[0].receivedOn,
    ],
    [f.product.id, 5, 3900, 'Acme Scaffold', 'INV-1001', D0],
  );
  f.cmd('gameAddStock', { lines: [{ product: f.product.id, quantity: 1 }] });
  assert.equal(f.sim.repo.all('intake').length, 1, 'nothing typed, nothing kept');
  assert.throws(
    () => f.cmd('gameAddStock', { lines: [{ product: f.product.id, quantity: 1 }], receivedOn: 'yesterday' }),
    /must be a day/,
  );
  // the Practice yard keeps no intake records
  const demo = new Simulation(f.db, f.owner),
    dcmd = (a, i) => demo.execute(a, i, randomUUID());
  dcmd('gameStart', { size: 'S' });
  dcmd('gameCatalogue', {});
  const p = demo.repo
    .all('product')
    .map((x) => demo.effective(x.id))
    .find((x) => x.unitWeight > 0);
  dcmd('gameAddStock', { lines: [{ product: p.id, quantity: 2 }], unitCost: 100, supplier: 'X' });
  assert.equal(demo.repo.all('intake').length, 0);
  // bulk values (the catalogue's CSV column): several products at once; null clears
  const other = f.sim.repo.all('product').find((x) => x.id !== f.product.id);
  const r = f.cmd('productValue', {
    values: [
      { product: f.product.id, replacementValue: 1200 },
      { product: other.id, replacementValue: 800 },
    ],
  });
  assert.equal(r.values.length, 2);
  assert.equal(f.sim.effective(other.id).replacementValue, 800);
  f.cmd('productValue', { product: other.id, replacementValue: null });
  assert.equal(f.sim.effective(other.id).replacementValue, null);
  assert.ok(
    f.sim.snapshot().products.find((x) => x.id === f.product.id).replacementValue === 1200,
    'carried on the effective product',
  );
  assert.throws(() => f.cmd('productValue', { product: f.product.id, replacementValue: -1 }), /Replacement value/);
});
