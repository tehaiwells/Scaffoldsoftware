process.env.TZ = 'Australia/Sydney';
// Part 5 after the second review (ADR 0012, "After the second review"): a move the second site would not take comes home (Back at yard
// from Collected, the order not delivered, hire settled as a collection with the minimum); a move's confirmation rows are where they
// happened, so both site accounts stay whole; the truck's timeline reads the trip's direction; the roster is the office's (a supervisor's
// task does not roster); someone who left the team still answers on the roster grid; the drawer for Accounts has no dead tiles; the
// worker rows say what the three boxes are; the phone on the day shows today, not yesterday's "tomorrow".
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addDays } from '../src/domain/schedule.js';
import { Simulation } from '../src/simulation.js';
import { crewLink, crewClaim, crewAuthenticate } from '../src/crew-auth.js';
import { liveFixture, D0 } from './helpers/live-fixture.js';
import { planFixture, D0 as PD0 } from './helpers/plan-fixture.js';
import { officeHTML } from '../public/game.js';
import { glTaskHTML } from '../public/gear.js';
import { crewPage } from '../public/crew.js';
const D = (n) => addDays(D0, n);
const at = (f, d, hm) => new Date(f.at(d, hm)).toISOString();
// A real yard billing by the day ($1.00 a piece, minimum hire 7 days): Bondi is Acme's, Manly is Bob's; 10 pieces went to Bondi on D0.
function twoSites(t) {
  const f = liveFixture(t);
  f.cmd('hireRate', { product: f.product.id, day: 100, minDays: 7 });
  f.acme = f.cmd('customerSave', { name: 'Acme Builders', termsDays: 14 }).customer;
  f.bob = f.cmd('customerSave', { name: 'Bob the Builder', termsDays: 14 }).customer;
  f.cmd('siteDetails', { id: f.site.id, customer: f.acme.id, po: 'PO-77' });
  f.manly = f.cmd('gameSite', { name: 'Manly', address: '2 The Corso, Manly', customer: f.bob.id }).site;
  const out = f.cmd('gearListCreate', {
    from: { kind: 'yard' },
    to: { kind: 'site', id: f.site.id },
    lines: [{ product: f.product.id, quantity: 10 }],
    day: D0,
    time: '10:00',
    truck: f.truck.id,
    driver: f.team.Dave.id,
  });
  const trip = f.sim.repo.get(f.sim.repo.get(f.item(out.item.id).order, 'order').trip, 'trip');
  f.clock(D0, '10:30');
  f.cmd('tripLoaded', { trip: trip.id, at: at(f, D0, '10:05'), reason: 'Paper docket' });
  f.cmd('tripDelivered', { trip: trip.id, at: at(f, D0, '10:25'), reason: 'Paper docket', receivedBy: 'Ana' });
  f.cmd('tripReturned', { trip: trip.id });
  f.move = (quantity = 6) => {
    f.clock(D0, '17:30');
    const mv = f.cmd('gearListCreate', {
      from: { kind: 'site', id: f.site.id },
      to: { kind: 'site', id: f.manly.id },
      lines: [{ product: f.product.id, quantity }],
      day: D(1),
      time: '08:00',
      truck: f.truck.id,
      driver: f.team.Dave.id,
    });
    const o = f.sim.repo.get(f.item(mv.item.id).order, 'order');
    return { item: mv.item, o, trip: f.sim.repo.get(o.trip, 'trip') };
  };
  f.where = () => {
    const out = {};
    for (const c of f.sim.containers()) {
      const q = f.sim.repo.quantity(c.id, f.product.id);
      if (!q) continue;
      const k =
        c.location === f.yard.id
          ? 'yard'
          : c.location === f.site.id
            ? 'bondi'
            : c.location === f.manly.id
              ? 'manly'
              : 'truck';
      out[k] = (out[k] ?? 0) + q;
    }
    return out;
  };
  f.rows = () =>
    f.db
      .prepare("SELECT step,site_id FROM trip_confirmation WHERE company_id=? AND step<>'PACKED' ORDER BY sequence")
      .all(f.company)
      .map((r) => r.step + '@' + (r.site_id === f.site.id ? 'Bondi' : r.site_id === f.manly.id ? 'Manly' : '?'));
  return f;
}
const account = (a) => ({
  sent: a.sent,
  collected: a.collected,
  moved: a.moved,
  back: a.back,
  onSite: a.onSite,
  unaccounted: a.unaccounted,
});

