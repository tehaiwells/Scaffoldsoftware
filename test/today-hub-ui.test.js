process.env.TZ = 'Australia/Sydney';
import test from 'node:test';
import assert from 'node:assert/strict';
import { planFixture, D0, L } from './helpers/plan-fixture.js';
import { addDays } from '../src/domain/schedule.js';
// The Today hub rendered in node (public/operations.js tdTest, with the /api/plan and /api/today data injected): the month calendar and its chips,
// the day panel and its four Add forms, the five update cards, the crew and driver phone views ("Your messages"), the Team on the Workers page,
// and the planning parts picker (public/game.js gmTest.planPick).
const load = async () => {
  const m = await import('../public/operations.js'),
    g = await import('../public/game.js');
  return { T: m.__test, td: m.tdTest, cw: m.cwTest, cm: m.cwMsgTest, gm: g.gmTest };
};
const OWNER = [
    'company.manage',
    'users.manage',
    'operations.manage',
    'sites.assigned',
    'requests.create',
    'finance.view',
    'stock.adjust',
  ],
  MANAGER = ['operations.manage', 'requests.create', 'stock.adjust'],
  SUPERVISOR = ['requests.create', 'sites.assigned'];
const acct = (f, perms = OWNER) => ({
  permissions: perms,
  systems: [],
  users: [],
  company: { id: 'c', name: 'Tee Scaffolding' },
  user: { id: f.user.id, name: 'Owner' },
});
const D1 = addDays(D0, 1);
const ids = (html) => {
  const list = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  return new Set(list).size === list.length;
};
// A yard with Bondi (gear there), a truck with Dave tomorrow, a list for Bondi on it, workers for Bondi, a re-stack, an expired SWMS
function world(t, { replies = false } = {}) {
  const f = planFixture(t, { now: L(D0, '16:00') });
  f.cmd('teamStart');
  if (!replies) f.cmd('planReplies', { on: false });
  const a = f.site('Bondi', '12 Smith St'),
    b = f.site('Parramatta');
  const { p, per } = f.stock(3);
  const tr = f.cmd('planTruck', { day: D1, truck: f.truck('T-01').id, driver: f.driver('Dave').id, time: '06:30' });
  const mat = f.cmd('planMaterials', {
    day: D1,
    site: a.id,
    lines: [{ product: p.id, quantity: per }],
    truckPlan: tr.item.id,
    time: '09:00',
  });
  const liam = f.cmd('teamAdd', { name: 'Liam', role: 'SCAFFOLDER', mobile: '0412 345 678' }).person.id;
  const wk = f.cmd('planWorkers', { day: D1, site: a.id, count: 6, people: [liam], time: '07:00' });
  f.cmd('planWorkers', { day: addDays(D0, 4), site: b.id, count: 1, time: '07:00' });
  const rs = f.cmd('planRestack', { day: D1, time: '13:00' });
  f.cmd('paperworkAdd', { type: 'SWMS', site: a.id, expiresOn: addDays(D0, -2) });
  f.cmd('paperworkAdd', { type: 'JHSA', site: b.id, expiresOn: addDays(D0, 60) });
  return { f, a, b, p, per, tr, mat, wk, rs, liam };
}
const show = async (w, perms = OWNER, day = D1) => {
  const { T, td } = await load();
  td.reset();
  T.setState(w.f.sim.snapshot(), acct(w.f, perms));
  T.setView('TODAY');
  const plan = w.f.sim.planMonth(D0.slice(0, 7)),
    today = w.f.sim.todayView(),
    sup = !perms.includes('operations.manage');
  // a supervisor's share as the server sends it: nothing to plan or confirm, no money
  td.setData(
    sup
      ? {
          ...plan,
          canPlan: false,
          items: plan.items.map((i) => ({
            ...i,
            canAsk: false,
            canMove: false,
            canCancel: false,
            canEdit: false,
            driverRow: i.driverRow ? { ...i.driverRow, canConfirm: false, smsHref: null } : null,
            people: (i.people ?? []).map((p) => ({ ...p, canConfirm: false, smsHref: null })),
          })),
        }
      : plan,
    sup ? { ...today, business: null } : today,
  );
  td.select(day);
  return td.view();
};

