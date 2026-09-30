import { test, expect, request as playwrightRequest } from '@playwright/test';
// Phase 1A part 3 (ADR 0010), through the running server only (the pages are the UI builder's): the office books a day on Today (a truck
// with a driver, a list on it, workers); the driver says yes on his phone; the yard hand packs on hers; the workers answer on theirs; the
// Dispatch lanes show each state dot; a bring-back comes back short, is counted and resolved with a charge; Needs you shows and clears.
const key = () => 'e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2);
test('book a day in Today, the phones answer and pack, the lanes follow, a short return is resolved, Needs you shows and clears', async ({
  baseURL,
}) => {
  const desk = await playwrightRequest.newContext({ baseURL });
  const cmd = async (action, data) => {
    const r = await desk.post('/api/commands/' + action, { data, headers: { 'Idempotency-Key': key() } });
    expect(r.status(), action + ': ' + (await r.text())).toBe(200);
    return r.json();
  };
  const get = async (path) => {
    const r = await desk.get(path);
    expect(r.status(), path + ': ' + (await r.text())).toBe(200);
    return r.json();
  };
  // a person's phone: the office makes a link, the phone claims it, then taps with one key each
  const phoneFor = async (person) => {
    const link = await desk.post('/api/crew-links', { data: { person: person.id } });
    expect(link.status()).toBe(201);
    const made = await link.json();
    const ctx = await playwrightRequest.newContext({ baseURL });
    const token = new URL(made.link).hash.slice(3);
    expect((await ctx.post('/api/crew/claim', { data: { token, label: 'Test phone' } })).status()).toBe(200);
    return {
      me: async () => (await ctx.get('/api/crew/me')).json(),
      tap: async (action, data) => {
        const r = await ctx.post('/api/crew/commands/' + action, { data, headers: { 'Idempotency-Key': key() } });
        expect(r.status(), action + ': ' + (await r.text())).toBe(200);
        return r.json();
      },
      refused: async (action, data) =>
        (await ctx.post('/api/crew/commands/' + action, { data, headers: { 'Idempotency-Key': key() } })).status(),
      dispose: () => ctx.dispose(),
    };
  };
  const reg = await desk.post('/api/register', {
    data: {
      companyName: 'Tee Scaffolding',
      name: 'Tee',
      email: `dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'Local-demo-test-2026!',
      systems: ['quickstage'],
      mode: 'LIVE',
    },
  });
  expect(reg.status()).toBe(200);
  const { yard } = await cmd('gameStart', { size: 'S' });
  await cmd('gameCatalogue', {});
  const state = await get('/api/state');
  const product = state.products.find((p) => p.unitWeight > 0 && !p.retired);
  await cmd('gameAddStock', {
    lines: [{ product: product.id, quantity: 40 }],
    unitCost: 3500,
    supplier: 'Acme',
    reference: 'INV-7',
  });
  const site = (await cmd('gameSite', { name: 'Bondi', address: '1 Campbell Parade, Bondi' })).site;
  const truck = await cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: yard.id });
  const dave = (await cmd('teamAdd', { name: 'Dave', role: 'DRIVER', mobile: '0412 345 678' })).person;
  const kev = (await cmd('teamAdd', { name: 'Kev', role: 'YARDSMAN' })).person;
  const lee = (await cmd('teamAdd', { name: 'Lee', role: 'LEADING_HAND' })).person;
  const jo = (await cmd('teamAdd', { name: 'Jo', role: 'SCAFFOLDER' })).person;
  // the day to book: today at 5 pm while today is open, else tomorrow (the asks go out at once either way: it is past 3 pm)
  const plan = await get('/api/plan');
  const nowHm = new Date(plan.now).toLocaleTimeString('en-AU', { hour12: false, timeZone: plan.timeZone }).slice(0, 5);
  const day = nowHm < '16:45' ? plan.today : plan.tomorrow,
    time = nowHm < '16:45' ? '17:00' : '07:00';
  // TRUCK with a driver: Booked -> Asked at once
  const tb = (await cmd('planTruck', { day, time, truck: truck.id, driver: dave.id })).item;
  expect(tb.stage).toBe('ASKING');
  // MATERIALS on that truck: an exact order held now, on the truck's trip
  const list = (
    await cmd('planMaterials', {
      day,
      time,
      site: site.id,
      lines: [{ product: product.id, quantity: 12 }],
      truckPlan: tb.id,
    })
  ).item;
  const trips0 = await get('/api/trips?day=' + day);
  const trip = trips0.trips.find((t) => t.truckPlan === tb.id);
  expect(trip.state).toBe('BOOKED');
  expect(trip.lines[0].held).toBe(12);
  // WORKERS: Lee (leading hand) and Jo, asked at once
  const wk = (await cmd('planWorkers', { day, time, site: site.id, count: 2, people: [lee.id, jo.id] })).item;
  expect(wk.stage).toBe('ASKING');
  // a DRAFT list for another day: sent to nobody, nothing held
  const dayAfter = (d, n = 1) => new Date(Date.parse(d + 'T12:00:00Z') + 86400000 * n).toISOString().slice(0, 10);
  const draft = (
    await cmd('planMaterials', {
      day: dayAfter(day),
      time: '08:00',
      site: site.id,
      lines: [{ product: product.id, quantity: 1 }],
      draft: true,
    })
  ).item;
  expect(draft.status).toBe('DRAFT');
  // the lanes before anyone answers: one lane, the trip's dot ASKED
  let lanes = await get('/api/dispatch?day=' + day);
  expect(lanes.lanes.length).toBe(1);
  expect(lanes.lanes[0].trips[0].dot).toBe('ASKED');
  expect(lanes.people.yard.toPack).toBe(1);
  expect(lanes.people.workers[0].yes).toBe(0);
  // the driver's phone: his ask, answered yes; the run sheet
  const dPhone = await phoneFor(dave);
  let me = await dPhone.me();
  expect(me.person.kind).toBe('driver');
  const ask = me.asks.find((a) => a.subject === 'DRIVE' && a.canAnswer);
  expect(ask).toBeTruthy();
  expect((await dPhone.tap('messageAnswer', { id: ask.id, yes: true })).message).toBe('Thanks. See you there.');
  lanes = await get('/api/dispatch?day=' + day);
  expect(lanes.lanes[0].trips[0].dot).toBe('YES');
  const sheet = await get('/api/run-sheet?day=' + day + '&driver=' + dave.id);
  expect(sheet.sheets[0].trips[0].words).toBe('Deliver to Bondi');
  expect(sheet.sheets[0].trips[0].lines[0].quantity).toBe(12);
  // the workers' phones: each answers their own; Lee's shows the gang
  const lPhone = await phoneFor(lee),
    jPhone = await phoneFor(jo);
  const jAsk = (await jPhone.me()).asks.find((a) => a.subject === 'WORK' && a.canAnswer);
  await jPhone.tap('messageAnswer', { id: jAsk.id, yes: true });
  const lAsk = (await lPhone.me()).asks.find((a) => a.subject === 'WORK' && a.canAnswer);
  await lPhone.tap('messageAnswer', { id: lAsk.id, yes: true });
  expect(await jPhone.refused('messageAnswer', { id: lAsk.id, yes: true })).toBe(404);
  lanes = await get('/api/dispatch?day=' + day);
  expect(lanes.people.workers[0].yes).toBe(2);
  expect(lanes.people.workers[0].onSite).toBe(0);
  // the yard hand's phone: the list to pack, packed with counts (a driver's phone cannot)
  const kPhone = await phoneFor(kev);
  me = await kPhone.me();
  expect(me.can.packs).toBe(true);
  expect(me.packs.map((p) => p.id)).toEqual([trip.id]);
  expect(await dPhone.refused('packConfirmed', { trip: trip.id })).toBe(403);
  expect(
    (await kPhone.tap('packConfirmed', { trip: trip.id, lines: [{ product: product.id, quantity: 12 }] })).trip.state,
  ).toBe('PACKED');
  lanes = await get('/api/dispatch?day=' + day);
  expect(lanes.lanes[0].trips[0].dot).toBe('PACKED');
  expect(lanes.people.yard.packed).toBe(1);
  // the driver: Loaded & left, Delivered; the dots follow; the list's day is done
  await dPhone.tap('tripLoaded', { trip: trip.id });
  expect((await get('/api/dispatch?day=' + day)).lanes[0].trips[0].dot).toBe('LOADED');
  await dPhone.tap('tripDelivered', { trip: trip.id, receivedBy: 'J. Smith' });
  expect((await get('/api/dispatch?day=' + day)).lanes[0].trips[0].dot).toBe('DELIVERED');
  await dPhone.tap('tripReturned', { trip: trip.id });
  expect((await get('/api/dispatch?day=' + day)).lanes[0].trips[0].dot).toBe('BACK');
  const month = await get('/api/plan?month=' + day.slice(0, 7));
  expect(month.items.find((i) => i.id === list.id).status).toBe('DONE');
  // Needs you: the delivered pieces are on hire with no rate; an expired permit; then both clear (a rate, a dismissal with a reason)
  const yesterday = new Date(Date.parse(plan.today + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
  await cmd('paperworkAdd', { type: 'PERMIT', title: 'Council permit', site: site.id, expiresOn: yesterday });
  let needs = await get('/api/needs-you');
  expect(needs.items.map((i) => i.kind)).toEqual(['PAPERWORK', 'UNPRICED_ON_HIRE']);
  expect((await get('/api/state')).needsYou.count).toBe(2);
  await cmd('hireRate', { product: product.id, week: 150 });
  await cmd('needsYouDismiss', { id: needs.items[0].id, reason: 'Renewed on paper' });
  needs = await get('/api/needs-you');
  expect(needs.count).toBe(0);
  // the gang: the office signs them on only on the day; Lee's phone can when it is; the office marks the day done for them
  if (day === plan.today) {
    const on = await lPhone.tap('crewSignOn', { item: wk.id });
    expect(on.message).toMatch(/signed on at Bondi/);
    expect((await get('/api/dispatch?day=' + day)).people.workers[0].onSite).toBe(2);
    expect((await cmd('planDone', { id: wk.id })).item.status).toBe('DONE');
  } else expect(await lPhone.refused('crewSignOn', { item: wk.id })).toBe(409); // not its day yet
  // a bring-back: collected 12, back 10; counted short, then every missing piece gets an outcome (one charged at the replacement value)
  const back = (await cmd('bringBackCreate', { site: site.id, lines: [{ product: product.id, quantity: 12 }] })).order;
  const coll = (await cmd('tripBook', { orders: [back.id], truckPlan: tb.id })).trip;
  await dPhone.tap('tripCollected', { trip: coll.id });
  const ret = await dPhone.tap('tripReturned', { trip: coll.id, lines: [{ product: product.id, quantity: 10 }] });
  expect(ret.trip.stateWords).toBe('Back at yard, 2 pieces not counted back');
  expect(ret.trip.notBack).toEqual([{ product: product.id, quantity: 2 }]);
  const refused = await desk.post('/api/commands/returnResolve', {
    data: { trip: coll.id, lines: [{ product: product.id, quantity: 1, outcome: 'LOST' }] },
    headers: { 'Idempotency-Key': key() },
  });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toMatch(/no replacement value yet/);
  await cmd('productValue', { product: product.id, replacementValue: 4250 });
  const resolved = await cmd('returnResolve', {
    trip: coll.id,
    lines: [
      { product: product.id, quantity: 1, outcome: 'STILL_ON_SITE' },
      { product: product.id, quantity: 1, outcome: 'LOST', reason: 'Fell off' },
    ],
  });
  expect(resolved.message).toMatch(/hire continues/);
  expect(resolved.message).toMatch(/charged at \$42\.50/);
  expect(resolved.trip.notBack).toEqual([]);
  const account = await get('/api/site-account?site=' + site.id);
  expect([account.sent, account.back, account.onSite, account.charged, account.unaccounted]).toEqual([12, 10, 1, 1, 0]);
  expect(account.charges[0].amount).toBe(4250);
  expect((await get('/api/state')).liveBoard.sites[site.id].pieces).toBe(1);
  // Move the day: everything of a day to another, all or nothing
  const other = dayAfter(day, 2);
  const moveDay = (await cmd('planTruck', { day: other, time: '09:00', truck: truck.id, driver: dave.id })).item;
  const target = dayAfter(other, 7);
  const moved = await cmd('planMoveDay', { from: other, to: target });
  expect(moved.moved).toBeGreaterThanOrEqual(1);
  expect((await get('/api/plan?month=' + target.slice(0, 7))).items.find((i) => i.id === moveDay.id).day).toBe(target);
  for (const p of [dPhone, kPhone, lPhone, jPhone]) await p.dispose();
  await desk.dispose();
});