test('a move Manly would not take: Back at yard from Collected brings it home, the order is not delivered, Send again sends it from the yard, Bondi settles as a collection with the minimum and both accounts stay whole', (t) => {
  const f = twoSites(t);
  const { item, o, trip } = f.move(6);
  f.clock(D(1), '08:30');
  f.cmd('tripCollected', { trip: trip.id, at: at(f, D(1), '08:30') });
  assert.deepEqual(f.sim.tripNext(f.sim.repo.get(trip.id, 'trip')), ['tripDelivered', 'tripReturned', 'tripArrived']);
  f.clock(D(1), '09:40');
  const r = f.cmd('tripReturned', { trip: trip.id, at: at(f, D(1), '09:30') });
  assert.match(r.message, /Back at yard 09:30, not delivered/);
  const tr = f.sim.repo.get(trip.id, 'trip');
  assert.equal(tr.state, 'RETURNED');
  assert.equal(tr.undelivered, true);
  assert.equal(f.sim.repo.get(o.id, 'order').status, 'NOT_DELIVERED');
  assert.deepEqual(f.where(), { yard: f.per * 3 - 4, bondi: 4 }, 'the 6 are in the yard, 4 still at Bondi');
  assert.equal(f.item(item.id).stage, 'WAITING');
  assert.match(f.item(item.id).problem, /Came back, not delivered/);
  const tv = f.sim.tripView(tr);
  assert.equal(tv.undelivered, true);
  assert.deepEqual(tv.next, []);
  // the rows are Bondi's (collected from it, back from it); Manly never saw the gear
  assert.deepEqual(f.rows(), [
    'LOADED@Bondi',
    'DELIVERED@Bondi',
    'RETURNED@Bondi',
    'COLLECTED@Bondi',
    'RETURNED@Bondi',
  ]);
  assert.deepEqual(account(f.sim.siteAccount(f.site.id)), {
    sent: 10,
    collected: 6,
    moved: 0,
    back: 6,
    onSite: 4,
    unaccounted: 0,
  });
  assert.deepEqual(account(f.sim.siteAccount(f.manly.id)), {
    sent: 0,
    collected: 0,
    moved: 0,
    back: 0,
    onSite: 0,
    unaccounted: 0,
  });
  // the truck is home: nothing open on it, the next keyed-in time is not refused
  assert.equal(f.sim.repo.get(f.truck.id, 'truck').status, 'AT_YARD');
  assert.equal(f.sim.tripTruckBusyAt(f.truck.id, 'x', f.at(D(1), '10:00')), null);
  assert.equal(f.sim.tripOpenRows().length, 0);
  // Send again: the same pieces as a new order from the yard to Manly, waiting for a truck
  const again = f.cmd('orderCreate', {
    site: f.manly.id,
    lines: [{ product: f.product.id, quantity: 6 }],
    source: 'office',
    note: 'Sent again: ' + tv.label + ' came back',
  });
  assert.equal(again.order.status, 'OPEN');
  assert.equal(again.order.direction, 'OUT');
  // hire: Bondi's 6 left on D1 as a collection (the minimum applies: 1 day on hire, 7 charged); 4 stay; Manly has nothing
  f.clock(D(8), '12:00');
  const acme = f.sim.statementPreview({ customer: f.acme.id, to: D(8) });
  assert.equal(acme.subtotal, (4 * 9 + 6 * 1 + 6 * 6) * 100, '4 for 9 days, 6 for their one day plus the top-up to 7');
  const bondi = f.sim.hire({ site: f.site.id, from: D0, to: D(8) }).statement,
    manly = f.sim.hire({ site: f.manly.id, from: D0, to: D(8) }).statement;
  assert.equal(bondi.onHireNow, 4);
  assert.equal(manly.onHireNow, 0);
  assert.equal(manly.pieceDays, 0);
});

