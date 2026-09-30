process.env.TZ = 'Australia/Sydney';
// Phase 1A part 3 on screen (ADR 0010): the pages' pure render functions fed with the server's own views of a real yard driven only by
// commands and the people's phones (never a tick). The phone page for a driver, a worker, a yard hand and a leading hand; the Today
// item card's Draft, Send, On site and Done; the Needs-you card (at most five, a dismissal with a reason); the Dispatch lanes and their
// dots; the run sheet; the count and the four outcomes; quarantine; the site-finish question; the owner's values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Simulation } from '../src/simulation.js';
import { addDays } from '../src/domain/schedule.js';
import { crewLink, crewClaim, crewAuthenticate } from '../src/crew-auth.js';
import { crewPage, crewTitle, askCard, gangCard, packCard, returnCard, taskCard } from '../public/crew.js';
import { ltNeedsHTML, ltLanesHTML, ltSheetHTML, ltToolsHTML, ltChipHTML, __lt } from '../public/live-today.js';
import {
  lrTripExtraHTML,
  lrQuarantineHTML,
  lrQuarantineLines,
  lrFinishHTML,
  lrValuesHTML,
  lrParsePaste,
  lrCents,
  lrMoney,
  lrIntakeFieldsHTML,
  __lr,
} from '../public/live-returns.js';
import { loSetup, loTripHTML, __lo } from '../public/live-office.js';
import { liveFixture, D0 } from './helpers/live-fixture.js';
const D1 = addDays(D0, 1);
function phone(f, person) {
  const made = crewLink(f.auth, f.user, { person: person.id });
  const claimed = crewClaim(f.auth, { token: made.token, label: 'Test phone' });
  const user = crewAuthenticate(f.db, claimed.token);
  const sim = new Simulation(f.db, user);
  return { sim, cmd: (a, i = {}, key = randomUUID()) => sim.execute(a, i, key), me: () => sim.crewMe() };
}
// a booked day: T-01 with Dave, a list for Bondi on it, Lee (leading hand) and Jo to Bondi, a re-stack; everyone asked at once (it is past 3 pm)
function day(t) {
  const f = liveFixture(t);
  f.clock(D0, '15:30');
  const lee = f.cmd('teamAdd', { name: 'Lee', role: 'LEADING_HAND' }).person;
  const tb = f.cmd('planTruck', { day: D1, time: '07:00', truck: f.truck.id, driver: f.team.Dave.id }).item;
  const list = f.cmd('planMaterials', {
    day: D1,
    time: '07:00',
    site: f.site.id,
    lines: [{ product: f.product.id, quantity: 12 }],
    truckPlan: tb.id,
  }).item;
  const wk = f.cmd('planWorkers', {
    day: D1,
    time: '07:00',
    site: f.site.id,
    count: 2,
    people: [lee.id, f.team.Jo.id],
  }).item;
  const rs = f.cmd('planRestack', { day: D1, time: '13:00' }).item;
  const trip = f.sim.repo.all('trip').find((x) => x.truckPlan === tb.id);
  return { f, lee, tb, list, wk, rs, trip };
}
const host = (f, extra = {}) => ({
  get: async () => ({}),
  cmd: async () => ({}),
  notify() {},
  redraw() {},
  refresh: async () => {},
  state: () => f.sim.snapshot(),
  owner: () => true,
  ...extra,
});

