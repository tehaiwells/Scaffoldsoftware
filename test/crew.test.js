import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/fixture.js';
import { Simulation } from '../src/simulation.js';
import { createApp } from '../src/server.js';
// Crew phone view (cw*): the pure helpers (status label, likely-next ranking, today's history, the link), the crew-day records (src/domain/crew.js),
// the page rendered in node from live snapshots, and the entry points on the other pages.
const load = async () => await import('../public/operations.js');
const acct = (f, perms = ['operations.manage', 'stock.adjust', 'requests.create']) => ({
  permissions: perms,
  systems: [],
  users: [],
  company: { id: 'c', name: 'Demo' },
  user: { id: f.user.id },
});
const crewOf = (f) =>
  f.sim.repo.all('resource').filter((r) => r.enabled && r.type === 'WORKER' && r.location === f.yard.id);
const until = (f, pred, n = 200) => {
  for (let i = 0; i < n && !pred(); i++) f.tick(1);
  return pred();
};

test('status pill: Working, Walking, Driving forklift, Idle or On hold, with what exactly', async () => {
  const { cwTest } = await load();
  const s = {
    resources: [{ id: 'm1', type: 'FORKLIFT', name: 'Forklift 1' }],
    tasks: [
      { id: 't1', to: 'k1' },
      { id: 't2', to: 'y1' },
    ],
    trucks: [{ id: 'k1' }],
    sites: [],
  };
  const cases = [
    [{ task: 't1' }, 'working', 'Working', 'Loading a truck'],
    [{ task: 't2' }, 'working', 'Working', 'On a forklift move'],
    [{ mountedOn: 'm1' }, 'driving', 'Driving forklift', 'At the wheel of Forklift 1'],
    [{ mountTarget: 'm1', walk: { path: [] } }, 'walking', 'Walking', 'Walking to Forklift 1'],
    [{ walk: { job: 'j', path: [] } }, 'walking', 'Walking', 'Walking to a job'],
    [{ walk: { path: [] } }, 'walking', 'Walking', 'Walking on orders'],
    [{ job: 'j' }, 'onjob', 'Working', 'On a yard job'],
    [{ workerMode: 'HOLD' }, 'hold', 'On hold', null],
    [{ workerMode: 'AUTO' }, 'idle', 'Idle', null],
    [{}, 'idle', 'Idle', null],
  ];
  for (const [r, key, label, detail] of cases) {
    const st = cwTest.status({ id: 'w', type: 'WORKER', ...r }, s);
    assert.equal(st.key, key, JSON.stringify(r));
    assert.equal(st.label, label);
    if (detail) assert.equal(st.detail, detail);
  }
  assert.equal(cwTest.status(null, s).key, 'gone');
  assert.equal(
    cwTest.status({ id: 'w', task: 't1', mountedOn: 'm1' }, s).label,
    'Working',
    'a forklift move comes first',
  );
});

