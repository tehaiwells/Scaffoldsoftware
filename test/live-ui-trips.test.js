process.env.TZ = 'Australia/Sydney';
// A real yard's trips on screen (ADR 0009): the driver's phone page, the office's trip card and booking, the board's Book window. The pages'
// pure render functions, fed with the server's own views of real trips (a LIVE fixture driven by commands, never a tick).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Simulation } from '../src/simulation.js';
import { addDays } from '../src/domain/schedule.js';
import { crewLink, crewClaim, crewAuthenticate } from '../src/crew-auth.js';
import { crewPage, crewButtons, crewDay, crewTrip, conflictWords } from '../public/crew.js';
import { loDocket, loSteps, loSuggestTime, loBookHTML, __lo } from '../public/live-office.js';
import { glBookHTML, glFirst, glAmountHTML, glSuggestTime } from '../public/game-live.js';
import { liveFixture, D0 } from './helpers/live-fixture.js';

function setup(t) {
  const f = liveFixture(t);
  const made = crewLink(f.auth, f.user, { driver: f.team.Dave.id });
  const user = crewAuthenticate(f.db, crewClaim(f.auth, { token: made.token }).token);
  const sim = new Simulation(f.db, user);
  const dave = (a, i) => sim.execute(a, i, randomUUID());
  const book = (quantity, extra = {}) => {
    const o = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity }] }).order;
    return f.cmd('tripBook', { orders: [o.id], truck: f.truck.id, driver: f.team.Dave.id, ...extra }).trip;
  };
  const me = () => sim.crewTrips();
  return { f, sim, dave, book, me };
}

test("the driver's phone: one big button for the next step; a load not delivered can come back; a finished trip is one line under Done", (t) => {
  const { dave, book, me } = setup(t);
  const trip = book(6);
  dave('tripLoaded', { trip: trip.id });
  let view = me().trips[0];
  assert.deepEqual(crewButtons(view), {
    main: 'tripDelivered',
    soft: 'tripReturned',
    softLabel: 'Came back, not delivered',
  });
  let html = crewPage({ me: me(), pending: [] });
  assert.match(html, /class="cr-big" data-cr-go="tripDelivered"/);
  assert.match(html, /class="cr-big cr-soft" data-cr-go="tripReturned"[^>]*>Came back, not delivered</);
  // the "came back" form says so, and its button too
  html = crewPage({ me: me(), pending: [], open: { trip: trip.id, action: 'tripReturned' } });
  assert.match(html, /The site did not take it\?/);
  assert.match(html, /<button type="submit" class="cr-big">Back at yard, not delivered</);
  // delivered in full: no big button, one line under "Done", with the courtesy "Truck back at yard (when you are back)"
  dave('tripDelivered', { trip: trip.id, receivedBy: 'Jarrah Smith' });
  view = me().trips[0];
  assert.deepEqual(crewButtons(view), { main: null, soft: 'tripReturned', softLabel: 'Truck back at yard' });
  html = crewPage({ me: me(), pending: [] });
  assert.match(html, /<h2 class="cr-day">Done<\/h2><article class="cr-card is-done cr-one"/);
  assert.match(html, /<small>Delivered \d\d:\d\d · Jarrah Smith<\/small>/);
  assert.match(html, /Truck back at yard <small>\(when you are back\)<\/small>/);
  assert.ok(!/class="cr-big"[^>]*data-cr-go/.test(html), 'no big button on a finished trip');
});

test('the phone, offline: a waiting full delivery keeps Back at yard quiet; a short one makes it the next step', (t) => {
  const { dave, book, me } = setup(t);
  const trip = book(6);
  dave('tripLoaded', { trip: trip.id });
  const base = me().trips[0];
  const full = crewTrip(base, [
    { action: 'tripDelivered', input: { trip: trip.id, receivedBy: 'Jo' }, tappedAt: new Date().toISOString() },
  ]);
  assert.equal(crewButtons(full).main, null, 'waiting full delivery: nothing big to tap');
  const short = crewTrip(base, [
    {
      action: 'tripDelivered',
      input: { trip: trip.id, receivedBy: 'Jo', lines: [{ product: base.lines[0].product, quantity: 4 }] },
      tappedAt: new Date().toISOString(),
    },
  ]);
  assert.equal(crewButtons(short).main, 'tripReturned', 'pieces still on the truck: Back at yard is next');
});