test('a move delivered in full: Back at yard is the courtesy step; the truck is free the next day without it; a short move leaves Bondi whole (moved and back) and Manly with only what landed', (t) => {
  const f = twoSites(t);
  const { trip } = f.move(6);
  f.clock(D(1), '08:30');
  f.cmd('tripCollected', { trip: trip.id, at: at(f, D(1), '08:30') });
  f.clock(D(1), '09:20');
  f.cmd('tripDelivered', { trip: trip.id, at: at(f, D(1), '09:15'), receivedBy: 'Bo' });
  let tr = f.sim.repo.get(trip.id, 'trip');
  assert.equal(tr.state, 'DELIVERED');
  assert.deepEqual(f.sim.tripNext(tr), ['tripReturned']);
  // the next day, before any Back at yard: a keyed-in collection on the same truck is not refused
  assert.equal(f.sim.tripTruckBusyAt(f.truck.id, 'x', f.at(D(2), '09:20')), null);
  assert.match(
    String(f.sim.tripTruckBusyAt(f.truck.id, 'x', f.at(D(1), '09:00'))),
    /on Trip 2 then \(left 08:30, delivered 09:15\)/,
  );
  f.clock(D(1), '10:30');
  f.cmd('tripReturned', { trip: trip.id });
  tr = f.sim.repo.get(trip.id, 'trip');
  assert.equal(tr.state, 'RETURNED');
  assert.equal(tr.undelivered, undefined);
  assert.equal(f.sim.repo.get(tr.orders[0], 'order').status, 'DELIVERED');
  assert.equal(f.sim.repo.get(f.truck.id, 'truck').status, 'AT_YARD');
  assert.deepEqual(f.rows(), [
    'LOADED@Bondi',
    'DELIVERED@Bondi',
    'RETURNED@Bondi',
    'COLLECTED@Bondi',
    'DELIVERED@Manly',
    'RETURNED@Bondi',
  ]);
  assert.deepEqual(account(f.sim.siteAccount(f.site.id)), {
    sent: 10,
    collected: 6,
    moved: 6,
    back: 0,
    onSite: 4,
    unaccounted: 0,
  });
  assert.deepEqual(account(f.sim.siteAccount(f.manly.id)), {
    sent: 6,
    collected: 0,
    moved: 0,
    back: 0,
    onSite: 6,
    unaccounted: 0,
  });
  assert.match(f.sim.siteAccount(f.site.id).summary, /6 moved to Manly/);
});

test('a short move: 4 land at Manly, 2 come back to the yard: Bondi counts 4 moved and 2 back, Manly 4 sent and none collected', (t) => {
  const f = twoSites(t);
  const { trip } = f.move(6);
  f.clock(D(1), '08:30');
  f.cmd('tripCollected', { trip: trip.id, at: at(f, D(1), '08:30') });
  f.clock(D(1), '09:20');
  f.cmd('tripDelivered', {
    trip: trip.id,
    at: at(f, D(1), '09:15'),
    receivedBy: 'Bo',
    lines: [{ product: f.product.id, quantity: 4 }],
  });
  assert.equal(f.sim.repo.get(trip.id, 'trip').state, 'DELIVERED_SHORT');
  f.clock(D(1), '10:30');
  f.cmd('tripReturned', { trip: trip.id });
  assert.deepEqual(f.where(), { yard: f.per * 3 - 8, bondi: 4, manly: 4 });
  assert.deepEqual(account(f.sim.siteAccount(f.site.id)), {
    sent: 10,
    collected: 6,
    moved: 4,
    back: 2,
    onSite: 4,
    unaccounted: 0,
  });
  assert.deepEqual(account(f.sim.siteAccount(f.manly.id)), {
    sent: 4,
    collected: 0,
    moved: 0,
    back: 0,
    onSite: 4,
    unaccounted: 0,
  });
});