test('the calendar: 42 days, today ringed, a chip per thing in its colour, amber when someone has to answer, red when something needs sorting', async (t) => {
  const w = world(t);
  const html = await show(w);
  assert.equal((html.match(/class="tdh-cell/g) ?? []).length, 42);
  assert.match(html, new RegExp('class="tdh-cell today[^"]*" data-tdh-day="' + D0 + '"'));
  assert.match(html, new RegExp('class="tdh-cell[^"]* sel[^"]*" data-tdh-day="' + D1 + '"'));
  assert.ok(
    html.includes('October 2026') &&
      html.includes('data-tdh-month="-1"') &&
      html.includes('data-tdh-month="1"') &&
      html.includes('data-tdh-month="today"'),
  );
  const cell = html.slice(
    html.indexOf('data-tdh-day="' + D1 + '"'),
    html.indexOf('</button>', html.indexOf('data-tdh-day="' + D1 + '"')),
  );
  for (const tone of ['truck', 'mat', 'crew']) assert.ok(cell.includes('tdh-chip tone-' + tone), 'chip ' + tone);
  assert.ok(cell.includes('+1 more'), 'three chips, then +N more');
  assert.ok(cell.includes('T-01 · Dave') && cell.includes('List → Bondi'), 'short chip words');
  assert.ok(cell.includes('tdh-flag red'), 'short by one worker: red');
  assert.ok(cell.includes('class="tdh-dots"'), 'dots for the phone');
  assert.match(cell, /aria-label="Wednesday 14 October: 4 things, needs sorting"/);
  // no answer needed and nothing wrong: no dot; a waiting answer: amber
  w.f.cmd('planCancel', { id: w.wk.item.id });
  const amber = await show(w);
  const c2 = amber.slice(
    amber.indexOf('data-tdh-day="' + D1 + '"'),
    amber.indexOf('</button>', amber.indexOf('data-tdh-day="' + D1 + '"')),
  );
  assert.ok(c2.includes('tdh-flag amber'), 'Dave has not answered: amber');
  assert.ok(!/\sstyle="/.test(html) && ids(html));
});

test('the day panel: items in time order with one status line, the people and their answers, and the few buttons that help', async (t) => {
  const w = world(t);
  const html = await show(w);
  const order = [
    'T-01 (big truck) &middot; 6:30 am',
    '6 workers &rarr; Bondi &middot; 7:00 am',
    'List for Bondi &middot; 9:00 am',
    'Re-stack the yard &middot; 1:00 pm',
  ].map((s) => html.indexOf(s));
  assert.ok(
    order.every((i) => i > 0),
    JSON.stringify(order),
  );
  const byTime = [order[1], order[0], order[2], order[3]];
  assert.deepEqual(
    [...byTime].sort((a, b) => a - b),
    byTime,
    'what needs sorting first (the workers are short), then by time',
  );
  assert.ok(html.includes('Waiting for Dave to answer'));
  assert.ok(
    html.includes('data-tdh-yes="' + w.f.sim.repo.get(w.tr.item.id, 'planItem').message + '"'),
    'They said yes on the phone',
  );
  assert.ok(html.includes('Waiting for an answer'), 'tomorrow after 3 pm: they were asked at once');
  assert.ok(
    (await show(w, OWNER, addDays(D0, 4))).includes('Message goes the day before at 3 pm'),
    'later: asked the day before',
  );
  assert.ok(html.includes('Short by 2'), 'the gap');
  assert.ok(
    html.includes('data-tdh-edit="' + w.mat.item.id + '"') && html.includes('Change the parts'),
    'the list can change before it is packed',
  );
  assert.ok(
    html.includes('data-tdh-mini="' + w.mat.item.id + '|move"') &&
      html.includes('data-tdh-cancel="' + w.rs.item.id + '"'),
  );
  assert.ok(html.includes('class="gm-slot gm-mini tdh-slot"'), 'the list shows its parts as little slots');
  // the adds: the office on a coming day; never on a past day or for a supervisor
  for (const k of ['TRUCK', 'GEAR', 'WORKERS', 'RESTACK']) assert.ok(html.includes('data-tdh-add="' + k + '"'), k); // + Gear list (ADR 0012)
  const past = await show(w, OWNER, addDays(D0, -1));
  assert.ok(!past.includes('data-tdh-add') && past.includes('Past days are for looking back'));
  const sup = await show(w, SUPERVISOR);
  assert.ok(!sup.includes('data-tdh-add') && !sup.includes('data-tdh-yes'), 'a supervisor sees, the office plans');
});

test('the four Add forms: at most four fields in view, 7:00 am to start, a sentence on the big button', async (t) => {
  const w = world(t);
  const { td } = await load();
  await show(w);
  const fields = (h) => {
    const f = h.slice(h.indexOf('<form class="tdh-form'), h.indexOf('</form>', h.indexOf('<form class="tdh-form')));
    return { n: (f.match(/class="tdh-field[" ]/g) ?? []).length, f };
  };
  td.openForm('TRUCK', addDays(D0, 2));
  td.select(addDays(D0, 2));
  let { n, f } = fields(td.view());
  assert.ok(n <= 4, 'truck ' + n);
  assert.ok(f.includes('<option value="07:00" selected>7:00 am</option>'));
  assert.match(f, /Book T-0\d for Thu 15 Oct/);
  assert.ok(f.includes('Hire in a big truck') && f.includes('+ Add a driver…'));
  td.openForm('TRUCK', D1);
  td.select(D1);
  ({ f } = fields(td.view()));
  assert.match(f, /T-01 \(big truck\) \(booked\)<\/option>/, 'T-01 is taken that day');
  assert.match(f, /Dave \(driving that day\)/);
  td.openForm('MATERIALS', D1);
  ({ n, f } = fields(td.view()));
  assert.ok(n <= 4, 'materials ' + n);
  assert.ok(f.includes('data-tdh-pick') && f.includes('Pick the parts'));
  assert.ok(f.includes('T-01 · Dave, 6:30 am'), 'the truck booked that day');
  assert.ok(/class="tdh-go" disabled/.test(f), 'no parts yet: greyed');
  td.openForm('WORKERS', D1);
  ({ n, f } = fields(td.view()));
  assert.ok(n <= 4, 'workers ' + n);
  assert.ok(f.includes('data-tdh-step="1"') && f.includes('Anyone free'));
  assert.ok(f.includes('They get a message now'), 'tomorrow after 3 pm: now');
  td.openForm('WORKERS', addDays(D0, 5));
  td.select(addDays(D0, 5));
  ({ f } = fields(td.view()));
  assert.ok(f.includes('the day before at 3 pm'));
  td.openForm('RESTACK', addDays(D0, 5));
  ({ n, f } = fields(td.view()));
  assert.ok(n <= 4);
  assert.ok(f.includes('Book a re-stack for Sun 18 Oct'));
  const all = td.view();
  assert.ok(!/\sstyle="/.test(all) && ids(all));
});

test('the update cards: sites with a stage word and a bar, paperwork expired first, who is in, yesterday and where we begin, and the business', async (t) => {
  const w = world(t);
  w.f.cmd('gameSend', { site: w.a.id, lines: [{ product: w.p.id, quantity: w.per }] });
  assert.ok(w.f.until(() => w.f.piecesAt(w.a.id, w.p.id) === w.per, 800));
  let html = await show(w);
  const sites = html.slice(html.indexOf('id="tdh-sites"'));
  assert.ok(sites.includes('Bondi') && sites.includes('Going up'), 'gear there and more planned');
  assert.match(sites, /class="tdh-bar"[^>]*><b data-style="width:\d+%"><\/b>/);
  assert.ok(sites.includes('data-sch-open-site="' + w.a.id + '"'));
  const paper = html.slice(html.indexOf('id="tdh-paper"'));
  assert.ok(
    paper.indexOf('Review overdue') > 0 && paper.indexOf('Review overdue') < paper.indexOf('All good: 1 more'),
    'due for review first; the good ones folded',
  );
  assert.ok(paper.includes('data-tdh-paper-add'));
  const who = html.slice(html.indexOf('id="tdh-who"'));
  for (const r of w.f.sim.snapshot().resources.filter((r) => r.type === 'WORKER' && r.location === w.f.yard.id))
    assert.ok(who.includes('data-cw-open="' + r.id + '"'), 'yard crew ' + r.name);
  assert.ok(html.includes('id="tdh-yt"') && html.includes('Where we begin today'));
  const biz = html.slice(html.indexOf('id="tdh-biz"'));
  assert.ok(biz.includes('Set your prices') && biz.includes('data-view="HIRE"'), 'no rates yet: set your prices');
  assert.ok(!/\$\d/.test(biz), 'no dollars without prices');
  w.f.cmd('hireRate', { product: w.p.id, day: 50 });
  html = await show(w);
  const own = html.slice(html.indexOf('id="tdh-biz"'));
  assert.equal((own.match(/<b>\$[\d,]+<\/b>/g) ?? []).length, 3, 'week, month, to invoice');
  assert.ok(own.includes('record payments yet'), 'the footnote');
  const mgr = await show(w, MANAGER);
  const m = mgr.slice(mgr.indexOf('id="tdh-biz"'));
  assert.ok(m.includes('trucks busy now') && !/\$\d/.test(m), 'a manager sees the numbers, never dollars');
  assert.ok(!(await show(w, SUPERVISOR)).includes('id="tdh-biz"'), 'no business card for a supervisor');
});

test("phone views: a worker answers I'll be there / Can't make it (with a reason), a yardsman gets Got it, a driver has their own page", async (t) => {
  const w = world(t);
  const { T, cw, cm } = await load();
  w.f.cmd('planReplies', { on: false });
  T.setState(w.f.sim.snapshot(), acct(w.f));
  const day = w.f.sim.crewDay(w.liam);
  cw.open(w.liam, 'TODAY');
  cw.setDay({ ...day, worker: w.liam });
  cm.worker();
  let h = cw.view();
  assert.ok(
    h.includes('Your messages') && h.includes('data-cw-yes') && h.includes('data-cw-no'),
    'the two big buttons',
  );
  assert.ok(h.includes('I’ll be there') && h.includes('Can’t make it'));
  assert.ok(h.includes('Get directions'), 'Bondi has an address');
  assert.ok(h.includes('Scaffolder'), 'the role under the name');
  const mid = day.messages[0].id;
  cm.no(mid);
  h = cw.view();
  assert.ok(h.includes('data-cw-reason="Crook"') && h.includes('data-cw-send="' + mid + '"'));
  w.f.cmd('messageAnswer', { id: mid, yes: false, reason: 'Crook', via: 'PHONE_VIEW' });
  cm.no(null);
  cw.setDay({ ...w.f.sim.crewDay(w.liam), worker: w.liam });
  h = cw.view();
  assert.ok(h.includes('You said you can'), 'the answer shows');
  assert.ok(h.includes('Change my answer'));
  const dave = w.f.driver('Dave');
  cm.driver(dave.id, w.f.sim.personView('driver', dave.id));
  h = cm.driverView();
  assert.ok(
    h.includes('SCAFFOLD / DRIVER') &&
      h.includes('Dave') &&
      h.includes('Your messages') &&
      h.includes('Your truck today'),
  );
  assert.ok(h.includes('data-cw-yes'), 'Dave can answer');
  assert.equal(cm.linkFrom('?view=CREW&driver=' + dave.id), dave.id);
  assert.equal(cm.linkFrom('?view=CREW&worker=x'), null);
  cm.worker();
  assert.ok(!/\sstyle="/.test(h) && ids(h));
});

test('the Team on the Workers page, the answers switch in the Control room', async (t) => {
  const w = world(t);
  const { T, td } = await load();
  T.setState(w.f.sim.snapshot(), acct(w.f));
  T.setView('WORKERS');
  td.team(w.f.sim.teamView());
  const h = td.teamView();
  assert.ok(h.includes('Your team') && h.includes('data-tm-add'));
  assert.ok(h.includes('Liam') && h.includes('0412 345 678'));
  assert.ok(h.includes('Demo name: tap to rename'), 'Worker 1 is a demo name');
  assert.ok(h.includes('data-cw-driver="' + w.f.driver('Dave').id + '"'), 'a driver opens the driver view');
  assert.ok(T.workersView().includes('id="tm-team"'), 'at the top of the Workers page');
  const sw = td.replies();
  assert.ok(sw.includes('id="tdh-replies"') && sw.includes('Off'), 'answers switched off in this world');
  T.setState(w.f.sim.snapshot(), acct(w.f, SUPERVISOR));
  assert.equal(td.teamView(), '', 'the office only');
});

test('the planning picker: the parts the crew can lift, any amount (the yard may be restocked by then), + and - by one stillage, Use these parts gives the lines', async (t) => {
  const w = world(t);
  const { gm } = await load();
  const pk = gm.planPick({ state: w.f.sim.snapshot(), lift: 1500000 });
  let h = pk.html();
  assert.ok(h.includes('data-pp-slot="' + w.p.id + '"') && h.includes('Use these parts'));
  assert.ok(/data-pp-done disabled/.test(h), 'nothing picked yet');
  h = pk.set(w.p.id, w.per * 10);
  assert.ok(
    h.includes('more than you have: ' + w.per * 3 + ' free in the yard now'),
    'more than the yard has is allowed, and said',
  );
  assert.ok(h.includes('class="pp-q over"'), 'the picked tag is amber');
  assert.ok(h.includes('<b class="gm-n">'), 'the corner still shows the yard');
  pk.select(w.p.id);
  assert.equal(pk.step(1), w.per * 11);
  assert.equal(pk.step(-1), w.per * 10);
  assert.deepEqual(pk.done(), [{ product: w.p.id, quantity: w.per * 10 }]);
});

test("review fixes on the page: a low-stock line, the Workers form uses the server's free list (the crane crew marked), a list that didn't go asks for a new day, paperwork without a doubled title, dates in words, messages first on a phone", async (t) => {
  const w = world(t);
  const { T, td, cw, cm } = await load();
  const D5 = addDays(D0, 5);
  w.f.cmd('planMaterials', { day: D5, site: w.b.id, lines: [{ product: w.p.id, quantity: w.per * 9 }] });
  let html = await show(w, OWNER, D5);
  assert.ok(
    html.includes('class="tdh-warn"') && /Only \d+ of .+ in the yard now: \d+ short/.test(html),
    'amber before its day',
  );
  const cell = html.slice(
    html.indexOf('data-tdh-day="' + D5 + '"'),
    html.indexOf('</button>', html.indexOf('data-tdh-day="' + D5 + '"')),
  );
  assert.ok(cell.includes('tdh-flag amber'), 'an amber dot on the calendar');
  // one of Bondi's two hands is booked away on the day of its delivery: the other is the crane crew, marked and never offered
  const bondi = w.f.sim.repo
    .all('resource')
    .filter((r) => r.type === 'WORKER' && r.enabled && r.location === w.a.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  w.f.cmd('planWorkers', { day: D1, site: w.b.id, time: '08:00', count: 1, people: [bondi[0].id] });
  html = await show(w);
  td.openForm('WORKERS', D1, { site: w.b.id, who: 'PICK', count: 2 });
  let f = td.view();
  assert.ok(f.includes('needed for the crane at Bondi'), 'marked');
  assert.match(f, new RegExp('data-tdh-person="' + bondi[1].id + '" disabled'));
  td.openForm('WORKERS', D1, { site: w.b.id, count: 9 });
  f = td.view();
  assert.ok(
    f.includes('Nobody is free that day. Tap <b>Pick people…</b> to choose, or add someone to your team.'),
    'the form says so before booking',
  );
  td.openForm('WORKERS', D5, { site: w.b.id, count: 9 });
  td.select(D5);
  f = td.view();
  assert.match(f, /Only \d+ free that day, so \d+ will show as short\. Tap <b>Pick people…<\/b> to choose anyone\./);
  td.select(D1);
  // paperwork: a SWMS with no name is titled by its site; the chosen date in words under the date box
  const paper = html.slice(html.indexOf('id="tdh-paper"'));
  assert.ok(
    paper.includes('<span class="tdh-ptype">SWMS</span><span class="tdh-paper-text"><b>Bondi</b>'),
    'no SWMS | SWMS',
  );
  td.openForm('PAPER', D1, { type: 'JHSA', expiresOn: '2026-10-20' });
  assert.ok(td.view().includes('data-tdh-date-words aria-live="polite">Tue 20 Oct 2026</small>'));
  td.reset();
  // the list for tomorrow: Dave never answers, so at 5 pm it didn't go; it waits for a new day
  w.f.clock(D1, '17:00');
  w.f.pass();
  html = await show(w);
  assert.match(html, /Didn(&#39;|&#x27;|'|’)t go/);
  assert.ok(html.includes('data-tdh-mini="' + w.mat.item.id + '|move"') && html.includes('Pick a new day'));
  w.f.clock(addDays(D0, 2), '08:00');
  html = await show(w, OWNER, addDays(D0, 2));
  assert.ok(
    html.includes('class="tdh-missed"') && html.includes('data-tdh-goto="' + w.mat.item.id + '"'),
    'on Where we begin today until it has a new day',
  );
  // a phone with a message to answer opens on the message, with no simulation disclaimer
  const g = world(t);
  T.setState(g.f.sim.snapshot(), acct(g.f));
  const day = g.f.sim.crewDay(g.liam);
  cw.open(g.liam, 'TODAY');
  cw.setDay({ ...day, worker: g.liam });
  cm.worker();
  const h = cw.view();
  assert.ok(h.indexOf('cw-msgs') > 0 && h.indexOf('cw-msgs') < h.indexOf('cw-hero'), 'Your messages first');
  assert.ok(!h.includes('SIMULATION / DEMONSTRATION'));
  assert.ok(!/\sstyle="/.test(h) && ids(h));
});