test('the phone: "Received by" is never filled in; last time\'s name is a chip; a conflict with the office is said plainly; signed out once', (t) => {
  const { f, dave, book, me } = setup(t);
  const trip = book(5);
  dave('tripLoaded', { trip: trip.id });
  const html = crewPage({
    me: me(),
    pending: [],
    open: { trip: trip.id, action: 'tripDelivered' },
    rcv: '',
    lastRcv: 'Jarrah Smith',
  });
  assert.match(html, /name="receivedBy"[^>]*value=""/);
  assert.match(html, /<button type="button" class="cr-chip" data-cr-rcv="Jarrah Smith">Jarrah Smith again\?<\/button>/);
  // the office recorded Delivered 5, Site foreman; the phone had said 4, Mo Ali
  const p = {
    action: 'tripDelivered',
    input: { trip: trip.id, receivedBy: 'Mo Ali', lines: [{ product: f.product.id, quantity: 4 }] },
    conflict: {
      same: false,
      recorded: { receivedBy: 'Site foreman', lines: [{ product: f.product.id, name: 'Standard', quantity: 5 }] },
      said: { lines: [] },
    },
  };
  const words = conflictWords(p, me());
  assert.match(words, /The office already recorded Delivered for Bondi:<\/b> 5 × Standard, received by Site foreman\./);
  assert.match(words, /You said 4 × .*, Mo Ali\. Call the office\./);
  assert.match(crewPage({ me: me(), problems: [p] }), /class="cr-problem" role="alert"/);
  // signed out: said once, and the taps waiting are not forgotten
  const out = crewPage({
    notSigned: 'This phone is not signed in. Ask the office for a link.',
    pending: [{ action: 'tripDelivered', input: { trip: trip.id } }],
  });
  assert.equal(out.match(/not signed in/g).length, 1);
  assert.match(out, /1 tap on this phone is waiting\. They send once you sign in again\./);
});

test("the phone groups a trip by the day it was done: booked for tomorrow, done today, is today's", (t) => {
  const { f, dave, book, me } = setup(t);
  const trip = book(3, { day: addDays(D0, 1) });
  assert.equal(crewDay(me().trips[0]), addDays(D0, 1));
  // packed tonight for tomorrow (the office, for the yard): still tomorrow's on the driver's phone
  f.cmd('packConfirmed', { trip: trip.id });
  assert.equal(crewDay(me().trips[0]), addDays(D0, 1));
  dave('tripLoaded', { trip: trip.id });
  assert.equal(crewDay(me().trips[0]), D0);
});

test('the office: the docket says what a short send still owes; a step says who received it and who confirmed it; Send again', (t) => {
  const { f, book } = setup(t);
  const trip = book(12);
  f.cmd('tripLoaded', { trip: trip.id, lines: [{ product: f.product.id, quantity: 11 }] });
  f.cmd('tripDelivered', { trip: trip.id, receivedBy: 'Jarrah Smith' });
  const view = f.sim.tripsView().trips[0];
  const docket = loDocket(view);
  assert.match(docket, /<p class="lo-warn">Short 1 × .*: still to send\.<\/p>/);
  const steps = loSteps(view);
  assert.match(steps, /received by Jarrah Smith <small>· recorded by Tee for Dave<\/small>/);
  assert.ok(!/received by Jarrah Smith by /.test(steps), 'never "by ... by"');
  // a load that came back not delivered offers Send again
  const back = book(4);
  f.cmd('tripLoaded', { trip: back.id });
  f.cmd('tripReturned', { trip: back.id });
  const card = f.sim.tripsView().trips.find((x) => x.id === back.id);
  assert.equal(card.stateWords, 'Came back, not delivered');
  assert.equal(card.undelivered, true);
});