test('the roster is the office’s: a supervisor’s task with "roster them too" leaves the worker not rostered; someone who left the team still answers on the roster grid', (t) => {
  const f = liveFixture(t);
  const made = f.auth.invite(f.user, { email: 'sue-' + Date.now() + '@example.com', roles: ['SUPERVISOR'] });
  const token = f.auth.acceptInvitation({ token: made.token, name: 'Sue', password: 'demonstration-password' });
  const sue = f.auth.authenticate(token);
  const site = f.sim.repo.get(f.site.id, 'site');
  site.supervisor = sue.id;
  f.sim.repo.save(site);
  const jo = f.cmd('teamAdd', { name: 'BondiJo', job: 'ONSITE', where: f.site.id }).person;
  const sup = new Simulation(f.db, sue);
  const r = sup.execute(
    'taskCreate',
    {
      kind: 'PLAIN',
      name: 'Tidy the stack',
      day: D(1),
      site: f.site.id,
      roster: true,
      workers: [{ person: jo.id, priority: 1 }],
    },
    randomUUID(),
  );
  assert.equal(r.task.workers[0].person, jo.id);
  assert.equal(f.sim.rosterOf(jo.id, D(1)), null, 'not rostered by a supervisor');
  assert.doesNotMatch(r.message ?? '', /rostered/);
  assert.throws(() => sup.rosterView({ day: D(1) }), /does not allow/);
  // the office's own tap rosters as before
  const r2 = f.cmd('taskCreate', {
    kind: 'PLAIN',
    name: 'Sweep',
    day: D(1),
    roster: true,
    workers: [{ person: f.team.Jo.id, priority: 1 }],
  });
  assert.equal(f.sim.rosterOf(f.team.Jo.id, D(1))?.status, 'ROSTERED');
  assert.match(r2.message, /rostered/i);
  // someone who left: the grid answers that they are gone, never "Choose someone in your team"
  f.cmd('teamRemove', { id: jo.id });
  const gone = f.sim.rosterView({ person: jo.id });
  assert.equal(gone.person.gone, true);
  assert.equal(gone.person.name, 'BondiJo');
  assert.deepEqual(gone.days, []);
});

test('the Practice yard: a worker with tasks tomorrow leaves the team; Task progress, the pre-start and the roster grid still answer', (t) => {
  const f = planFixture(t);
  const { p, per } = f.stock(3);
  const bondi = f.site('Bondi');
  const D1 = addDays(PD0, 1);
  const dave = f.cmd('teamAdd', { name: 'Dave', role: 'DRIVER' }).person;
  const kev = f.cmd('teamAdd', { name: 'Kev', job: 'YARD', pattern: 'MON_FRI' }).person;
  f.cmd('gearListCreate', {
    from: { kind: 'yard' },
    to: { kind: 'site', id: bondi.id },
    lines: [{ product: p.id, quantity: per }],
    day: D1,
    time: '07:00',
    truck: f.trucks()[0].id,
    driver: dave.id,
    workers: [{ person: kev.id, priority: 1 }],
  });
  f.cmd('taskCreate', {
    kind: 'PLAIN',
    name: 'Sweep',
    day: D1,
    roster: true,
    workers: [{ person: kev.id, priority: 2 }],
  });
  f.clock(PD0, '15:05');
  f.pass();
  assert.equal(f.cmd('teamRemove', { id: kev.id }).message, 'Kev has left the team.');
  const tv = f.sim.tasksView({ day: D1 });
  assert.ok(!tv.workers.some((w) => w.name === 'Kev'), 'his tasks from tomorrow went with him');
  assert.equal(tv.summary.total, 2);
  assert.ok(f.sim.prestartView({ day: D1 }));
  assert.equal(f.sim.rosterView({ person: kev.id }).person.gone, true);
  assert.equal(f.sim.rosterView({ day: D1 }).people.length, 0);
  f.clock(D1, '07:30');
  f.pass();
  assert.ok(f.sim.tasksView({ day: D1 }));
});

test('the drawer for Accounts has Hire and the business pages, never the day’s tiles; the office and a supervisor keep them', () => {
  const tiles = (perms) =>
    [
      ...officeHTML({ state: {}, account: { permissions: perms }, hire: true }).matchAll(/data-view="([A-Z0-9]+)"/g),
    ].map((m) => m[1]);
  const acct = tiles(['finance.view', 'statements.manage', 'customers.manage']);
  for (const v of ['TODAY', 'MATERIALS', 'WORKERS', 'PROGRESS', 'PRESTART'])
    assert.ok(!acct.includes(v), v + ' hidden');
  assert.ok(acct.includes('HIRE'));
  const office = tiles(['operations.manage']),
    sup = tiles(['requests.create', 'sites.assigned']);
  for (const v of ['TODAY', 'MATERIALS', 'WORKERS', 'PROGRESS', 'PRESTART']) {
    assert.ok(office.includes(v), v + ' for the office');
    assert.ok(sup.includes(v), v + ' for a supervisor');
  }
});

