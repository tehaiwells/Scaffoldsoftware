import { test, expect, request as playwrightRequest } from '@playwright/test';
// Phase 1A part 2 (ADR 0009), through the running server only (the pages come with the crew page and the LIVE board's Send): the office
// orders exact pieces for a site and books a truck and driver; the driver's phone opens its link and confirms Loaded & left and Delivered;
// the board's data shows the truck at the site with the delivery to replay; hire starts on the delivered day.
const key = () => 'e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2);
test('order, truck and driver; the phone confirms Loaded & left and Delivered; the board and hire follow', async ({
  baseURL,
}) => {
  const desk = await playwrightRequest.newContext({ baseURL }),
    phone = await playwrightRequest.newContext({ baseURL });
  const cmd = async (action, data) => {
    const r = await desk.post('/api/commands/' + action, { data, headers: { 'Idempotency-Key': key() } });
    expect(r.status(), action + ': ' + (await r.text())).toBe(200);
    return r.json();
  };
  const reg = await desk.post('/api/register', {
    data: {
      companyName: 'Tee Scaffolding',
      name: 'Tee',
      email: `trips-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'Local-demo-test-2026!',
      systems: ['quickstage'],
      mode: 'LIVE',
    },
  });
  expect(reg.status()).toBe(200);
  const { yard } = await cmd('gameStart', { size: 'S' });
  await cmd('gameCatalogue', {});
  const state = await (await desk.get('/api/state')).json();
  const product = state.products.find((p) => p.unitWeight > 0 && !p.retired);
  await cmd('gameAddStock', { lines: [{ product: product.id, quantity: 40 }] });
  const site = (await cmd('gameSite', { name: 'Bondi', address: '1 Campbell Parade, Bondi' })).site;
  const truck = await cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: yard.id });
  const dave = (await cmd('teamAdd', { name: 'Dave', role: 'DRIVER', mobile: '0412 345 678' })).person;
  // the picker's numbers, and an order kept exactly as typed
  const items = await (await desk.get('/api/live-items?loc=' + yard.id)).json();
  expect(items.items.find((i) => i.product === product.id).free).toBe(40);
  const order = (
    await cmd('orderCreate', { site: site.id, lines: [{ product: product.id, quantity: 13 }], source: 'board' })
  ).order;
  expect(order.lines[0].requested).toBe(13);
  expect(order.lines[0].held).toBe(13);
  // today, or tomorrow once today's bookings have closed at 5 pm (the confirmations are recorded now either way)
  let booked = await desk.post('/api/commands/tripBook', {
    data: { orders: [order.id], truck: truck.id, driver: dave.id },
    headers: { 'Idempotency-Key': key() },
  });
  if (booked.status() === 409 && /nearly over|has passed/.test((await booked.json()).error)) {
    const today = (await (await desk.get('/api/trips')).json()).today;
    const next = new Date(today + 'T12:00:00Z');
    next.setUTCDate(next.getUTCDate() + 1);
    booked = await desk.post('/api/commands/tripBook', {
      data: { orders: [order.id], truck: truck.id, driver: dave.id, day: next.toISOString().slice(0, 10) },
      headers: { 'Idempotency-Key': key() },
    });
  }
  expect(booked.status(), await booked.text()).toBe(200);
  const trip = (await booked.json()).trip;
  expect(trip.state).toBe('BOOKED');
  // the link for Dave's phone: Copy link, Text it, and a plain word about reaching this computer
  const link = await desk.post('/api/crew-links', { data: { driver: dave.id } });
  expect(link.status()).toBe(201);
  const made = await link.json();
  expect(made.sms).toMatch(/^sms:\+61412345678\?&body=/);
  expect(typeof made.reach).toBe('string');
  const token = new URL(made.link).hash.slice(3);
  expect((await phone.post('/api/crew/claim', { data: { token, label: 'Test phone' } })).status()).toBe(200);
  const mine = await (await phone.get('/api/crew/me')).json();
  expect(mine.trips.map((t) => t.id)).toEqual([trip.id]);
  expect(mine.trips[0].next).toEqual(['tripLoaded']);
  // the phone: Loaded & left, then Delivered (received by), one key per tap
  const tap = async (action, data) => {
    const r = await phone.post('/api/crew/commands/' + action, { data, headers: { 'Idempotency-Key': key() } });
    expect(r.status(), action + ': ' + (await r.text())).toBe(200);
    return r.json();
  };
  expect((await tap('tripLoaded', { trip: trip.id })).trip.stateWords).toBe('Loaded, not delivered yet');
  let board = (await (await desk.get('/api/state')).json()).liveBoard;
  expect(board.trucks[0].state).toBe('TO_SITE');
  expect(board.trucks[0].words).toMatch(/^Left \d\d:\d\d · usually ~30 min$/);
  const done = await tap('tripDelivered', { trip: trip.id, receivedBy: 'J. Smith' });
  expect(done.message).toMatch(/^Delivered \d\d:\d\d · received by J\. Smith$/);
  board = (await (await desk.get('/api/state')).json()).liveBoard;
  expect(board.trucks[0].state).toBe('AT_SITE');
  expect(board.trucks[0].place).toBe(site.id);
  expect(board.replays.map((r) => r.step)).toContain('DELIVERED');
  expect(board.sites[site.id].pieces).toBe(13);
  // the office sees who confirmed what (the driver, not the office), and hire runs from the delivered day
  const trips = await (await desk.get('/api/trips?day=' + trip.day)).json();
  const t = trips.trips.find((x) => x.id === trip.id);
  expect(t.steps.DELIVERED.kind).toBe('PERSON');
  expect(t.steps.DELIVERED.receivedBy).toBe('J. Smith');
  const hire = await (await desk.get(`/api/hire?site=${site.id}`)).json();
  expect(hire.statement.onHireNow).toBe(13);
  expect(hire.statement.pieceDays).toBe(13); // on hire from today, the day it was delivered
  await desk.dispose();
  await phone.dispose();
});