test('likely next: top rung first, oldest first on a rung, nearest automatic worker with the skill, round by round', async () => {
  const { cwTest } = await load();
  const W = (id, x, extra = {}) => ({ id, name: id, type: 'WORKER', location: 'y', x, y: 0, skills: {}, ...extra });
  const J = (id, priority, createdAt, extra = {}) => ({
    id,
    yard: 'y',
    state: 'OPEN',
    effect: 'RECORD',
    category: 'YARD',
    priority,
    createdAt,
    title: id,
    ...extra,
  });
  const s = {
    resources: [W('A', 0), W('B', 10000), W('C', 20000, { workerMode: 'HOLD' })],
    jobs: [
      J('late', 5, '2026-09-26T02:00:00Z'),
      J('near-B', 2, '2026-09-26T03:00:00Z', { target: { x: 9000, y: 0 } }),
      J('early', 5, '2026-09-26T01:00:00Z'),
      J('p7', 7, '2026-09-26T00:00:00Z'),
      J('taken', 1, '2026-09-26T00:00:00Z', { state: 'ASSIGNED' }),
      J('unload', 1, '2026-09-26T00:00:00Z', { effect: 'UNLOAD' }),
      J('other-yard', 1, '2026-09-26T00:00:00Z', { yard: 'z' }),
    ],
  };
  // Round 1: near-B (P2) to B (nearest), early (P5, older) to A. Round 2: late to A? no, to the first free automatic worker in crew order (A), p7 to B.
  const a = cwTest.likelyNext(s, 'A'),
    b = cwTest.likelyNext(s, 'B');
  assert.equal(a.mode, 'auto');
  assert.deepEqual(
    a.items.map((x) => [x.job.id, x.rank]),
    [
      ['early', 1],
      ['late', 2],
    ],
  );
  assert.deepEqual(
    b.items.map((x) => [x.job.id, x.rank]),
    [
      ['near-B', 1],
      ['p7', 2],
    ],
  );
  const c = cwTest.likelyNext(s, 'C');
  assert.equal(c.mode, 'hold');
  assert.deepEqual(c.items, []);
  assert.deepEqual(
    c.pool.map((j) => j.id),
    ['near-B', 'early', 'late', 'p7'],
    'a held worker is shown the open jobs for their skills',
  );
  // A skill switched off hands the job to the other worker, even when it is nearer.
  const off = { ...s, resources: [W('A', 9000, { skills: { YARD: false } }), W('B', 10000)] };
  assert.deepEqual(cwTest.likelyNext(off, 'A').items, []);
  assert.deepEqual(
    cwTest.likelyNext(off, 'B').items.map((x) => x.job.id),
    ['near-B', 'early', 'late'],
  );
  assert.equal(cwTest.likelyNext({ ...s, resources: [W('A', 0, { mountedOn: 'm' })] }, 'A').mode, 'driving');
  assert.equal(cwTest.likelyNext({ ...s, resources: [W('A', 0, { workerMode: 'MOVING' })] }, 'A').mode, 'moving');
  // Nothing open: the routine rotation the server lined up (board.idle), in its order.
  const idle = cwTest.likelyNext(
    {
      jobs: [],
      resources: [
        W('A', 0, { board: { idle: [{ title: 'Routine: sweep loading zones' }, { title: 'Routine: clean yard' }] } }),
      ],
    },
    'A',
  );
  assert.deepEqual(idle.routine, ['Sweep loading zones', 'Clean yard'], 'routine rounds read as sentences');
  assert.equal(
    cwTest.likelyNext({ resources: [W('A', 0)] }, 'A').mode,
    'unknown',
    'no job list (a supervisor): nothing is guessed',
  );
  assert.equal(cwTest.likelyNext(s, 'nobody').mode, 'gone');
});

test('likely next matches the engine board (NEXT and THEN) for every worker on a live snapshot', async (t) => {
  const f = fixture(t),
    { cwTest } = await load();
  const crew = crewOf(f);
  for (const [i, [p, where]] of [
    [2, 'loading'],
    [5, 'gate'],
    [5, 'here'],
    [7, 'loading'],
    [3, 'gate'],
    [8, 'here'],
  ].entries())
    f.cmd('createJob', {
      yard: f.yard.id,
      category: 'YARD',
      title: 'Job ' + i + ' P' + p + ' ' + where,
      where: { kind: where },
      priority: p,
      seconds: 30,
    });
  f.cmd('workerCommand', { id: crew[1].id, order: 'HOLD' });
  f.cmd('workerSkills', { id: crew[2].id, skills: { YARD: false } });
  const s = f.sim.snapshot();
  let compared = 0;
  for (const w of s.resources.filter((r) => r.type === 'WORKER' && r.location === f.yard.id)) {
    const L = cwTest.likelyNext(s, w.id, 2);
    assert.equal(L.items.find((x) => x.rank === 1)?.job.id ?? null, w.board.next?.id ?? null, 'NEXT for ' + w.name);
    assert.equal(L.items.find((x) => x.rank === 2)?.job.id ?? null, w.board.then?.id ?? null, 'THEN for ' + w.name);
    compared++;
  }
  assert.equal(compared, 5);
  assert.equal(cwTest.likelyNext(s, crew[1].id).mode, 'hold');
  assert.deepEqual(cwTest.likelyNext(s, crew[2].id).items, [], 'no YARD skill, no yard jobs');
});

