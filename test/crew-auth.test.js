process.env.TZ = 'Australia/Sydney';
// A driver's phone (ADR 0009, thin #5), through the real HTTP server: the office makes a link, the phone claims it and gets its own long-lived
// cookie, which opens only /api/crew/*; the driver sees and confirms their own trips only; the office signs a phone out. Then 50 offline /
// online switches with taps queued on the phone (public/crew-queue.js): 0 lost and 0 duplicated.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { Service } from '../src/service.js';
import { createCrewQueue } from '../public/crew-queue.js';
import { liveFixture } from './helpers/live-fixture.js';

// A test server on a free port of 3700-3799 (the ports this project's tools may use).
async function serve(t, db) {
  const server = createApp(db);
  for (let tries = 0; ; tries++) {
    const port = 3700 + Math.floor(Math.random() * 100);
    try {
      await new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', fail);
          ok();
        });
      });
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || tries > 50) throw error;
    }
  }
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;
  const req = (method, path, { body, cookie, key } = {}) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body),
        h = { host: '127.0.0.1:' + port };
      if (cookie) h.cookie = cookie;
      if (key) h['idempotency-key'] = key;
      if (data !== null) {
        h['content-type'] = 'application/json';
        h['content-length'] = Buffer.byteLength(data);
      }
      const r = http.request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
        let s = '';
        res.on('data', (c) => (s += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(s);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json });
        });
      });
      r.on('error', reject);
      if (data !== null) r.write(data);
      r.end();
    });
  return { port, req };
}
const cookieOf = (r, name) =>
  (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '='));
function office(f) {
  return 'session=' + new Service(f.db).session(f.owner.id, f.company);
}
function trip(f, driver = f.team.Dave, truck = f.truck, quantity = 2) {
  const o = f.cmd('orderCreate', { site: f.site.id, lines: [{ product: f.product.id, quantity }] }).order;
  return f.cmd('tripBook', { orders: [o.id], truck: truck.id, driver: driver.id }).trip;
}

