process.env.TZ = 'Australia/Sydney';
// What a real yard looks like (the LIVE board v0) next to the Practice yard, and "Start your real yard" over HTTP. Rendered HTML through the
// board's own exports and the served API; no ticks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { Service } from '../src/service.js';
import { createApp } from '../src/server.js';
import { __gm } from '../public/game.js';
import { switchChoices } from '../public/mode.js';
import { liveFixture } from './helpers/live-fixture.js';

const PRACTICE = 'class="gm-practice" title="The crew, trucks and deliveries on this board are simulated.';
const LIVE = 'class="gm-practice gm-live"';
function boards(t) {
  const f = liveFixture(t);
  const s = new Service(f.db);
  const account = (user) => ({ ...s.snapshot(user), permissions: s.permissions(user) });
  const liveAccount = account(f.user),
    demoAccount = account(f.owner);
  return {
    f,
    live: () => ({ state: f.sim.snapshot(0, { lean: true }), account: liveAccount, hire: true }),
    demo: (sim) => ({ state: sim.snapshot(0, { lean: true }), account: demoAccount, hire: true }),
    liveAccount,
    demoAccount,
  };
}

test('the LIVE board: "Live · your real yard" chip; Send and Bring back make exact orders; a site keeps Remove site and its usual drive', (t) => {
  const b = boards(t);
  __gm.reset();
  const html = __gm.shell(b.live());
  assert.ok(html.includes(LIVE) && html.includes('Live<span class="gm-practice-yard"> &middot; your real yard</span>'));
  assert.ok(!html.includes(PRACTICE), 'never the Practice chip in the real yard');
  assert.ok(html.includes('data-gm-go="send"') && html.includes('data-gm-go="back"'), 'Send and Bring back (part 2)');
  assert.ok(html.includes('data-gm-go="add"'), 'Add stock is record keeping');
  const s = b.live().state;
  assert.deepEqual(__gm.hint(s), {
    id: 'live-send',
    text: 'Tap Send to order exact pieces for Bondi. Trucks move here only when a driver confirms.',
    act: ['Send', 'send'],
    point: 'send',
  });
  __gm.setMode('site', b.f.site.id);
  const acts = __gm.acts(s);
  assert.match(acts, /data-gm-go="send"/);
  assert.match(acts, /data-gm-mins=/, "the site's usual drive from the yard, typed or learnt");
  assert.match(acts, /data-sf-remove=/, 'Remove site stays: a site made by mistake can go (nothing recorded there)');
  // what the board draws: the yard and the site from records, trucks parked where they are, nobody walking about
  assert.deepEqual(
    s.trucks.map((x) => [x.name, x.status, x.at === b.f.yard.id]),
    [['T-01', 'AT_YARD', true]],
  );
  assert.ok(
    s.resources.every((r) => !Number.isFinite(r.x)),
    'no one has a simulated position on the map',
  );
  assert.ok(!s.resources.some((r) => r.type === 'CRANE'), 'no invented site crane');
});

test('the Office in a real yard: no Control room or Schedule; the Practice yard keeps all its places', (t) => {
  const b = boards(t);
  const liveTiles = [...__gm.office({ ...b.live(), view: 'HOME' }).matchAll(/data-view="(\w+)"/g)].map((m) => m[1]);
  assert.ok(!liveTiles.includes('CONTROL') && !liveTiles.includes('SCHEDULE'), liveTiles.join());
  for (const v of ['HOME', 'TODAY', 'STOCK', 'MATERIALS', 'SITES', 'WORKERS', 'TRUCK12', 'HIRE', 'REPORTS'])
    assert.ok(liveTiles.includes(v), v);
  const demoTiles = [
    ...__gm.office({ state: null, account: b.demoAccount, hire: true, view: 'HOME' }).matchAll(/data-view="(\w+)"/g),
  ].map((m) => m[1]);
  assert.ok(
    demoTiles.includes('CONTROL') && demoTiles.includes('SCHEDULE'),
    'the Practice yard: every place, as before',
  );
});