test('the phones: a driver sees his ask with I’ll be there / Can’t make it; a worker her own; a yard hand the list to pack; a leading hand the gang on the day', (t) => {
  const { f, lee, wk, trip } = day(t);
  const dave = phone(f, f.team.Dave),
    jo = phone(f, f.team.Jo),
    kev = phone(f, f.team.Kev),
    leeP = phone(f, lee);
  // the driver: "My trips", the ask first, his trip for tomorrow under it
  let html = crewPage({ me: dave.me(), pending: [] });
  assert.equal(crewTitle(dave.me()), 'My trips, Dave');
  assert.match(html, /<h2 class="cr-day">Can you make it\?<\/h2>/);
  assert.match(html, /data-cr-yes="[^"]+">I’ll be there</);
  assert.match(html, /data-cr-no="[^"]+">Can’t make it</);
  assert.ok(html.indexOf('Can you make it?') < html.indexOf('Tomorrow'), 'the ask comes before the trips');
  // the worker: "My day", her ask only (not Lee's), no trips section
  const jm = jo.me();
  assert.equal(crewTitle(jm), 'My day, Jo');
  assert.equal(jm.asks.length, 1);
  assert.equal(jm.can.trips, false);
  html = crewPage({ me: jm, pending: [] });
  assert.match(html, /Work at Bondi/);
  assert.ok(!/No trips for you today/.test(html));
  assert.match(html, /Check for new asks/);
  // a tap waiting on the phone shows as her answer, sending
  const pend = [{ key: 'tap-1', action: 'messageAnswer', input: { id: jm.asks[0].id, yes: false, reason: 'Crook' } }];
  html = askCard(jm.asks[0], { pending: pend, offline: true });
  assert.match(html, /Can’t make it: Crook · saved, sends when there is signal/);
  assert.ok(!/data-cr-yes/.test(html), 'no buttons once answered');
  // she answers yes on her own phone: her card says so, the office sees PHONE
  jo.cmd('messageAnswer', { id: jm.asks[0].id, yes: true });
  html = crewPage({ me: jo.me(), pending: [] });
  assert.match(html, /You said yes, see you there/);
  assert.equal(f.sim.repo.get(jm.asks[0].id, 'message').answer.via, 'PHONE');
  // the yard hand: the list to pack with counts, and the Packed form
  const km = kev.me();
  assert.equal(crewTitle(km), 'My day, Kev');
  assert.equal(km.packs.length, 1);
  html = crewPage({ me: km, pending: [] });
  assert.match(html, /<h2 class="cr-day">Lists to pack<\/h2>/);
  assert.match(html, /data-cr-pack="/);
  html = packCard(km.packs[0], { me: km, pending: [], open: { pack: trip.id }, draft: {} });
  assert.match(html, /data-cr-pack-form="/);
  assert.match(html, /value="12"/);
  html = packCard(km.packs[0], { me: km, pending: [{ action: 'packConfirmed', input: { trip: trip.id } }] });
  assert.match(html, /Packed · sending…/);
  // the leading hand: the gang on its day only (tomorrow is not yet), then On site and Day done
  assert.equal(leeP.me().gang.length, 0, 'the gang shows on the day');
  f.clock(D1, '06:50');
  const lm = leeP.me();
  assert.equal(lm.gang.length, 1);
  html = gangCard(lm.gang[0], { pending: [] });
  assert.match(html, /Your gang at Bondi/);
  assert.match(html, /data-cr-on="/);
  assert.ok(!/data-cr-done/.test(html), 'Day done waits until someone is on site');
  html = gangCard(lm.gang[0], { pending: [], open: { gang: wk.id } });
  assert.match(html, /data-cr-who="[^"]+" checked/); // Jo said yes: ticked
  leeP.cmd('crewSignOn', { item: wk.id, people: [f.team.Jo.id, lee.id] });
  html = gangCard(leeP.me().gang[0], { pending: [] });
  assert.match(html, /2 of 2 on site/);
  assert.match(html, /data-cr-done="/);
  const it = f.item(wk.id);
  assert.equal(it.people.find((p) => p.person === f.team.Jo.id).signOn.kind, 'PERSON');
  // the yard hand on the day: the re-stack with one Done tap
  const km2 = kev.me();
  assert.equal(km2.tasks.length, 1);
  html = taskCard(km2.tasks[0], { pending: [] });
  assert.match(html, /Re-stack the yard/);
  assert.match(html, /data-cr-done="/);
});

test('Today’s item card in a real yard: Draft with Send, On site and Day done for the office, Done on a re-stack, the person’s own yes', async (t) => {
  const { f, wk, rs } = day(t);
  const m = await import('../public/operations.js');
  const { __test: T, tdTest: td } = m;
  const acct = () => ({
    permissions: ['company.manage', 'operations.manage', 'stock.adjust', 'finance.view', 'requests.create'],
    systems: [],
    users: [],
    company: { id: f.company, name: 'Tee Scaffolding', mode: 'LIVE' },
    user: { id: f.user.id, name: 'Tee' },
  });
  const draft = f.cmd('planTruck', { day: addDays(D0, 3), time: '09:00', truck: f.truck.id, draft: true }).item;
  const show = (sel) => {
    td.reset();
    T.setState(f.sim.snapshot(), acct());
    T.setView('TODAY');
    td.setData(f.sim.planMonth(D0.slice(0, 7)), f.sim.todayView());
    td.select(sel);
    return td.view();
  };
  let html = show(addDays(D0, 3));
  assert.match(html, /tdh-state draft">Draft</);
  assert.match(html, /Draft: sent to nobody yet/);
  assert.ok(html.includes('data-tdh-send="' + draft.id + '"'), 'Send on the draft');
  // Re-stack is offered in a real yard, with the draft toggle on the form
  assert.match(html, /data-tdh-add="RESTACK"/);
  td.openForm('WORKERS', addDays(D0, 3));
  html = td.view();
  assert.match(html, /name="draft"/);
  assert.match(html, /Just a draft for now/);
  // Dave says yes on his own phone (before the time): the card says so
  const dave = phone(f, f.team.Dave);
  dave.cmd('messageAnswer', { id: dave.me().asks.find((a) => a.canAnswer).id, yes: true });
  html = show(D1);
  assert.match(html, /Said yes on their phone/);
  // its day: On site (nobody has arrived) and no Day done yet
  f.clock(D1, '07:10');
  html = show(D1);
  assert.match(html, new RegExp('data-tdh-mini="' + wk.id + '\\|onsite"'));
  assert.ok(!html.includes('data-tdh-done="' + wk.id + '"'), 'Day done waits for someone on site');
  assert.match(html, new RegExp('data-tdh-done="' + rs.id + '"'));
  td.mini(wk.id, 'onsite');
  html = td.view();
  assert.match(html, /Who is on site at Bondi\?/);
  assert.match(html, /name="people"/);
  // the office signs Jo on for them: recorded by the office, said so on the card
  f.cmd('crewSignOn', { item: wk.id, people: [f.team.Jo.id] });
  html = show(D1);
  assert.match(html, /At Bondi · recorded by Tee/);
  assert.match(html, new RegExp('data-tdh-done="' + wk.id + '"'));
  // the office marks the re-stack done: recorded by the office
  f.cmd('planDone', { id: rs.id });
  html = show(D1);
  assert.match(html, /Done \(recorded by Tee\)/);
});

test('Needs you: the card shows at most five with one action each, the chip counts, a dismissal with a reason hides one', (t) => {
  const { f } = day(t);
  __lt.reset();
  const yesterday = addDays(D0, -1);
  for (let i = 0; i < 6; i++)
    f.cmd('paperworkAdd', { type: 'PERMIT', title: 'Permit ' + i, site: f.site.id, expiresOn: yesterday });
  const needs = f.sim.needsYou();
  assert.equal(needs.count, 6);
  assert.equal(needs.items.length, 5);
  let html = ltNeedsHTML(needs, { ops: true, today: D0 });
  assert.equal((html.match(/class="lt-need /g) ?? []).length, 5);
  assert.match(html, /Needs you · 6/);
  assert.match(html, /and 1 more thing after these/);
  assert.match(html, /data-lt-act="[^"]+">Renew</);
  assert.match(html, /data-lt-dismiss="/);
  assert.match(ltChipHTML(needs), /Needs you · 6/);
  assert.equal(ltChipHTML({ count: 0 }), '');
  __lt.dismiss(needs.items[0].id);
  html = ltNeedsHTML(needs, { ops: true, today: D0 });
  assert.match(html, /data-lt-dismiss-form="/);
  assert.match(html, /Why put it aside\?/);
  f.cmd('needsYouDismiss', { id: needs.items[0].id, reason: 'Renewed on paper' });
  const after = f.sim.needsYou();
  assert.equal(after.count, 5);
  assert.ok(!after.items.some((x) => x.id === needs.items[0].id));
  html = ltNeedsHTML({ count: 0, items: [], more: 0, cap: 5 }, { ops: true, today: D0 });
  assert.match(html, /Nothing needs you/);
  assert.ok(!/data-lt-act/.test(html));
});

test('the Dispatch lanes: one lane per truck, a dot per trip from the records, unconfirmed first, the day’s people; the tools', (t) => {
  const { f, tb, trip } = day(t);
  __lt.reset();
  let d = f.sim.dispatchView({ day: D1 });
  let html = ltLanesHTML(d, { ops: true });
  assert.match(html, /<h2 id="lt-lanes-h">Dispatch lanes<\/h2>/);
  assert.equal((html.match(/class="lt-lane[ "]/g) ?? []).length, 1);
  assert.match(html, /lt-dot dot-asked/);
  assert.match(html, /Trip 1 → Bondi/);
  assert.match(html, /Asked, waiting/);
  assert.match(html, /Lists to pack<\/b><span class="tdh-pill wait">1</);
  assert.ok(!/Not booked: /.test(html), 'the one truck is booked');
  // the driver says yes on his phone, the yard packs on theirs: the dots follow, nothing else moved them
  const dave = phone(f, f.team.Dave),
    kev = phone(f, f.team.Kev);
  dave.cmd('messageAnswer', { id: dave.me().asks.find((a) => a.canAnswer).id, yes: true });
  d = f.sim.dispatchView({ day: D1 });
  assert.equal(d.lanes[0].trips[0].dot, 'YES');
  kev.cmd('packConfirmed', { trip: trip.id });
  d = f.sim.dispatchView({ day: D1 });
  html = ltLanesHTML(d, { ops: true });
  assert.match(html, /lt-dot dot-packed/);
  assert.match(html, /Packed, waiting for the truck<\/b><span class="tdh-pill yes">1</);
  // a second lane with nothing confirmed at its time sorts first
  f.clock(D1, '09:30');
  const l2 = f.cmd('teamAdd', { name: 'Mick', role: 'DRIVER' }).person;
  const t2 = f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id });
  f.cmd('planTruck', { day: D1, time: '10:00', truck: t2.id, driver: l2.id });
  dave.cmd('tripLoaded', { trip: trip.id });
  d = f.sim.dispatchView({ day: D1 });
  html = ltLanesHTML(d, { ops: true });
  assert.match(html, /lt-dot dot-road/);
  assert.equal(d.lanes.length, 2);
  // the tools: Day / Dispatch lanes, Move the day, Copy yesterday's crews, Print run sheets; a past day keeps only Print
  html = ltToolsHTML(D1, D1, { ops: true });
  assert.match(html, /data-lt-mode="lanes"/);
  assert.match(html, /data-lt-tool="move"/);
  assert.match(html, /data-lt-tool="copy"/);
  assert.match(html, /data-lt-tool="print"/);
  html = ltToolsHTML(D0, D1, { ops: true });
  assert.ok(!/data-lt-tool="move"/.test(html));
  assert.equal(ltToolsHTML(D1, D1, { ops: false }), '');
  __lt.tool('move');
  html = ltToolsHTML(D1, D1, { ops: true });
  assert.match(html, /data-lt-form="move"/);
  assert.match(html, /Trucks, lists and workers go together, or nothing moves/);
  // the run sheet: one page per driver with the trips in order, the site, the address and the load
  const sheet = f.sim.runSheet({ day: D1 });
  html = ltSheetHTML(sheet);
  assert.equal((html.match(/class="lt-sheet"/g) ?? []).length, 2);
  assert.match(html, /Dave · T-01/);
  assert.match(html, /Deliver to Bondi/);
  assert.match(html, /1 Campbell Parade, Bondi/);
  assert.match(html, /12 × /);
  assert.match(html, /Driver’s signature/);
  assert.equal(tb.id, sheet.sheets.find((s) => s.driver.name === 'Dave').booking);
});

test('Back & counted on the trip card: Count later, the count, then an outcome for every missing piece; quarantine; the owner’s values', (t) => {
  const { f, tb } = day(t);
  __lo.reset();
  __lr.reset();
  loSetup(host(f));
  const dave = phone(f, f.team.Dave);
  f.clock(D1, '06:30');
  const back = f.cmd('bringBackCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity: 12 }] }).order;
  // first something must be at the site: a delivered trip
  const out = f.sim.repo.all('trip').find((x) => x.truckPlan === tb.id);
  f.cmd('packConfirmed', { trip: out.id });
  dave.cmd('tripLoaded', { trip: out.id });
  dave.cmd('tripDelivered', { trip: out.id, receivedBy: 'J. Smith' });
  dave.cmd('tripReturned', { trip: out.id });
  const coll = f.cmd('tripBook', { orders: [back.id], truckPlan: tb.id }).trip;
  dave.cmd('tripCollected', { trip: coll.id });
  // the office's Back at yard form offers Count later
  let v = f.sim.tripView(f.sim.repo.get(coll.id, 'trip'));
  __lo.setDay(D1, { day: D1, today: D1, trips: [v], orders: [], upcoming: [] });
  __lo.open(coll.id, 'tripReturned');
  let html = loTripHTML(v, { ops: true, day: D1 });
  assert.match(html, /data-lr-later="/);
  assert.match(html, />Back, count later</);
  f.cmd('tripReturned', { trip: coll.id, countLater: true });
  v = f.sim.tripView(f.sim.repo.get(coll.id, 'trip'));
  assert.equal(v.countPending, true);
  __lo.reset();
  html = lrTripExtraHTML(v, { ops: true });
  assert.match(html, /Back at the yard, not counted yet/);
  assert.match(html, /data-lr-count="/);
  __lr.open(coll.id, 'count');
  html = lrTripExtraHTML(v, { ops: true });
  assert.match(html, /data-lr-count-form="/);
  assert.match(html, /12 collected/);
  // the yard hand counts 10 back on her phone: 2 not back, an outcome each
  const kev = phone(f, f.team.Kev);
  const km = kev.me();
  assert.equal(km.returns.length, 1);
  html = returnCard(km.returns[0], { pending: [] });
  assert.match(html, /Count it/);
  kev.cmd('returnCount', { trip: coll.id, lines: [{ product: f.product.id, quantity: 10 }] });
  v = f.sim.tripView(f.sim.repo.get(coll.id, 'trip'));
  assert.deepEqual(v.notBack, [{ product: f.product.id, quantity: 2 }]);
  __lr.reset();
  html = lrTripExtraHTML(v, { ops: true });
  assert.match(html, /2 pieces not back\. Say what happened to them\./);
  assert.match(html, /data-lr-resolve="/);
  // the resolution form: one line per missing product, the four outcomes, Lost needs a value when the part has none
  __lr.open(coll.id, 'resolve', [
    { product: f.product.id, missing: 2, quantity: 1, outcome: 'LOST', reason: '', unitValue: '' },
    { product: f.product.id, missing: 1, quantity: 1, outcome: 'STILL_ON_SITE', reason: '', unitValue: '' },
  ]);
  html = lrTripExtraHTML(v, { ops: true });
  assert.match(html, /data-lr-resolve-form="/);
  assert.match(html, /Still on site · hire keeps running/);
  assert.match(html, /Lost · charged at the replacement value/);
  assert.match(html, /Damaged · goes to quarantine/);
  assert.match(html, /Our loss · written off · the owner only/);
  assert.match(html, /Value each \(\$\)/);
  assert.match(html, /No replacement value set/);
  // the owner sets a value: the form now says the charge instead of asking
  f.cmd('productValue', { product: f.product.id, replacementValue: 4250 });
  html = lrTripExtraHTML(v, { ops: true });
  assert.match(html, /Charged at \$42\.50 each/);
  assert.equal(lrMoney(4250), '$42.50');
  assert.equal(lrCents('42.50'), 4250);
  assert.equal(lrCents(''), null);
  assert.ok(Number.isNaN(lrCents('abc')));
  // resolved: 1 still on site, 1 damaged -> quarantine on the Stock page with Repaired / Scrapped / Charged
  f.cmd('returnResolve', {
    trip: coll.id,
    lines: [
      { product: f.product.id, quantity: 1, outcome: 'STILL_ON_SITE' },
      { product: f.product.id, quantity: 1, outcome: 'DAMAGED', reason: 'Bent' },
    ],
  });
  v = f.sim.tripView(f.sim.repo.get(coll.id, 'trip'));
  __lr.reset();
  html = lrTripExtraHTML(v, { ops: true });
  assert.match(html, /Sorted: 1 × .* still on site · 1 × .* damaged/);
  assert.ok(!/data-lr-resolve="/.test(html), 'nothing left to sort');
  const s = f.sim.snapshot();
  const lines = lrQuarantineLines(s);
  assert.deepEqual(
    lines.map((l) => [l.quantity, l.from.map((x) => x.name)]),
    [[1, ['Bondi']]],
  );
  html = lrQuarantineHTML(s, { ops: true });
  assert.match(html, /<h2 id="lr-q-h">Quarantine<\/h2>/);
  assert.match(html, /1 piece · from Bondi/);
  __lr.q(f.product.id, 'CHARGED');
  html = lrQuarantineHTML(s, { ops: true });
  assert.match(html, /data-lr-q-form="/);
  assert.match(html, /Scrapped and charged · the site pays the replacement value/);
  assert.match(html, /Charged at \$42\.50 each/);
  assert.equal(lrQuarantineHTML({ containers: [], balances: [] }, { ops: true }), '');
  // the site's one question, from its account
  const a = f.sim.siteAccount(f.site.id);
  assert.equal(a.words, 'sent 12 · back 11 · 1 missing');
  __lr.reset();
  html = lrFinishHTML({ id: f.site.id, name: 'Bondi' }, a, { ops: true });
  assert.match(html, /Finish this site/);
  assert.match(html, /sent 12 · back 11 · 1 missing/);
  assert.match(html, /data-lr-finish-go="CHARGE"[^>]*>Charge for 1</);
  assert.match(html, /data-lr-finish-go="WRITE_OFF"/);
  assert.match(html, /data-lr-finish-go="STILL_LOOKING"/);
  __lr.finish(f.site.id, 'STILL_LOOKING');
  html = lrFinishHTML({ id: f.site.id, name: 'Bondi' }, a, { ops: true });
  assert.match(html, /data-lr-finish-form="/);
  assert.match(html, /Keep looking/);
  // the owner's values panel: the current value, a new one, a paste from a spreadsheet matched by name or code
  const products = s.products.filter((p) => !p.retired);
  html = lrValuesHTML(products, { owner: true });
  assert.match(html, /<h2 id="lr-values-h">Replacement values<\/h2>/);
  assert.match(html, /\$42\.50/);
  assert.match(html, /data-lr-v="/);
  assert.equal(lrValuesHTML(products, { owner: false }), '');
  const parsed = lrParsePaste(
    f.product.name + '\t55.00\nNo such part\t1\n' + (products[1]?.name ?? 'x') + ',12',
    products,
  );
  assert.deepEqual(parsed.values[0], { product: f.product.id, replacementValue: 5500 });
  assert.equal(parsed.missed.length, 1);
  // Add stock's intake fields
  html = lrIntakeFieldsHTML({ supplier: 'Acme' }, D1);
  assert.match(html, /name="unitCost"/);
  assert.match(html, /value="Acme"/);
});