test("today's history: records first (jobs and forklift moves, newest first, routine apart), else the yard's recent jobs, else not recorded", async () => {
  const { cwTest } = await load();
  const now = Date.parse('2026-09-26T05:00:00');
  const iso = (h) => new Date(Date.parse('2026-09-26T00:00:00') + h * 3600000).toISOString();
  const day = {
    worker: 'w',
    recorded: true,
    jobs: [
      {
        id: 'j1',
        title: 'Pre-check',
        completedAt: iso(1),
        badge: 'CHECK',
        priority: 2,
        result: 'Every line can be reserved',
      },
    ],
    moves: [{ id: 't1', title: 'Load S-001', at: iso(2), exact: true }],
    jobsDone: 1,
    movesDone: 1,
    routine: { count: 3, ms: 12000 },
    workMs: 45000,
  };
  const s = {
    resources: [{ id: 'w', job: 'jr' }],
    jobs: [{ id: 'jr', state: 'IN_PROGRESS', durationMs: 20000, progress: 50 }],
  };
  const r = cwTest.today(day, s, 'w', now);
  assert.equal(r.source, 'records');
  assert.equal(r.count, 2);
  assert.deepEqual(
    r.items.map((i) => [i.kind, i.id]),
    [
      ['move', 't1'],
      ['job', 'j1'],
    ],
  );
  assert.equal(r.routine.count, 3);
  assert.equal(r.workMs, 55000, 'the running job adds its counted time');
  assert.equal(
    cwTest.today({ ...day, worker: 'other' }, { ...s, recentJobs: [] }, 'w', now).source,
    'recent',
    'records for another worker are never shown',
  );
  const recent = [
    { id: 'a', worker: 'w', state: 'DONE', completedAt: iso(3), title: 'Count S-2' },
    { id: 'b', worker: 'x', state: 'DONE', completedAt: iso(3), title: 'Other' },
    { id: 'c', worker: 'w', state: 'CANCELLED', completedAt: iso(3), title: 'Cancelled' },
    { id: 'd', worker: 'w', state: 'DONE', completedAt: iso(-3), title: 'Yesterday' },
    { id: 'e', worker: 'w', state: 'DONE', completedAt: iso(4), title: 'Later', hazard: true },
  ];
  const f = cwTest.today(null, { recentJobs: recent, resources: [{ id: 'w' }] }, 'w', now);
  assert.equal(f.source, 'recent');
  assert.deepEqual(
    f.items.map((i) => i.id),
    ['e', 'a'],
  );
  assert.equal(f.items[0].badge, 'HAZARD');
  assert.equal(f.workMs, null);
  const none = cwTest.today(null, { resources: [{ id: 'w' }] }, 'w', now);
  assert.equal(none.source, 'none');
  assert.equal(none.count, null);
  assert.equal(cwTest.dur(45000), '45 s');
  assert.equal(cwTest.dur(14 * 60000), '14 min');
  assert.equal(cwTest.dur(125 * 60000), '2 h 05 min');
  assert.equal(cwTest.dur(null), '–');
});

test('a link opens one worker: ?view=CREW&worker=<id>, nothing for other pages or odd ids', async () => {
  const { cwTest } = await load();
  assert.equal(cwTest.linkFrom('?view=CREW&worker=abc-123'), 'abc-123');
  assert.equal(cwTest.linkFrom('?worker=abc&view=crew'), 'abc');
  for (const v of [
    '',
    '?view=CREW',
    '?view=TODAY&worker=abc',
    '?view=CREW&worker=a%20b',
    '?view=CREW&worker=<x>',
    null,
    undefined,
  ])
    assert.equal(cwTest.linkFrom(v), null, String(v));
});