test('someone in both yards taps the chip for two big choices: the Practice yard first, then the real yard', (t) => {
  const b = boards(t);
  __gm.reset();
  const html = __gm.shell(b.live());
  assert.ok(html.includes('data-gm-switch'), 'the chip is a button');
  const pop = html.slice(html.indexOf('data-gm-switch-pop'));
  const names = [...pop.matchAll(/<b>([^<]+)<\/b>/g)].map((m) => m[1]).slice(0, 2);
  assert.deepEqual(names, ['Practice yard', 'Tee Scaffolding']);
  assert.match(
    pop,
    /class="sy-choice is-live current" data-sy-switch="[^"]+" data-sy-name="Tee Scaffolding" aria-current="true" disabled/,
  );
  assert.match(pop, /<small>tee · simulated, to try things out<\/small>/);
  // the Practice yard's board: the same chip as always, inside the switch button
  __gm.reset();
  const demo = __gm.shell({ state: null, account: b.demoAccount, hire: true });
  assert.ok(demo.includes(PRACTICE) && demo.includes('data-gm-switch'));
  // one company: nothing changes (no button, no choices)
  const one = { ...b.demoAccount, memberships: b.demoAccount.memberships.slice(0, 1) };
  __gm.reset();
  const solo = __gm.shell({ state: null, account: one, hire: true });
  assert.ok(solo.includes(PRACTICE) && !solo.includes('data-gm-switch'));
  assert.equal(switchChoices([], 'x'), '<div class="sy-switch" role="group" aria-label="Choose a yard"></div>');
});

test('"Start your real yard" over HTTP: an owner makes it and is switched into it; a manager is refused; /api/me says the mode', async (t) => {
  process.env.SCAFFOLD_OPEN_REGISTRATION = '1';
  const db = openDatabase(':memory:'),
    server = createApp(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (jar, path, body) => {
    const r = await fetch(base + '/api/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), cookie: jar.cookie ?? '' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const c = r.headers.get('set-cookie');
    if (c) jar.cookie = c.split(';')[0];
    return { status: r.status, body: await r.json() };
  };
  const owner = {};
  const email = randomUUID() + '@example.com';
  await call(owner, 'register', {
    name: 'Tee',
    companyName: 'tee',
    email,
    password: 'demonstration-password',
    systems: ['quickstage'],
  });
  let me = (await call(owner, 'me')).body;
  assert.equal(me.company.mode, 'DEMO');
  assert.equal(me.canStartLive, true);
  const made = await call(owner, 'live-company', { name: 'Tee Scaffolding', timeZone: 'Australia/Perth' });
  assert.equal(made.status, 201);
  me = (await call(owner, 'me')).body;
  assert.deepEqual(
    [me.company.name, me.company.mode, me.company.timeZone],
    ['Tee Scaffolding', 'LIVE', 'Australia/Perth'],
  );
  assert.deepEqual(
    me.memberships.map((m) => m.mode),
    ['DEMO', 'LIVE'],
  );
  const st = (await call(owner, 'state')).body;
  assert.equal(st.companyMode, 'LIVE');
  assert.equal(st.yards.length, 0, 'empty: the yard size comes next');
  const refused = await call(owner, 'commands/seed', {});
  assert.equal(refused.status, 409, 'the synthetic demo catalogue is not for a real yard');
  assert.match(refused.body.error, /^Not in your real yard yet/);
  assert.equal((await call(owner, 'commands/gameStart', { size: 'S' })).status, 200, 'its yard size, the first step');
  // back to the Practice yard: everything as it was
  await call(owner, 'switch-company', { companyId: me.memberships[0].id });
  assert.equal((await call(owner, 'me')).body.company.mode, 'DEMO');
  // a general manager may not start one
  const s = new Service(db);
  const ownerUser = s.authenticate(s.login({ email, password: 'demonstration-password' }));
  const inv = s.invite(
    { ...ownerUser, company_id: me.memberships[0].id },
    {
      email: randomUUID() + '@example.com',
      roles: ['GENERAL_MANAGER'],
    },
  );
  const gm = {};
  await call(gm, 'accept-invite', { token: inv.token, name: 'Manager', password: 'demonstration-password' });
  assert.equal((await call(gm, 'me')).body.canStartLive, false);
  const no = await call(gm, 'live-company', { name: 'Mine' });
  assert.equal(no.status, 403);
  assert.equal(no.body.error, 'Only an owner can start a real yard.');
});