test('a link for a driver, claimed once by a phone; the phone opens its own trips only; the office signs it out', async (t) => {
  const f = liveFixture(t);

  const { req } = await serve(t, f.db);
  const desk = office(f);
  const mobile = f.cmd('teamUpdate', { kind: 'driver', id: f.team.Dave.id, mobile: '0412 345 678' });
  assert.ok(mobile);
  const made = await req('POST', '/api/crew-links', { body: { driver: f.team.Dave.id }, cookie: desk });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.match(made.json.link, /\/crew#t=[0-9a-f]{64}$/);
  assert.equal(made.json.reachable, false, 'this computer only: no Wi-Fi sharing');
  assert.match(made.json.reach, /Turn on Wi-Fi sharing in Account, This computer/);
  assert.match(made.json.text, /^Hi Dave, this is .*Loaded & left and Delivered: http/);
  assert.match(made.json.sms, /^sms:\+61412345678\?&body=Hi%20Dave/);
  const token = new URL(made.json.link).hash.slice('#t='.length);
  // the Practice yard makes no phone links
  const demo = await req('POST', '/api/crew-links', {
    body: { driver: f.team.Dave.id },
    cookie: 'session=' + new Service(f.db).session(f.owner.id, f.owner.company_id),
  });
  assert.equal(demo.status, 409);
  assert.match(demo.json.error, /real yard only/);
  // claimed by the phone: its own cookie, 180 days; the link works once
  const claim = await req('POST', '/api/crew/claim', { body: { token, label: "Dave's phone" } });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.driver.name, 'Dave');
  const phone = cookieOf(claim, 'crew');
  assert.ok(phone);
  assert.match(claim.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Path=\/; Max-Age=15552000/);
  assert.equal((await req('POST', '/api/crew/claim', { body: { token } })).status, 404, 'used up');
  // the phone's cookie opens /api/crew/* and nothing else; the office's session is not a phone
  assert.equal((await req('GET', '/api/state', { cookie: phone })).status, 401);
  assert.equal((await req('GET', '/api/crew/me', { cookie: desk })).status, 401);
  // no password ever signs the driver in to the Office
  const email = f.db.prepare("SELECT email FROM users WHERE name='Dave'").get().email;
  assert.equal((await req('POST', '/api/login', { body: { email, password: 'a'.repeat(20) } })).status, 401);
  // my trips: Dave's only
  const bill = f.cmd('teamAdd', { name: 'Bill', role: 'DRIVER' }).person;
  const truck2 = f.cmd('quickAdjust', { kind: 'TRUCK', delta: 1, location: f.yard.id });
  const mine = trip(f),
    theirs = trip(f, bill, truck2);
  const me = await req('GET', '/api/crew/me', { cookie: phone });
  assert.equal(me.status, 200);
  assert.deepEqual(
    me.json.trips.map((x) => x.id),
    [mine.id],
  );
  assert.deepEqual(me.json.trips[0].next, ['tripLoaded', 'tripArrived']); // the arrival: an optional gate (ADR 0011)
  // confirm: one key per tap; the same tap again answers the same; another driver's trip is not found; nothing but the four confirmations
  const tap = await req('POST', '/api/crew/commands/tripLoaded', {
    body: { trip: mine.id },
    cookie: phone,
    key: 'tap-0000000001',
  });
  assert.equal(tap.status, 200, JSON.stringify(tap.json));
  const again = await req('POST', '/api/crew/commands/tripLoaded', {
    body: { trip: mine.id },
    cookie: phone,
    key: 'tap-0000000001',
  });
  assert.deepEqual(again.json, tap.json);
  const other = await req('POST', '/api/crew/commands/tripLoaded', {
    body: { trip: mine.id },
    cookie: phone,
    key: 'tap-0000000002',
  });
  assert.equal(other.status, 409);
  assert.equal(other.json.code, 'ALREADY_CONFIRMED', 'the phone can tell "already done" from a problem');
  assert.equal(
    (
      await req('POST', '/api/crew/commands/tripLoaded', {
        body: { trip: theirs.id },
        cookie: phone,
        key: 'tap-0000000003',
      })
    ).status,
    404,
  );
  // the office's commands are not a phone's (404); packing is a yard hand's, never a driver's (403: ADR 0010)
  for (const a of ['orderCreate', 'tripBook', 'packConfirmed', 'gameAddStock'])
    assert.equal(
      (await req('POST', '/api/crew/commands/' + a, { body: {}, cookie: phone, key: 'tap-00000000' + a })).status,
      a === 'packConfirmed' ? 403 : 404,
      a,
    );
  const rows = f.db.prepare("SELECT actor_kind FROM trip_confirmation WHERE step='LOADED'").all();
  assert.deepEqual(
    rows.map((r) => r.actor_kind),
    ['PERSON'],
  );
  // the office sees the phone and signs it out
  const devices = await req('GET', '/api/crew-devices', { cookie: desk });
  assert.equal(devices.json.devices.length, 1);
  assert.equal(devices.json.devices[0].label, "Dave's phone");
  assert.equal(
    (await req('POST', '/api/crew-devices/revoke', { body: { device: devices.json.devices[0].id }, cookie: desk }))
      .status,
    200,
  );
  assert.equal((await req('GET', '/api/crew/me', { cookie: phone })).status, 401, 'signed out at once');
  // a new link, and the phone signs itself out
  const link2 = await req('POST', '/api/crew-links', { body: { driver: f.team.Dave.id }, cookie: desk });
  const claim2 = await req('POST', '/api/crew/claim', {
    body: { token: new URL(link2.json.link).hash.slice(3) },
  });
  const phone2 = cookieOf(claim2, 'crew');
  assert.equal((await req('GET', '/api/crew/me', { cookie: phone2 })).status, 200);
  const out = await req('POST', '/api/crew/signout', { body: {}, cookie: phone2 });
  assert.equal(out.status, 200);
  assert.match(out.headers['set-cookie'][0], /^crew=; .*Max-Age=0/);
  assert.equal((await req('GET', '/api/crew/me', { cookie: phone2 })).status, 401);
  assert.equal(
    f.db
      .prepare('SELECT COUNT(*) n FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.name=? AND r.role=?')
      .get('Dave', 'CREW').n,
    1,
    'one CREW sign-in per driver, whatever the number of links',
  );
});