test("booking a truck: a time is asked (7:00 am first, an hour after the truck's last trip next); bring-backs say Collected and Back at yard", (t) => {
  const { f, book } = setup(t);
  const day = addDays(D0, 1);
  assert.equal(glSuggestTime([], f.truck.id, day, D0), '07:00');
  book(2, { day, time: '08:30' });
  const trips = f.sim.tripsView({ day }).trips;
  assert.equal(glSuggestTime(trips, f.truck.id, day, D0), '09:30');
  assert.equal(loSuggestTime(trips, f.truck.id, day, D0), '09:30');
  // today: never a time already gone. The clock is the company's ('HH:MM' from the server), never the browser's, which may sit in another zone
  assert.equal(glSuggestTime([], f.truck.id, D0, D0, '09:10'), '09:30', 'today: never a time already gone');
  assert.equal(loSuggestTime([], f.truck.id, D0, D0, '16:50'), '17:00');
  assert.equal(
    glSuggestTime([], f.truck.id, D0, D0, '18:20'),
    '17:00',
    'after the last time: the last time (the day is over: tomorrow is offered)',
  );
  // the server sends the company's clock with the trips and the board, so a UTC browser (a GitHub runner, a hosted server) books the right day
  f.clock(D0, '18:20');
  const tv = f.sim.tripsView({ day: D0 });
  assert.equal(tv.now, '18:20');
  assert.equal(tv.dayOver, true, 'after 5 pm company time the day is over');
  const lb = f.sim.snapshot(0, { lean: true }).liveBoard;
  assert.equal(lb.hm, '18:20');
  assert.equal(lb.dayOver, true);
  f.clock(D0, '09:10');
  assert.equal(f.sim.tripsView({ day: D0 }).dayOver, false);
  assert.equal(f.sim.snapshot(0, { lean: true }).liveBoard.dayOver, false);
  const s = f.sim.snapshot(0, { lean: true });
  const team = f.sim.teamView ? f.sim.teamView() : { people: [{ id: f.team.Dave.id, name: 'Dave', kind: 'driver' }] };
  const o = f.cmd('bringBackCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 1 }] }).order;
  const html = glBookHTML({ order: o, trips: { [day]: trips }, day }, s, team, D0);
  assert.match(html, /<select name="time">/);
  assert.match(html, /<option value="09:30" selected>9:30 am<\/option>/);
  assert.match(html, /The driver confirms Collected and Back at yard on their phone\./);
  assert.match(html, /B-1 from Bondi/);
  const send = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 1 }] }).order;
  assert.match(glBookHTML({ order: send }, s, team, D0), /Loaded &amp; left and Delivered/);
  // the day the form starts on follows the company's clock the server sends (liveBoard.dayOver), whatever zone the browser is in
  const over = { ...s, liveBoard: { ...(s.liveBoard ?? {}), today: D0, hm: '18:20', dayOver: true } },
    early = { ...s, liveBoard: { ...(s.liveBoard ?? {}), today: D0, hm: '09:10', dayOver: false } };
  assert.match(
    glBookHTML({ order: send }, over, team, D0),
    new RegExp('value="' + addDays(D0, 1) + '"[^>]*checked'),
    'day over: tomorrow',
  );
  assert.match(
    glBookHTML({ order: send }, early, team, D0),
    new RegExp('value="' + D0 + '"[^>]*checked'),
    'day not over: today',
  );
  assert.match(glBookHTML({ order: send }, early, team, D0), /Today: too late|Today/);
  __lo.reset();
  Object.assign(__lo.state, {
    host: { state: () => s },
    team,
    teamAt: Date.now(),
    book: { order: send.id, truck: f.truck.id, driver: f.team.Dave.id, day, time: '09:30' },
  });
  const office = loBookHTML(send, day);
  assert.match(office, /<select data-lo-b="time">/);
  assert.match(office, /<option value="09:30" selected>9:30 am<\/option>/);
  __lo.reset();
  __lo.state.host = null;
});

test('the board picker: Bring back starts at all that is on the site, in exact pieces, with no "Round to a pack"', () => {
  const item = { product: 'p', free: 37, pack: 25 };
  assert.equal(glFirst(item), 25, 'Send: one pack');
  assert.equal(glFirst(item, 'back'), 37, 'Bring back: all of it');
  const back = glAmountHTML({ name: 'Ledger' }, 37, item, 'back', '');
  assert.ok(!back.includes('data-gm-pack'), 'no Round to a pack on a bring-back');
  assert.match(back, /what the driver collects/);
  assert.match(glAmountHTML({ name: 'Ledger' }, 30, item, 'send', ''), /30 is kept exactly/);
});