test('crew-day records: finished yard jobs and forklift moves of today for one worker, routine apart, supervisors kept to their sites', async (t) => {
  const f = fixture(t);
  const [w, other] = crewOf(f);
  const job = f.cmd('createJob', {
    yard: f.yard.id,
    category: 'YARD',
    title: 'Sweep bay 3',
    where: { kind: 'here' },
    priority: 7,
    seconds: 2,
    worker: w.id,
  });
  assert.ok(
    until(f, () => f.sim.repo.get(job.id).state === 'DONE', 30),
    'the job finishes',
  );
  const routine = f.sim.routineJob(
    f.yard,
    { verb: 'clean yard', category: 'YARD', priority: 7 },
    null,
    new Date().toISOString(),
  );
  const r = f.sim.repo.get(routine.id);
  Object.assign(r, { state: 'DONE', worker: w.id, completedAt: new Date().toISOString() });
  f.sim.repo.save(r);
  const task = f.cmd('queue', { container: f.a.id, destination: f.truck.id });
  assert.ok(
    until(f, () => f.sim.repo.get(task.id).state === 'COMPLETE', 60),
    'the move finishes',
  );
  const mover = f.sim.repo.get(task.id).resources.slice(1)[0];
  const day = f.sim.crewDay(w.id);
  assert.equal(day.worker, w.id);
  assert.equal(day.recorded, true);
  assert.equal(day.jobsDone, 1);
  assert.equal(day.jobs[0].title, 'Sweep bay 3');
  assert.match(day.jobs[0].result, /Done by/);
  assert.equal(day.routine.count, 1, 'routine rounds are counted apart');
  assert.ok(day.workMs >= 2000);
  const moved = f.sim.crewDay(mover);
  assert.equal(moved.movesDone, 1);
  assert.equal(moved.moves[0].exact, true, 'finish time from the placement in the ledger');
  assert.ok(moved.moves[0].title);
  if (mover !== other.id) assert.equal(f.sim.crewDay(other.id).movesDone, 0);
  const tomorrow = new Date(Date.now() + 36 * 3600000);
  const later = f.sim.crewDay(w.id, tomorrow);
  assert.equal(later.jobsDone, 0);
  assert.equal(later.routine.count, 0, 'a new day starts from nothing');
  assert.throws(() => f.sim.crewDay(f.truck.id), /not found|worker/i);
  assert.throws(() => f.sim.crewDay(''), /Choose a worker/);
  f.auth.addUser(f.user, {
    name: 'Sup',
    email: 'sup-crew@example.com',
    password: 'demonstration-password',
    roles: ['SUPERVISOR'],
  });
  const sup = new Simulation(
    f.db,
    f.auth.authenticate(f.auth.login({ email: 'sup-crew@example.com', password: 'demonstration-password' })),
  );
  assert.throws(() => sup.crewDay(w.id), /assigned/, 'a supervisor cannot read the yard crew');
  const server = createApp(f.db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const noAuth = await fetch(base + '/api/crew-day?worker=' + w.id);
  assert.equal(noAuth.status, 401);
  f.auth.addUser(f.user, {
    name: 'GM',
    email: 'gm-crew@example.com',
    password: 'demonstration-password',
    roles: ['GENERAL_MANAGER'],
  });
  const cookie = 'session=' + f.auth.login({ email: 'gm-crew@example.com', password: 'demonstration-password' });
  const ok = await fetch(base + '/api/crew-day?worker=' + w.id, { headers: { cookie } });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.jobsDone, 1);
  assert.equal(body.name, w.name);
  const bad = await fetch(base + '/api/crew-day', { headers: { cookie } });
  assert.equal(bad.status, 409);
  assert.match((await bad.json()).error, /Choose a worker/);
  const nope = await fetch(base + '/api/crew-day?worker=not-a-worker', { headers: { cookie } });
  assert.equal(nope.status, 404);
});