test('50 offline/online switches: every tap is queued with its own key and recorded exactly once (0 lost, 0 duplicated)', async (t) => {
  const f = liveFixture(t);

  const { req } = await serve(t, f.db);
  const desk = office(f);
  const made = await req('POST', '/api/crew-links', { body: { driver: f.team.Dave.id }, cookie: desk });
  const claim = await req('POST', '/api/crew/claim', { body: { token: new URL(made.json.link).hash.slice(3) } });
  const phone = cookieOf(claim, 'crew');
  const trips = [];
  for (let i = 0; i < 25; i++) trips.push(trip(f, f.team.Dave, f.truck, 1));
  // the phone's storage and network: offline drops a request before it goes; a lost answer runs on the server and never comes back
  const store = new Map();
  let online = true,
    sent = 0,
    lost = 0,
    seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const queue = createCrewQueue({ get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v) }, async (tap) => {
    if (!online) throw new Error('offline');
    sent++;
    const r = await req('POST', '/api/crew/commands/' + tap.action, { body: tap.input, cookie: phone, key: tap.key });
    if (rand() < 0.3) {
      lost++;
      throw new Error('the answer was lost');
    }
    return { status: r.status, body: r.json };
  });
  // the driver taps through the day (a tap on every switch) while the phone drops in and out of coverage 60 times
  const want = trips.flatMap((x) => [
      ['tripLoaded', { trip: x.id }],
      ['tripDelivered', { trip: x.id, receivedBy: 'Site' }],
    ]),
    taps = [];
  let switches = 0;
  for (; switches < 60; switches++) {
    online = !online;
    if (taps.length < want.length) {
      const t = queue.tap(...want[taps.length]);
      taps.push(t);
      assert.ok(
        queue.pending().some((x) => x.key === t.key),
        'stored before anything is sent',
      );
    }
    if (taps.length < want.length && rand() < 0.5) taps.push(queue.tap(...want[taps.length]));
    await queue.flush();
  }
  assert.equal(taps.length, 50);
  assert.equal(new Set(taps.map((x) => x.key)).size, 50, 'one key minted per tap');
  assert.ok(
    taps.every((x) => x.input.atSource === 'tap' && x.input.at),
    'each with the time of the tap',
  );
  // then online for good until the queue is empty (an answer lost at the very end is resent with its key)
  online = true;
  for (let i = 0; i < 50 && queue.pending().length; i++) await queue.flush();
  assert.ok(switches >= 50, switches + ' switches');
  assert.equal(queue.pending().length, 0, '0 lost');
  assert.deepEqual(queue.problems(), [], 'nothing refused');
  assert.ok(lost > 0 && sent > 50, 'answers really were lost and resent (' + lost + ' lost, ' + sent + ' sent)');
  const rows = f.db.prepare('SELECT trip_id,step FROM trip_confirmation').all();
  assert.equal(rows.length, 50, '0 duplicated');
  for (const x of trips) {
    assert.deepEqual(
      rows.filter((r) => r.trip_id === x.id).map((r) => r.step),
      ['LOADED', 'DELIVERED'],
    );
    assert.equal(f.sim.repo.get(x.id, 'trip').state, 'DELIVERED');
  }
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE event='DELIVERED'").get().n,
    25,
    'each delivery moved its pieces once',
  );
});

test('a phone in use keeps its sign-in; a signed-out phone keeps its taps; a tap the office already recorded differently is shown, not lost', async (t) => {
  const f = liveFixture(t);
  const { req } = await serve(t, f.db);
  const desk = office(f);
  const made = await req('POST', '/api/crew-links', { body: { driver: f.team.Dave.id }, cookie: desk });
  const claim = await req('POST', '/api/crew/claim', { body: { token: new URL(made.json.link).hash.slice(3) } });
  const phone = cookieOf(claim, 'crew');
  // used again two hours later: the browser's cookie gets its 180 days again, not only the server's record
  assert.equal((await req('GET', '/api/crew/me', { cookie: phone })).headers['set-cookie'], undefined);
  f.setTime(Date.now() + 2 * 3600000);
  const me = await req('GET', '/api/crew/me', { cookie: phone });
  assert.match(
    me.headers['set-cookie'][0],
    new RegExp('^' + phone + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=15552000'),
  );
  // the office delivers for Dave while his phone has no signal; his phone had tapped Delivered with 1 fewer and another name
  const x = trip(f, f.team.Dave, f.truck, 5);
  f.cmd('tripLoaded', { trip: x.id });
  const store = new Map();
  let online = false;
  const queue = createCrewQueue({ get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v) }, async (tap) => {
    if (!online) throw new Error('offline');
    const r = await req('POST', '/api/crew/commands/' + tap.action, { body: tap.input, cookie: phone, key: tap.key });
    return { status: r.status, body: r.json };
  });
  queue.tap('tripDelivered', { trip: x.id, receivedBy: 'Mo Ali', lines: [{ product: f.product.id, quantity: 4 }] });
  await queue.flush();
  f.cmd('tripDelivered', { trip: x.id, receivedBy: 'Site foreman' });
  online = true;
  await queue.flush();
  assert.equal(queue.pending().length, 0);
  const [p] = queue.problems();
  assert.equal(p.conflict.same, false, 'not dropped without a word');
  assert.equal(p.conflict.recorded.receivedBy, 'Site foreman');
  assert.equal(p.conflict.recorded.lines[0].quantity, 5);
  assert.equal(
    f.sim.repo.all('notification').filter((n) => n.title === 'Driver says different').length,
    1,
    'the office is told',
  );
  // signed out from the office while a tap waits: the tap stays on the phone (401), and goes once a new link signs it in
  const y = trip(f, f.team.Dave, f.truck, 2);
  const devs = await req('GET', '/api/crew-devices', { cookie: desk });
  await req('POST', '/api/crew-devices/revoke', { body: { device: devs.json.devices[0].id }, cookie: desk });
  queue.tap('tripLoaded', { trip: y.id });
  await queue.flush();
  assert.equal(queue.pending().length, 1, 'kept');
  assert.equal(queue.signedOut(), true);
});