test('the worker rows on a list’s card say what the three boxes are, once, in Task progress’s words', () => {
  const html = glTaskHTML({
    workers: [
      { name: 'Kev', priority: 1, steps: { RECEIVED: { at: '2026-10-14T00:00:00Z' } } },
      { name: 'Sam', priority: 2, steps: {} },
    ],
    steps: {},
  });
  assert.equal(html.match(/gl-legend/g).length, 1);
  assert.match(html, /got it · packed · loaded/);
  assert.match(html, /title="Got the list"/);
  assert.equal(html.match(/class="gl-tick on"/g).length, 1);
});

test('on the day a worker’s phone shows today’s roster row and today’s tasks: yesterday’s answered asks are not cards that say "tomorrow", and Tomorrow holds only tomorrow’s', (t) => {
  const f = liveFixture(t);
  const kev = f.cmd('teamAdd', { name: 'Kevin', job: 'YARD' }).person;
  f.cmd('rosterPick', { person: kev.id, days: [D(1)] });
  f.cmd('taskCreate', { kind: 'PLAIN', name: 'Sweep', day: D(1), workers: [{ person: kev.id, priority: 1 }] });
  const made = crewLink(f.auth, f.user, { person: kev.id });
  const claimed = crewClaim(f.auth, { token: made.token, label: 'Kevin’s phone' });
  const phone = new Simulation(f.db, crewAuthenticate(f.db, claimed.token));
  f.clock(D0, '15:05');
  f.pass();
  // the day before: both asks are cards that say tomorrow; Kev answers yes to the roster
  let html = crewPage({ me: phone.crewMe(), pending: [] });
  assert.match(html, /You’re on tomorrow/);
  assert.match(html, /Your tasks tomorrow/);
  const ros = f.sim.repo.all('message').find((m) => m.person === kev.id && m.subject === 'ROSTER');
  phone.execute('messageAnswer', { id: ros.id, yes: true }, randomUUID());
  // the day: today's row, no card that says tomorrow, the task ask (unanswered) sits with today's tasks and not under Tomorrow
  f.clock(D(1), '07:30');
  f.pass();
  html = crewPage({ me: phone.crewMe(), pending: [] });
  assert.doesNotMatch(html, /You’re on tomorrow/);
  assert.doesNotMatch(html, /you’re on tomorrow/i);
  assert.match(html, /<b>Today<\/b> [^<]*Confirmed/);
  assert.doesNotMatch(html, /Tomorrow<\/h2>[\s\S]*Your tasks today/);
  assert.match(html, /Sweep/);
});

test('an off-hire called on a site with a move planned from it: the pickup asks only for what the move does not take, and both collections are one tap', (t) => {
  const f = twoSites(t);
  const { trip } = f.move(6);
  f.clock(D0, '17:40');
  const off = f.cmd('offHireRequested', { site: f.site.id, when: D0, pickupDay: D(1), whoCalled: 'Mick' }).offHire;
  assert.equal(off.pieces, 10, 'on record at Bondi');
  const back = f.sim.repo.get(off.order, 'order');
  assert.equal(back.direction, 'BACK');
  assert.equal(back.lines[0].requested, 4, 'the move takes 6 of the 10');
  const pick = f.cmd('tripBook', {
    orders: [off.order],
    truck: f.truck.id,
    driver: f.team.Dave.id,
    day: D(1),
    time: '11:00',
  }).trip;
  f.clock(D(1), '08:30');
  f.cmd('tripCollected', { trip: trip.id });
  f.clock(D(1), '09:20');
  f.cmd('tripDelivered', { trip: trip.id, receivedBy: 'Bo' });
  f.clock(D(1), '11:30');
  f.cmd('tripCollected', { trip: pick.id });
  f.clock(D(1), '12:10');
  f.cmd('tripReturned', { trip: pick.id });
  assert.deepEqual(f.where(), { yard: f.per * 3 - 6, manly: 6 });
  assert.deepEqual(account(f.sim.siteAccount(f.site.id)), {
    sent: 10,
    collected: 10,
    moved: 6,
    back: 4,
    onSite: 0,
    unaccounted: 0,
  });
  // a move that already takes everything: the off-hire waits until it has gone
  const g = twoSites(t);
  g.move(10);
  g.clock(D0, '17:40');
  assert.throws(
    () => g.cmd('offHireRequested', { site: g.site.id, when: D0, whoCalled: 'Mick' }),
    /on a move already \(M-1\)/,
  );
});