test('the crew page renders from a live snapshot: hero, now with the map, orders, likely next and done today', async (t) => {
  const f = fixture(t),
    { __test, cwTest } = await load();
  const [w, w2] = crewOf(f);
  f.cmd('createJob', {
    yard: f.yard.id,
    category: 'YARD',
    title: 'Tidy the gate',
    where: { kind: 'gate' },
    priority: 5,
    seconds: 30,
  });
  f.cmd('createJob', {
    yard: f.yard.id,
    category: 'HANDLING',
    title: 'Restack S-9',
    where: { kind: 'loading' },
    priority: 3,
    seconds: 30,
  });
  __test.setState(f.sim.snapshot(), acct(f));
  cwTest.open(w.id, 'TODAY');
  cwTest.setDay({
    worker: w.id,
    recorded: true,
    jobs: [
      {
        id: 'x',
        title: 'Checked the load',
        completedAt: new Date().toISOString(),
        badge: 'CHECK',
        result: 'Load matches the yard list',
      },
    ],
    moves: [],
    jobsDone: 1,
    movesDone: 0,
    routine: { count: 2, ms: 8000 },
    workMs: 30000,
  });
  const html = cwTest.view();
  assert.ok(html.startsWith('<div class="page-crew">'));
  assert.ok(html.includes('<h1>' + w.name + '</h1>'));
  assert.match(html, /class="cw-pill"><i aria-hidden="true"><\/i>Idle</);
  assert.ok(html.includes('data-cw-back') && html.includes('>Today<'), 'Back names the page it came from');
  assert.ok(html.includes('data-cw-open="' + w2.id + '"'), 'the switcher jumps to the next worker');
  assert.match(html, /<b>1<\/b> of 5/);
  assert.ok(
    html.includes('Done today') && html.includes('Checked the load') && html.includes('Plus 2 routine rounds'),
    'done today from the records',
  );
  assert.ok(
    html.includes('class="yard-svg') && /viewBox="-?\d+ -?\d+ \d+ \d+"/.test(html),
    'the mini-map is the yard plan, cropped',
  );
  assert.ok(!html.includes('tabindex="0"'), 'the map figures are not tab stops');
  for (const cmd of ['data-cw-cmd="AUTO"', 'data-cw-cmd="HOLD"', 'data-cw-menu="assign"', 'data-cw-menu="mount"'])
    assert.ok(html.includes(cmd), cmd);
  assert.match(html, /data-cw-cmd="AUTO" disabled>.*?On automatic/, 'already automatic: the button says so');
  assert.ok(
    html.includes('Likely next') && (html.includes('Tidy the gate') || html.includes('Restack S-9')),
    'likely next lists an open job',
  );
  assert.ok(!/ style="/.test(html), 'no inline style attributes (CSP)');
  cwTest.setMenu('assign');
  const menu = cwTest.controls();
  assert.ok(
    menu.includes('data-cw-next') && menu.includes('data-cw-assign='),
    'the assign menu lists Next up and the open jobs',
  );
  cwTest.setMenu('mount');
  assert.ok(cwTest.controls().includes('data-cw-mount='), 'the forklift menu lists the free forklifts');
  cwTest.setMenu(null);
  // Held and on a job
  f.cmd('workerCommand', { id: w.id, order: 'HOLD' });
  __test.setState(f.sim.snapshot(), acct(f));
  let h = cwTest.view();
  assert.match(h, /On hold/);
  assert.match(h, /data-cw-cmd="HOLD" disabled>.*?Holding here/);
  assert.ok(h.includes('is on hold and takes no jobs'));
  f.cmd('workerCommand', { id: w.id, order: 'AUTO' });
  const j = f.cmd('createJob', {
    yard: f.yard.id,
    category: 'YARD',
    title: 'Walk the fence',
    where: { kind: 'gate' },
    priority: 4,
    seconds: 30,
    worker: w.id,
  });
  __test.setState(f.sim.snapshot(), acct(f));
  h = cwTest.view();
  assert.ok(h.includes('Walk the fence'));
  assert.ok(/Walking/.test(h));
  if (f.sim.repo.get(j.id).state === 'ASSIGNED')
    assert.ok(h.includes('class="cw-route"'), 'the walking route is drawn');
  // A supervisor: no orders, no job board guesses; a removed worker: a plain message.
  __test.setState(f.sim.snapshot(), acct(f, ['requests.create', 'sites.assigned']));
  const sup = cwTest.view();
  assert.ok(!sup.includes('data-cw-cmd'), 'no orders without operations.manage');
  __test.setState(f.sim.snapshot(), acct(f));
  cwTest.open('missing-worker');
  const gone = cwTest.view();
  assert.ok(gone.includes('Worker not found') && gone.includes('data-cw-back'));
});

test('every worker opens the crew view: Workers cards and rows, Today crew list, the selected-worker panel', async (t) => {
  const f = fixture(t),
    { __test, tdTest } = await load();
  const crew = crewOf(f);
  __test.setState(f.sim.snapshot(), acct(f));
  __test.setView('WORKERS');
  const wk = __test.workersView();
  for (const w of crew) assert.ok(wk.includes('data-cw-open="' + w.id + '"'), 'Workers card for ' + w.name);
  const site = f.sim.snapshot().resources.filter((r) => r.type === 'WORKER' && r.location === f.site.id);
  assert.ok(site.length && site.every((w) => wk.includes('data-cw-open="' + w.id + '"')), 'site crew rows');
  __test.setView('TODAY');
  const td = tdTest.view();
  for (const w of crew) assert.ok(td.includes('data-cw-open="' + w.id + '"'), 'Today chip for ' + w.name);
  const { cwTest } = await load();
  __test.setState(f.sim.snapshot(), acct(f));
  const yard = f.sim.snapshot().yards[0],
    panel = cwTest.panel(yard, crew[0].id);
  assert.ok(
    panel.includes('class="secondary cw-panel-btn" data-cw-open="' + crew[0].id + '"'),
    'the selected-worker panel has the crew phone view button',
  );
  assert.ok(!cwTest.panel(yard, null).includes('cw-panel-btn'), 'no button without a selected worker');
  assert.ok(
    wk.includes('class="secondary cw-card-btn" data-cw-open="' + crew[0].id + '"'),
    'each Workers card has a Phone view button',
  );
});

// The crew page's look (a centred column, big buttons, phone rules, hover only on buttons that can be pressed) is checked in the browser, on the real stylesheet: e2e/behaviour.spec.js.
test('crew-day counts every job finished today, past the 100 closed jobs the yard keeps, and a count never drops on its own', async (t) => {
  const f = fixture(t);
  const crew = crewOf(f);
  f.cmd('jobsMode', { jobs: true, routineJobs: false });
  const batch = (n, tag) => {
    for (let i = 0; i < n; i++)
      f.cmd('createJob', {
        yard: f.yard.id,
        category: 'YARD',
        title: tag + ' ' + i,
        where: { kind: 'here' },
        priority: 5,
        seconds: 1,
      });
  };
  const openLeft = (tag) =>
    f.sim.repo
      .all('job')
      .filter((j) => j.title.startsWith(tag) && ['OPEN', 'ASSIGNED', 'IN_PROGRESS'].includes(j.state)).length;
  batch(140, 'Quick');
  assert.ok(
    until(f, () => openLeft('Quick') === 0, 900),
    'all 140 jobs finish',
  );
  assert.ok(
    f.sim.repo.all('job').filter((j) => j.state === 'DONE').length <= 100,
    'the engine keeps only the newest 100 closed jobs',
  );
  const sum = () => crew.reduce((n, w) => n + f.sim.crewDay(w.id).jobsDone, 0);
  assert.equal(sum(), 140, 'every finished job is counted once');
  const one = crew[2].id,
    before = f.sim.crewDay(one);
  assert.ok(before.jobsDone > 0);
  assert.equal(before.partial, false, 'counted as it happened, not from the kept list');
  f.cmd('workerCommand', { id: one, order: 'HOLD' });
  batch(60, 'More');
  assert.ok(
    until(f, () => openLeft('More') === 0, 900),
    'the others finish 60 more',
  );
  assert.equal(f.sim.crewDay(one).jobsDone, before.jobsDone, 'a worker who did nothing keeps their count');
  const extra = f.sim.repo
    .all('job')
    .filter((j) => j.state === 'DONE' && j.worker && j.origin !== 'ROUTINE' && !/^(Quick|More) /.test(j.title)).length;
  assert.equal(sum(), 200 + extra, 'the yard’s own jobs count too');
  assert.ok(
    f.sim.crewDay(one).jobs.length <= 60 && f.sim.crewDay(crew[0].id).jobs.every((j) => j.title && j.completedAt),
    'the newest finished jobs are listed',
  );
  assert.equal(f.sim.crewDay(one, new Date(Date.now() + 36 * 3600000)).jobsDone, 0, 'a new day starts from nothing');
});

test('time on a job taken off part-way stays in the day, so the time on jobs never drops', async (t) => {
  const f = fixture(t);
  const [w] = crewOf(f);
  const job = f.cmd('createJob', {
    yard: f.yard.id,
    category: 'YARD',
    title: 'Long sweep',
    where: { kind: 'here' },
    priority: 5,
    seconds: 60,
    worker: w.id,
  });
  assert.ok(
    until(
      f,
      () => {
        const j = f.sim.repo.get(job.id);
        return j.state === 'IN_PROGRESS' && j.remainingMs <= j.durationMs - 5000;
      },
      60,
    ),
    'part of the job is done',
  );
  const spent = (() => {
    const j = f.sim.repo.get(job.id);
    return j.durationMs - j.remainingMs;
  })();
  f.cmd('takeOffJob', { id: job.id });
  const day = f.sim.crewDay(w.id);
  assert.equal(day.jobsDone, 0, 'not finished');
  assert.equal(day.workMs, spent, 'the time spent is kept');
  assert.equal(day.cutMs, spent);
  const { __test, cwTest } = await load();
  __test.setState(f.sim.snapshot(), acct(f));
  assert.equal(cwTest.today(day, f.sim.snapshot(), w.id).workMs, spent);
});

test('the Assign menu is frozen while open: a job someone else takes stays in place, greyed, and a menu that cannot show is closed for good', async (t) => {
  const f = fixture(t),
    { __test, cwTest } = await load();
  const [a, b, ...rest] = crewOf(f);
  for (const r of rest) f.cmd('workerCommand', { id: r.id, order: 'HOLD' });
  const ids = [1, 2, 3, 4, 5, 6, 7].map(
    (i) =>
      f.cmd('createJob', {
        yard: f.yard.id,
        category: 'YARD',
        title: 'Job ' + i,
        where: { kind: 'gate' },
        priority: 5,
        seconds: 120,
      }).id,
  );
  __test.setState(f.sim.snapshot(), acct(f));
  cwTest.open(a.id);
  cwTest.setMenu('assign');
  const rows = (h) => [...h.matchAll(/data-cw-assign="([^"]+)"( disabled)?/g)].map((m) => [m[1], !!m[2]]);
  let h = cwTest.controls();
  assert.deepEqual(
    rows(h),
    ids.slice(0, 5).map((id) => [id, false]),
    'five rows first',
  );
  assert.ok(h.includes('Show all 7 open jobs') && h.includes('data-cw-close'), 'show all and a close row');
  f.cmd('assignJob', { id: ids[0], worker: b.id });
  f.cmd('createJob', {
    yard: f.yard.id,
    category: 'YARD',
    title: 'Job new',
    where: { kind: 'gate' },
    priority: 1,
    seconds: 120,
  });
  __test.setState(f.sim.snapshot(), acct(f));
  h = cwTest.controls();
  assert.deepEqual(
    rows(h),
    [[ids[0], true], ...ids.slice(1, 5).map((id) => [id, false])],
    'the taken job keeps its row, greyed out; nothing moves up',
  );
  assert.ok(h.includes('Taken by ' + b.name), 'says who took it');
  assert.ok(h.includes('1 new job since you opened this list'), 'a new job is only counted');
  cwTest.menu().all = true;
  assert.equal(rows(cwTest.controls()).length, 7, 'show all lists every job it opened with');
  const fork = f.sim.snapshot().resources.find((r) => r.type === 'FORKLIFT' && r.location === f.yard.id);
  f.cmd('workerCommand', { id: a.id, order: 'MOUNT', forklift: fork.id });
  __test.setState(f.sim.snapshot(), acct(f));
  assert.ok(!cwTest.controls().includes('id="cw-menu"'), 'walking to a forklift: no menu');
  assert.equal(cwTest.menu(), null, 'and it is closed for good');
  f.cmd('workerCommand', { id: a.id, order: 'HOLD' });
  __test.setState(f.sim.snapshot(), acct(f));
  assert.ok(!cwTest.controls().includes('id="cw-menu"'), 'it does not come back by itself');
});

test('mini-map crop: a fixed zoom around the worker, a far spot shown by an edge arrow, and the crop kept while they walk its middle', async () => {
  const { cwTest } = await load();
  const vb = [-20000, -15000, 40000, 30000],
    bw = 8000,
    bh = 6000,
    yb = { x0: -18000, y0: -12000, x1: 18000, y1: 12000 };
  const near = cwTest.crop({ x: 0, y: 0 }, { x: 2000, y: 1000 }, bw, bh, vb, yb);
  assert.equal(near[2], bw, 'a near spot: the base zoom');
  const far = cwTest.crop({ x: 0, y: 0 }, { x: 17000, y: 11000 }, bw, bh, vb, yb);
  assert.equal(far[2], bw, 'a far spot never zooms out to the whole yard');
  assert.equal(far[3], bh);
  for (const c of [near, far])
    assert.ok(
      0 >= c[0] + c[2] * 0.19 && 0 <= c[0] + c[2] * 0.81 && 0 >= c[1] + c[3] * 0.19 && 0 <= c[1] + c[3] * 0.81,
      'the worker stays well inside: ' + c,
    );
  assert.ok(far[0] + far[2] / 2 > 0 && far[1] + far[3] / 2 > 0, 'the crop leans towards the far spot');
  const edge = cwTest.crop({ x: -15000, y: -9000 }, null, bw, bh, vb, yb);
  assert.ok(edge[0] >= vb[0] && edge[1] >= vb[1], 'kept inside the plan');
  assert.ok(
    edge[0] >= yb.x0 - bw * 0.08 - 1 && edge[1] >= yb.y0 - bh * 0.14 - 1,
    'not a third of road outside the fence: ' + edge,
  );
  // Walking across the middle keeps the crop still; near an edge it re-crops.
  const crop = far;
  let moves = 0;
  for (let x = 0; x <= 2400; x += 400) if (!cwTest.keep(crop, { x, y: x * 0.6 })) moves++;
  assert.equal(moves, 0, 'no re-crop on every poll');
  assert.equal(
    cwTest.keep(crop, { x: crop[0] + crop[2] * 0.95, y: crop[1] + crop[3] / 2 }),
    false,
    'near the edge it re-crops',
  );
});

test('plain words: priority, results, the supervisor who follows a link to someone else, and a site crew member', async (t) => {
  const f = fixture(t),
    { __test, cwTest } = await load();
  const [w] = crewOf(f);
  assert.equal(
    cwTest.priority({ ladder: { y: [{ priority: 4, label: 'Returned material' }] } }, 'y', {
      priority: 4,
      origin: 'MANUAL',
    }),
    'Priority 4 of 1 – set by the office',
  );
  assert.equal(
    cwTest.priority(
      {
        ladder: {
          y: Array.from({ length: 8 }, (_, i) => ({ priority: i + 1, label: i === 3 ? 'Returned material' : 'x' })),
        },
      },
      'y',
      { priority: 4, origin: 'AUTO' },
    ),
    'Priority 4 of 8 – returned material',
  );
  assert.equal(
    cwTest.result('Pre-start due recorded (no checklist captured)'),
    'Pre-start due marked done – no checklist filled in',
  );
  __test.setState(f.sim.snapshot(), acct(f, ['requests.create', 'sites.assigned']));
  cwTest.open('someone-else');
  const h = cwTest.hero();
  assert.ok(
    h.includes('Not on your sites') && !h.includes('another company'),
    'a supervisor is told the worker is not on their sites',
  );
  const site = f.sim.snapshot().resources.find((r) => r.type === 'WORKER' && r.location === f.site.id);
  cwTest.open(site.id);
  const now = cwTest.nowCard();
  assert.ok(
    now.includes('Standing by for crane moves at Site A') && !now.includes('job board'),
    'site crew wait for crane moves',
  );
  __test.setState(f.sim.snapshot(), acct(f));
  cwTest.open(w.id);
  const card = cwTest.nowCard();
  assert.ok(
    /<svg aria-hidden="true" focusable="false"/.test(card),
    'the map picture is hidden from screen readers (the figure describes it)',
  );
  assert.ok(card.includes('role="img"'));
  assert.ok(!/top rung/.test(cwTest.view()), 'no engine words');
});
