// Phase 0 security (audit D1-D6, D12): the audit's probe scripts (sec-probe, fc-eng/probe, rebind) turned into tests.
// Every request goes through the real HTTP server with a Host header we choose (fetch cannot set Host, so node:http is used).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.js';
import { Service } from '../src/service.js';
import { createApp, hostAllowed, listenHost } from '../src/server.js';
import { createBackups } from '../src/backups.js';

const pw = 'a-long-test-password';
const company = (k) => ({
  companyName: 'Yard ' + k,
  name: 'Owner ' + k,
  email: k + '@example.test',
  password: pw,
  systems: ['quickstage'],
});
// Temp folders go when the whole file is done (every database and server in them is closed by then).
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'scaffold-sec-'));
  dirs.push(dir);
  return dir;
};
// Registration is closed by default; a test that needs a second company opens it for its own duration.
const openRegistration = (t) => {
  const was = process.env.SCAFFOLD_OPEN_REGISTRATION;
  process.env.SCAFFOLD_OPEN_REGISTRATION = '1';
  t.after(() => {
    if (was === undefined) delete process.env.SCAFFOLD_OPEN_REGISTRATION;
    else process.env.SCAFFOLD_OPEN_REGISTRATION = was;
  });
};
async function serve(t, db, options) {
  const server = createApp(db, options);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;
  const req = (method, path, { body, cookie, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body),
        h = { host: '127.0.0.1:' + port, ...headers };
      if (cookie) h.cookie = cookie;
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
          resolve({ status: res.statusCode, headers: res.headers, json, text: s });
        });
      });
      r.on('error', reject);
      if (data !== null) r.write(data);
      r.end();
    });
  return { port, req };
}
const cookieOf = (r) => (r.headers['set-cookie'] || [])[0]?.split(';')[0];
const tokenOf = (link) => new URL(link).hash.replace(/^#invite=/, '');

test('F2 (rebind.log): a forged Host gets 421 before anything runs; Origin must match an allowed Host; Referrer-Policy is same-origin', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const { port, req } = await serve(t, db);
  const evil = { host: `attacker.example:${port}`, origin: `http://attacker.example:${port}` };
  const rebound = await req('POST', '/api/register', { body: company('rebind'), headers: evil });
  assert.equal(rebound.status, 421, 'the rebinding probe registered a company (200) before the fix');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM companies').get().n, 0, 'nothing was created');
  for (const path of ['/', '/health', '/api/systems', '/app.js'])
    assert.equal((await req('GET', path, { headers: { host: 'attacker.example:' + port } })).status, 421, path);
  assert.equal((await req('GET', '/health', { headers: { host: 'localhost:' + port } })).status, 200);
  assert.equal((await req('GET', '/health', { headers: { host: '[::1]:' + port } })).status, 200);
  const page = await req('GET', '/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['referrer-policy'], 'same-origin');
  assert.equal(
    (
      await req('POST', '/api/login', {
        body: { email: 'x@example.test', password: pw },
        headers: { origin: 'http://evil.example' },
      })
    ).status,
    403,
    'a foreign Origin with the real Host',
  );
  assert.equal(
    (await req('POST', '/api/login', { body: { email: 'x@example.test', password: pw }, headers: { origin: 'null' } }))
      .status,
    403,
  );
});

test("host allowlist: loopback always; this PC's own addresses and name only while Wi-Fi sharing is on; extra names only when configured", () => {
  const pc = { hostname: 'YARD-PC', addresses: ['192.168.1.20', 'fe80::1'] };
  for (const h of ['127.0.0.1:3000', 'localhost:3000', 'LOCALHOST', '[::1]:3000', '127.0.0.1'])
    assert.equal(hostAllowed(h, { ...pc, lan: false }), true, h);
  for (const h of [
    '192.168.1.20:3000',
    'yard-pc:3000',
    'attacker.example:3000',
    '127.0.0.1.attacker.example',
    '',
    undefined,
    '127.0.0.2:3000',
    '[fe80::1]:3000',
  ])
    assert.equal(hostAllowed(h, { ...pc, lan: false }), false, String(h));
  for (const h of ['192.168.1.20:3000', 'YARD-PC:3000', 'yard-pc.local:3000', '[fe80::1]:3000'])
    assert.equal(hostAllowed(h, { ...pc, lan: true }), true, h);
  assert.equal(hostAllowed('192.168.1.21:3000', { ...pc, lan: true }), false, 'another machine on the network');
  assert.equal(hostAllowed('yard.example.com', { ...pc, lan: false, extra: ['yard.example.com'] }), true);
  assert.equal(hostAllowed('evil.com:3000', { ...pc, lan: true, extra: ['yard.example.com'] }), false);
});

test('D5: the server listens on this PC only unless Wi-Fi sharing is switched on (HOST still wins)', () => {
  assert.equal(listenHost({ env: {}, lanSharing: false }), '127.0.0.1');
  assert.equal(listenHost({ env: {}, lanSharing: true }), '0.0.0.0');
  assert.equal(listenHost({ env: { HOST: '127.0.0.1' }, lanSharing: true }), '127.0.0.1');
  const launcher = readFileSync(new URL('../scripts/launch.cmd', import.meta.url), 'utf8');
  assert.ok(!/HOST=0\.0\.0\.0/.test(launcher), 'the desktop launcher no longer opens the port to the whole network');
});

test('D4: registration is open on a new server only; afterwards 403 unless the administrator switches it on', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const { req } = await serve(t, db);
  assert.deepEqual((await req('GET', '/api/welcome')).json, { register: true }, 'a new server offers "Create company"');
  const first = await req('POST', '/api/register', { body: company('first') });
  assert.equal(first.status, 200, 'first run');
  const admin = cookieOf(first);
  assert.deepEqual((await req('GET', '/api/welcome')).json, { register: false });
  const second = await req('POST', '/api/register', { body: company('second') });
  assert.equal(second.status, 403, 'open registration returned 200 before the fix');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM companies').get().n, 1);
  const me = (await req('GET', '/api/me', { cookie: admin })).json;
  assert.equal(me.admin, true, 'whoever creates the first company runs the server');
  assert.deepEqual((await req('GET', '/api/server-settings', { cookie: admin })).json.openRegistration, false);
  assert.equal(
    (await req('POST', '/api/server-settings', { cookie: admin, body: { openRegistration: true } })).status,
    200,
  );
  assert.equal(
    (await req('POST', '/api/register', { body: company('second') })).status,
    200,
    'switched on by the administrator',
  );
  const other = cookieOf(await req('POST', '/api/login', { body: { email: 'second@example.test', password: pw } }));
  assert.equal(
    (await req('GET', '/api/me', { cookie: other })).json.admin,
    false,
    'a later company owner is not the administrator',
  );
  assert.equal(
    (await req('POST', '/api/server-settings', { cookie: other, body: { openRegistration: false } })).status,
    403,
  );
  assert.equal((await req('GET', '/api/server-settings', { cookie: other })).status, 403);
  assert.equal(
    (await req('POST', '/api/server-settings', { cookie: admin, body: { openRegistration: false } })).status,
    200,
  );
  assert.equal((await req('POST', '/api/register', { body: company('third') })).status, 403);
  openRegistration(t);
  assert.equal(
    (await req('POST', '/api/register', { body: company('third') })).status,
    200,
    'SCAFFOLD_OPEN_REGISTRATION=1 (tests and the browser suite)',
  );
});

test('D3 (fc-eng/probe.log): register, users and memberships answer the same for a known and an unknown email', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const { req } = await serve(t, db);
  const a = cookieOf(await req('POST', '/api/register', { body: company('a') }));
  openRegistration(t);
  cookieOf(await req('POST', '/api/register', { body: company('b') }));
  delete process.env.SCAFFOLD_OPEN_REGISTRATION;
  const same = (x, y, label) => {
    assert.equal(x.status, y.status, label);
    assert.deepEqual(Object.keys(x.json).sort(), Object.keys(y.json).sort(), label);
    if (x.json.error || y.json.error) assert.equal(x.json.error, y.json.error, label);
  };
  same(
    await req('POST', '/api/register', { body: company('b') }),
    await req('POST', '/api/register', { body: company('nobody') }),
    'register (409 "That email cannot be used." before)',
  );
  const known = { name: 'X', email: 'b@example.test', password: pw, roles: ['SUPERVISOR'] },
    unknown = { ...known, email: 'nobody@example.test' };
  const u1 = await req('POST', '/api/users', { cookie: a, body: known }),
    u2 = await req('POST', '/api/users', { cookie: a, body: unknown });
  same(u1, u2, 'users');
  assert.equal(u1.status, 201);
  const m1 = await req('POST', '/api/memberships', { cookie: a, body: { email: 'b@example.test', roles: ['OWNER'] } }),
    m2 = await req('POST', '/api/memberships', {
      cookie: a,
      body: { email: 'nobody2@example.test', roles: ['OWNER'] },
    });
  same(m1, m2, 'memberships (201 vs 404 "No existing account has that email" before)');
  assert.equal(m1.status, 201);
  // The invitation page shows the same things whether or not the email already signs in somewhere.
  const i1 = await req('POST', '/api/invitation', { body: { token: tokenOf(m1.json.link) } }),
    i2 = await req('POST', '/api/invitation', { body: { token: tokenOf(m2.json.link) } });
  same(i1, i2, 'invitation details');
});

test("F1 (fc-eng/probe.log): a membership needs the invitee's own acceptance, the link works once, and an owner can remove a member", async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const { req } = await serve(t, db);
  const a = cookieOf(await req('POST', '/api/register', { body: company('a') }));
  openRegistration(t);
  const b = cookieOf(await req('POST', '/api/register', { body: company('b') }));
  const names = async (c) => (await req('GET', '/api/me', { cookie: c })).json.memberships.map((m) => m.name).sort();
  const invite = await req('POST', '/api/memberships', {
    cookie: a,
    body: { email: 'b@example.test', roles: ['OWNER'] },
  });
  assert.equal(invite.status, 201);
  assert.deepEqual(
    await names(b),
    ['Yard b'],
    'B is NOT made a member of A without saying yes (201 + membership before the fix)',
  );
  const token = tokenOf(invite.json.link);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM invitations WHERE token_hash=?').get(token).n,
    0,
    'only a hash of the link is stored',
  );
  const info = (await req('POST', '/api/invitation', { body: { token } })).json;
  assert.equal(info.company, 'Yard a');
  assert.deepEqual(info.roles, ['OWNER']);
  assert.equal(info.email, 'b@example.test');
  assert.equal(
    (await req('POST', '/api/accept-invite', { body: { token, name: 'B', password: 'the-wrong-password' } })).status,
    400,
  );
  assert.deepEqual(await names(b), ['Yard b']);
  const accepted = await req('POST', '/api/accept-invite', { body: { token, name: 'B', password: pw } });
  assert.equal(accepted.status, 200);
  const bInA = cookieOf(accepted);
  assert.equal(
    (await req('GET', '/api/me', { cookie: bInA })).json.company.name,
    'Yard a',
    'signed in to the company that invited them',
  );
  assert.deepEqual(await names(b), ['Yard a', 'Yard b']);
  assert.equal(
    (await req('POST', '/api/accept-invite', { body: { token, name: 'B', password: pw } })).status,
    404,
    'the link works once',
  );
  assert.equal((await req('POST', '/api/invitation', { body: { token } })).status, 404);
  // A new person sets their own password.
  const sup = await req('POST', '/api/users', {
    cookie: a,
    body: { name: 'Sam', email: 'sam@example.test', roles: ['SUPERVISOR'] },
  });
  const samIn = await req('POST', '/api/accept-invite', {
    body: { token: tokenOf(sup.json.link), name: 'Sam', password: 'sams-own-password' },
  });
  assert.equal(samIn.status, 200);
  const sam = cookieOf(
    await req('POST', '/api/login', { body: { email: 'sam@example.test', password: 'sams-own-password' } }),
  );
  assert.ok(sam);
  assert.deepEqual((await req('GET', '/api/me', { cookie: sam })).json.roles, ['SUPERVISOR']);
  // Expired and cancelled links are refused.
  const late = await req('POST', '/api/users', {
    cookie: a,
    body: { name: 'Late', email: 'late@example.test', roles: ['SUPERVISOR'] },
  });
  db.prepare('UPDATE invitations SET expires_at=0 WHERE email=?').run('late@example.test');
  assert.equal(
    (await req('POST', '/api/accept-invite', { body: { token: tokenOf(late.json.link), name: 'Late', password: pw } }))
      .status,
    404,
  );
  const gone = await req('POST', '/api/users', {
    cookie: a,
    body: { name: 'Gone', email: 'gone@example.test', roles: ['SUPERVISOR'] },
  });
  assert.equal((await req('POST', '/api/invitations/cancel', { cookie: a, body: { id: gone.json.id } })).status, 200);
  assert.equal(
    (await req('POST', '/api/accept-invite', { body: { token: tokenOf(gone.json.link), name: 'Gone', password: pw } }))
      .status,
    404,
  );
  assert.equal(
    (await req('POST', '/api/invitations/cancel', { cookie: b, body: { id: late.json.id } })).status,
    404,
    "another company cannot touch A's invitations",
  );
  // Pending invitations are listed for the people who can invite; a fresh link replaces the old one.
  const pending = (await req('GET', '/api/me', { cookie: a })).json.invitations;
  assert.deepEqual(
    pending.map((i) => i.email),
    ['late@example.test'],
  );
  const renewed = await req('POST', '/api/invitations/renew', { cookie: a, body: { id: late.json.id } });
  assert.equal(renewed.status, 200);
  assert.equal(
    (await req('POST', '/api/invitation', { body: { token: tokenOf(late.json.link) } })).status,
    404,
    'the old link stops working',
  );
  assert.equal((await req('POST', '/api/invitation', { body: { token: tokenOf(renewed.json.link) } })).status, 200);
  // Removing a member (there was no route: 404 in sec-probe.log).
  const users = (await req('GET', '/api/me', { cookie: a })).json.users,
    samId = users.find((u) => u.email === 'sam@example.test').id,
    bId = users.find((u) => u.email === 'b@example.test').id,
    aId = users.find((u) => u.email === 'a@example.test').id;
  const audits = db.prepare('SELECT COUNT(*) n FROM audit_events').get().n;
  assert.equal(
    (await req('POST', '/api/members/remove', { cookie: sam, body: { userId: bId } })).status,
    403,
    'a supervisor cannot',
  );
  assert.equal((await req('POST', '/api/members/remove', { cookie: a, body: { userId: samId } })).status, 200);
  assert.equal(
    (await req('GET', '/api/me', { cookie: sam })).status,
    401,
    'their session in that company ends at once',
  );
  const gone2 = await req('POST', '/api/login', { body: { email: 'sam@example.test', password: 'sams-own-password' } });
  assert.deepEqual(
    [gone2.status, gone2.json.error],
    [403, 'You are no longer in any company here. Ask an owner to invite you again.'],
    'with no company left they cannot sign in, and are told why (not "password is incorrect")',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM audit_events').get().n,
    audits + 1,
    'history is kept; the removal is recorded',
  );
  assert.equal(
    (await req('POST', '/api/members/remove', { cookie: a, body: { userId: aId } })).status,
    409,
    'not yourself',
  );
  // A runs this server (the first company): while Yard a is A's only company, nobody can remove A from it (the server would have nobody to run it).
  const locked = await req('POST', '/api/members/remove', { cookie: bInA, body: { userId: aId } });
  assert.equal(locked.status, 409);
  assert.match(locked.json.error, /runs Scaffold Yard on this computer/);
  assert.equal((await req('GET', '/api/me', { cookie: a })).status, 200, 'A is still in');
  const aToB = await req('POST', '/api/memberships', {
    cookie: b,
    body: { email: 'a@example.test', roles: ['SUPERVISOR'] },
  });
  assert.equal(
    (await req('POST', '/api/accept-invite', { body: { token: tokenOf(aToB.json.link), password: pw } })).status,
    200,
    'an existing sign-in says yes with just the password',
  );
  assert.equal(
    (await req('POST', '/api/members/remove', { cookie: bInA, body: { userId: aId } })).status,
    200,
    'B (an owner of A by acceptance) may remove another owner who has another company',
  );
  assert.equal((await req('GET', '/api/me', { cookie: a })).status, 401);
  const a2 = cookieOf(await req('POST', '/api/login', { body: { email: 'a@example.test', password: pw } }));
  assert.equal(
    (await req('GET', '/api/me', { cookie: a2 })).json.company.name,
    'Yard b',
    'A signs in to the company A still has',
  );
  assert.equal(
    (await req('POST', '/api/members/remove', { cookie: bInA, body: { userId: bId } })).status,
    409,
    'never yourself, so an owner can never remove the last owner',
  );
  assert.deepEqual(await names(b), ['Yard a', 'Yard b'], 'removing A did not touch B');
  // Someone removed can be invited back and says yes again.
  const back = await req('POST', '/api/users', {
    cookie: bInA,
    body: { name: 'Sam', email: 'sam@example.test', roles: ['GENERAL_MANAGER'] },
  });
  assert.equal(
    (
      await req('POST', '/api/accept-invite', {
        body: { token: tokenOf(back.json.link), name: 'Sam', password: 'sams-own-password' },
      })
    ).status,
    200,
  );
  const samBack = cookieOf(
    await req('POST', '/api/login', { body: { email: 'sam@example.test', password: 'sams-own-password' } }),
  );
  assert.deepEqual(
    (await req('GET', '/api/me', { cookie: samBack })).json.roles,
    ['GENERAL_MANAGER'],
    'the old roles did not come back',
  );
});

test('invitations: managers invite managers and supervisors, never owners; only owners remove people', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const s = new Service(db),
    owner = s.authenticate(s.register(company('o')));
  s.addUser(owner, { name: 'GM', email: 'gm@example.test', password: pw, roles: ['GENERAL_MANAGER'] });
  const gm = s.authenticate(s.login({ email: 'gm@example.test', password: pw }));
  assert.match(s.invite(gm, { email: 'sup@example.test', roles: ['SUPERVISOR'] }).token, /^[0-9a-f]{64}$/);
  assert.throws(() => s.invite(gm, { email: 'boss@example.test', roles: ['OWNER'] }), { status: 403 });
  s.addUser(owner, { name: 'Sup', email: 's@example.test', password: pw, roles: ['SUPERVISOR'] });
  const sup = s.authenticate(s.login({ email: 's@example.test', password: pw }));
  assert.throws(() => s.invite(sup, { email: 'x@example.test', roles: ['SUPERVISOR'] }), { status: 403 });
  assert.throws(() => s.removeMember(gm, { userId: sup.id }), { status: 403 });
  assert.throws(() => s.invite(owner, { email: 'x@example.test', roles: ['ADMIN'] }), { status: 400 });
  assert.throws(() => s.invite(owner, { email: 'not-an-email', roles: ['SUPERVISOR'] }), { status: 400 });
});

test('D6: only the server administrator sees file paths and backs up the whole server', async (t) => {
  const dir = temp(),
    path = join(dir, 'live.sqlite'),
    db = openDatabase(path);
  t.after(() => db.close());
  const backups = createBackups({ databasePath: path, directory: join(dir, 'b'), log: () => {} });
  const { req } = await serve(t, db, { backups });
  const a = cookieOf(await req('POST', '/api/register', { body: company('a') }));
  openRegistration(t);
  const b = cookieOf(await req('POST', '/api/register', { body: company('b') }));
  const mine = await req('GET', '/api/backups', { cookie: a });
  assert.equal(mine.json.databasePath, path);
  const theirs = await req('GET', '/api/backups', { cookie: b });
  assert.equal(theirs.status, 200);
  assert.ok(!('databasePath' in theirs.json) && !('directory' in theirs.json), 'B saw databasePath before the fix');
  assert.ok(
    !theirs.text.includes(dir.replaceAll('\\', '\\\\')) && !/[A-Za-z]:\\\\|\/tmp\//.test(theirs.text),
    'no filesystem path at all: ' + theirs.text,
  );
  assert.equal(theirs.json.serverManaged, true);
  assert.equal(
    (await req('POST', '/api/backup-now', { cookie: b, body: {} })).status,
    403,
    'a tenant owner cannot copy the whole server',
  );
  const made = await req('POST', '/api/backup-now', { cookie: a, body: {} });
  assert.equal(made.status, 200);
  assert.ok(existsSync(made.json.file));
  for (const route of ['/api/me', '/api/server-settings'])
    assert.ok(!(await req('GET', route, { cookie: b })).text.includes(dir.replaceAll('\\', '\\\\')), route);
});

test('D6: SCAFFOLD_ADMIN_EMAIL names the administrator instead', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const s = new Service(db);
  const first = s.authenticate(s.register(company('first')));
  const later = s.authenticate(s.register(company('later')));
  assert.equal(s.isAdmin(first), true);
  assert.equal(s.isAdmin(later), false);
  const was = process.env.SCAFFOLD_ADMIN_EMAIL;
  process.env.SCAFFOLD_ADMIN_EMAIL = 'Later@Example.test';
  t.after(() => {
    if (was === undefined) delete process.env.SCAFFOLD_ADMIN_EMAIL;
    else process.env.SCAFFOLD_ADMIN_EMAIL = was;
  });
  assert.equal(s.isAdmin(first), false);
  assert.equal(s.isAdmin(later), true);
});

// A database as it was before migration 006 (schema 5): made now, then everything 006 added dropped again.
function beforeSix(dir, people) {
  const path = join(dir, 'v5.sqlite');
  const db = openDatabase(path, { backupDirectory: null });
  people(new Service(db), db);
  db.exec(
    'DROP TABLE invitations;DROP TABLE server_settings;DROP TABLE server_admins;ALTER TABLE memberships DROP COLUMN removed_at;DELETE FROM schema_migrations WHERE version=6',
  );
  db.close();
  return path;
}
test('migration 006: exactly one administrator, whoever created the first company; strangers who signed up later (or the F2 rebinding account) get nothing', (t) => {
  const tick = (() => {
    let n = 0;
    return () => {
      const at = new Date(Date.parse('2026-09-01T00:00:00Z') + n++ * 60000).toISOString();
      return at;
    };
  })();
  const path = beforeSix(temp(), (s, db) => {
    for (const k of ['owner', 'later', 'rebind2']) {
      s.register(company(k));
      db.prepare(
        "UPDATE audit_events SET created_at=? WHERE action='company.created' AND actor_id=(SELECT id FROM users WHERE email=?)",
      ).run(tick(), k + '@example.test');
    }
    const owner = s.authenticate(s.login({ email: 'owner@example.test', password: pw }));
    s.addUser(owner, { name: 'Sup', email: 'sup@example.test', password: pw, roles: ['SUPERVISOR'] });
  });
  const db = openDatabase(path, { backupDirectory: null });
  t.after(() => db.close());
  const s = new Service(db);
  const who = (e) => s.authenticate(s.login({ email: e, password: pw }));
  assert.deepEqual(
    db
      .prepare('SELECT u.email FROM server_admins a JOIN users u ON u.id=a.user_id')
      .all()
      .map((r) => r.email),
    ['owner@example.test'],
    'every company creator became an administrator before the fix',
  );
  assert.equal(s.isAdmin(who('owner@example.test')), true, 'the owner on his own PC keeps Backups');
  for (const e of ['later@example.test', 'rebind2@example.test', 'sup@example.test'])
    assert.equal(s.isAdmin(who(e)), false, e);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM pragma_table_info('memberships') WHERE name='removed_at'").get().n,
    1,
  );
  assert.deepEqual(
    s.serverSettings(),
    { openRegistration: false, lanSharing: false, lanNotice: true },
    'a server already in use says once that phones stopped at the update',
  );
  s.saveServerSettings(who('owner@example.test'), { lanSharing: false });
  assert.equal(s.serverSettings().lanNotice, false, 'saving the settings answers it');
});
test('migration 006 with no "company created" record: the first owner of the oldest company; a new server has no administrator and no notice until the first sign-up', (t) => {
  const path = beforeSix(temp(), (s, db) => {
    s.register(company('first'));
    s.register(company('second'));
    db.exec("DELETE FROM audit_events WHERE action='company.created'");
    db.prepare("UPDATE companies SET created_at='2020-01-01T00:00:00Z' WHERE name='Yard first'").run();
  });
  const db = openDatabase(path, { backupDirectory: null });
  t.after(() => db.close());
  assert.deepEqual(
    db
      .prepare('SELECT u.email FROM server_admins a JOIN users u ON u.id=a.user_id')
      .all()
      .map((r) => r.email),
    ['first@example.test'],
  );
  const fresh = openDatabase(':memory:');
  t.after(() => fresh.close());
  assert.equal(fresh.prepare('SELECT COUNT(*) n FROM server_admins').get().n, 0);
  assert.deepEqual(new Service(fresh).serverSettings(), {
    openRegistration: false,
    lanSharing: false,
    lanNotice: false,
  });
});
test('removing a member cancels their open invitations, so a removed owner cannot let themselves back in (secrev probe.log)', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const { req } = await serve(t, db);
  const a = cookieOf(await req('POST', '/api/register', { body: company('a') }));
  // Carol joins as a co-owner; Alice (not the server administrator here: a second company is hers too) invites her own email as OWNER, and a manager Mia invites a supervisor
  const carolIn = await req('POST', '/api/users', {
    cookie: a,
    body: { name: 'Carol', email: 'carol@example.test', roles: ['OWNER'] },
  });
  const carol = cookieOf(
    await req('POST', '/api/accept-invite', {
      body: { token: tokenOf(carolIn.json.link), name: 'Carol', password: pw },
    }),
  );
  const aliceIn = await req('POST', '/api/users', {
    cookie: a,
    body: { name: 'Alice', email: 'alice@example.test', roles: ['OWNER'] },
  });
  const alice = cookieOf(
    await req('POST', '/api/accept-invite', {
      body: { token: tokenOf(aliceIn.json.link), name: 'Alice', password: pw },
    }),
  );
  const miaIn = await req('POST', '/api/users', {
    cookie: a,
    body: { name: 'Mia', email: 'mia@example.test', roles: ['GENERAL_MANAGER'] },
  });
  const mia = cookieOf(
    await req('POST', '/api/accept-invite', { body: { token: tokenOf(miaIn.json.link), name: 'Mia', password: pw } }),
  );
  const self = await req('POST', '/api/invitations', {
    cookie: alice,
    body: { email: 'alice@example.test', roles: ['OWNER'] },
  });
  assert.equal(self.status, 201);
  const bySomeoneElse = await req('POST', '/api/invitations', {
    cookie: carol,
    body: { email: 'alice@example.test', roles: ['SUPERVISOR'] },
  });
  const miaSup = await req('POST', '/api/invitations', {
    cookie: mia,
    body: { email: 'mias-mate@example.test', roles: ['SUPERVISOR'] },
  });
  const ids = (await req('GET', '/api/me', { cookie: carol })).json.users,
    idOf = (e) => ids.find((u) => u.email === e).id;
  assert.equal(
    (await req('POST', '/api/members/remove', { cookie: carol, body: { userId: idOf('alice@example.test') } })).status,
    200,
  );
  for (const [label, made] of [
    ['her own OWNER link', self],
    ['a link to her email from someone else', bySomeoneElse],
  ]) {
    assert.equal(
      (await req('POST', '/api/accept-invite', { body: { token: tokenOf(made.json.link), password: pw } })).status,
      404,
      label + ' (200 and OWNER again before the fix)',
    );
  }
  assert.equal(
    (await req('POST', '/api/login', { body: { email: 'alice@example.test', password: pw } })).status,
    403,
    'Alice stays out',
  );
  // A removed manager's outstanding invitations stop working; even one left open (made before this fix) is refused, because the inviter is no longer a member.
  db.prepare('UPDATE invitations SET cancelled_at=NULL').run();
  assert.equal(
    (await req('POST', '/api/members/remove', { cookie: carol, body: { userId: idOf('mia@example.test') } })).status,
    200,
  );
  db.prepare('UPDATE invitations SET cancelled_at=NULL WHERE email=?').run('mias-mate@example.test');
  assert.equal((await req('POST', '/api/invitation', { body: { token: tokenOf(miaSup.json.link) } })).status, 404);
  assert.equal(
    (
      await req('POST', '/api/accept-invite', {
        body: { token: tokenOf(miaSup.json.link), name: 'Mate', password: pw },
      })
    ).status,
    404,
  );
  assert.equal(
    (await req('POST', '/api/accept-invite', { body: { token: tokenOf(self.json.link), password: pw } })).status,
    404,
    'the inviter was removed',
  );
});
test('D3: accepting an invitation answers the same for an email that already signs in and one that does not (secrev probe.log)', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const { req } = await serve(t, db);
  const a = cookieOf(await req('POST', '/api/register', { body: company('a') }));
  openRegistration(t);
  await req('POST', '/api/register', { body: company('b') });
  delete process.env.SCAFFOLD_OPEN_REGISTRATION;
  const known = await req('POST', '/api/invitations', {
      cookie: a,
      body: { email: 'b@example.test', roles: ['SUPERVISOR'] },
    }),
    ghost = await req('POST', '/api/invitations', {
      cookie: a,
      body: { email: 'ghost@example.test', roles: ['SUPERVISOR'] },
    });
  const answer = async (made, body) => {
    const r = await req('POST', '/api/accept-invite', { body: { token: tokenOf(made.json.link), ...body } });
    return [r.status, r.json.error];
  };
  for (const body of [
    { password: 'x' },
    { password: 'a-wrong-but-long-password' },
    { name: '', password: 'a-wrong-but-long-password' },
    { name: 'Someone', password: 'short' },
  ]) {
    assert.deepEqual(
      await answer(known, body),
      await answer(ghost, body),
      JSON.stringify(body) + ' ([401,"That password does not match"] vs [400,"Name is required"] before the fix)',
    );
  }
  assert.equal((await answer(known, { password: 'x' }))[0], 400);
  assert.equal(
    (await answer(ghost, { name: 'Ghost', password: pw }))[0],
    200,
    'a new person with a name and a good password joins',
  );
  assert.equal(
    (await answer(known, { password: pw }))[0],
    200,
    'the known person with their own password joins (no name needed)',
  );
});
test('SCAFFOLD_ADMIN_EMAIL naming an email with no account yet: nobody can claim it by invitation or sign-up (secrev adminemail.mjs)', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const { req } = await serve(t, db);
  const was = process.env.SCAFFOLD_ADMIN_EMAIL;
  process.env.SCAFFOLD_ADMIN_EMAIL = 'Boss@Example.test';
  t.after(() => {
    if (was === undefined) delete process.env.SCAFFOLD_ADMIN_EMAIL;
    else process.env.SCAFFOLD_ADMIN_EMAIL = was;
  });
  const tenant = cookieOf(await req('POST', '/api/register', { body: company('t') }));
  assert.equal((await req('GET', '/api/me', { cookie: tenant })).json.admin, false);
  const inv = await req('POST', '/api/invitations', {
    cookie: tenant,
    body: { email: 'boss@example.test', roles: ['SUPERVISOR'] },
  });
  assert.equal(inv.status, 403, 'the takeover link was 201, then accepted, then admin:true before the fix');
  assert.match(inv.json.error, /kept for the person who runs this server/);
  openRegistration(t);
  assert.equal(
    (await req('POST', '/api/register', { body: { ...company('x'), email: 'boss@example.test' } })).status,
    403,
    'nor by sign-up',
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE email='boss@example.test'").get().n, 0);
  // On a new server the named person makes their account first, and is the administrator.
  const fresh = openDatabase(':memory:');
  t.after(() => fresh.close());
  const s = new Service(fresh);
  const boss = s.authenticate(s.register({ ...company('boss'), email: 'boss@example.test' }));
  assert.equal(s.isAdmin(boss), true);
  const other = s.authenticate(s.register(company('other')));
  assert.equal(s.isAdmin(other), false);
  assert.throws(
    () => s.removeMember(other, { userId: boss.id }),
    { status: 404 },
    'another company cannot touch them anyway',
  );
});
test('server-wide changes (Wi-Fi sharing, sign-up, the encrypted copy, Back up now, the restore test) are made at this PC only, never from a phone', async (t) => {
  const { fromThisPC } = await import('../src/server.js');
  for (const a of ['127.0.0.1', '127.0.0.5', '::1', '::ffff:127.0.0.1']) assert.equal(fromThisPC(a), true, a);
  for (const a of ['192.168.1.20', '::ffff:192.168.1.20', 'fe80::1', '10.0.0.2', undefined, ''])
    assert.equal(fromThisPC(a), false, String(a));
  const lanIp = (await import('node:os')).networkInterfaces();
  const ip = Object.values(lanIp)
    .flat()
    .find((i) => i && !i.internal && i.family === 'IPv4')?.address;
  if (!ip) {
    t.skip('no Wi-Fi/LAN address on this machine');
    return;
  }
  const dir = temp(),
    path = join(dir, 'live.sqlite'),
    db = openDatabase(path);
  t.after(() => db.close());
  const s = new Service(db),
    token = s.register(company('a'));
  const backups = createBackups({ databasePath: path, directory: join(dir, 'b'), log: () => {} });
  const server = createApp(db, { backups, lan: true });
  await new Promise((r) => server.listen(0, ip, r));
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;
  const call = (method, p, body) =>
    new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null,
        h = { host: ip + ':' + port, cookie: 'session=' + token };
      if (data) {
        h['content-type'] = 'application/json';
        h['content-length'] = Buffer.byteLength(data);
      }
      const r = http.request({ host: ip, port, path: p, method, headers: h }, (res) => {
        let x = '';
        res.on('data', (c) => (x += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(x) }));
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  assert.equal((await call('GET', '/api/me')).json.admin, true, 'the administrator, on a phone');
  const settings = await call('GET', '/api/server-settings');
  assert.equal(settings.status, 200);
  assert.equal(settings.json.atThisPC, false);
  assert.equal((await call('GET', '/api/backups')).json.atThisPC, false);
  for (const [p, body] of [
    ['/api/server-settings', { lanSharing: true, openRegistration: true }],
    ['/api/backup-offsite', { folder: dir, passphrase: 'correct horse battery staple' }],
    ['/api/backup-now', {}],
    ['/api/restore-drill', {}],
  ]) {
    const r = await call('POST', p, body);
    assert.deepEqual([r.status, r.json.error], [403, 'Do this on the computer that runs Scaffold Yard.'], p);
  }
  assert.deepEqual(
    s.serverSettings(),
    { openRegistration: false, lanSharing: false, lanNotice: false },
    'nothing changed',
  );
});

// ---- D12: the port is claimed before the database, the engine or the backups are touched ----
const freePort = () =>
  new Promise((r) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
function start(t, env) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: (() => {
      const e = { ...process.env, ...env };
      delete e.HOST;
      return e;
    })(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  return {
    child,
    out: () => out,
    exited,
    until: async (re, ms = 15000) => {
      const end = Date.now() + ms;
      while (!re.test(out) && Date.now() < end && child.exitCode === null) await new Promise((r) => setTimeout(r, 50));
      return re.test(out);
    },
  };
}
test('D12: a busy port stops the start cleanly, before the database or backups are opened', async (t) => {
  const dir = temp(),
    port = await freePort(),
    other = net.createServer();
  await new Promise((r) => other.listen(port, '127.0.0.1', r));
  t.after(() => other.close());
  const run = start(t, { PORT: String(port), DATABASE_PATH: join(dir, 'x.sqlite'), BACKUP_DIR: join(dir, 'b') });
  const code = await Promise.race([run.exited, new Promise((r) => setTimeout(() => r('still running'), 15000))]);
  assert.equal(code, 1, run.out());
  assert.match(run.out(), new RegExp(`port ${port} is in use`, 'i'));
  assert.ok(!/EADDRINUSE|at Server\.|node:events/.test(run.out()), 'no crash dump: ' + run.out());
  assert.equal(
    existsSync(join(dir, 'x.sqlite')),
    false,
    'the database was not opened (the engine and backups had started before the fix)',
  );
  assert.equal(existsSync(join(dir, 'b')), false);
});
test('D12: when Scaffold Yard itself holds the port the start says so and exits quietly', async (t) => {
  const dir = temp(),
    port = await freePort();
  const fake = http.createServer((q, s) => {
    s.writeHead(200, { 'Content-Type': 'application/json' });
    s.end(JSON.stringify({ status: 'ok', mode: 'simulation', database: 6 }));
  });
  await new Promise((r) => fake.listen(port, '127.0.0.1', r));
  t.after(() => fake.close());
  const run = start(t, { PORT: String(port), DATABASE_PATH: join(dir, 'x.sqlite'), BACKUP_DIR: join(dir, 'b') });
  const code = await Promise.race([run.exited, new Promise((r) => setTimeout(() => r('still running'), 15000))]);
  assert.equal(code, 0, run.out());
  assert.match(run.out(), /Scaffold Yard is already running/);
  assert.equal(existsSync(join(dir, 'x.sqlite')), false);
});
test('D5 + D12: a normal start listens on 127.0.0.1 only and answers only when ready', async (t) => {
  const dir = temp(),
    port = await freePort();
  const run = start(t, { PORT: String(port), DATABASE_PATH: join(dir, 'x.sqlite'), BACKUP_DIR: join(dir, 'b') });
  assert.ok(await run.until(/Scaffold Yard: http:\/\/127\.0\.0\.1:\d+/), run.out());
  assert.ok(!/other devices|Wi-Fi/.test(run.out()), run.out());
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  run.child.kill();
  await run.exited;
});
// od-restart.mjs: a server closed hard leaves the movement engine held for up to 5 s, and a quick restart used to stop at once ("Another movement engine is running..").
const heldEngine = (path, ms) => {
  const db = openDatabase(path, { backupDirectory: null });
  db.prepare(
    'INSERT INTO engine_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at',
  ).run('closed-hard', Date.now() + ms);
  db.close();
};
test('a restart right after a hard close waits for the engine to be let go, then starts', async (t) => {
  const dir = temp(),
    port = await freePort(),
    path = join(dir, 'x.sqlite');
  heldEngine(path, 3000);
  const run = start(t, { PORT: String(port), DATABASE_PATH: path, BACKUP_DIR: join(dir, 'b') });
  assert.ok(await run.until(/Scaffold Yard: http:\/\/127\.0\.0\.1:\d+/, 20000), run.out());
  assert.ok(!/did NOT start/.test(run.out()), run.out());
  run.child.kill();
  await run.exited;
});
test('an engine still held after the wait: a plain message, one full stop, exit 1', async (t) => {
  const dir = temp(),
    port = await freePort(),
    path = join(dir, 'x.sqlite');
  heldEngine(path, 600000);
  const run = start(t, { PORT: String(port), DATABASE_PATH: path, BACKUP_DIR: join(dir, 'b') });
  const code = await Promise.race([run.exited, new Promise((r) => setTimeout(() => r('still running'), 30000))]);
  assert.equal(code, 1, run.out());
  assert.match(
    run.out(),
    /Scaffold Yard did NOT start: Scaffold Yard is already running for this database, or is still closing\. Wait a minute, then open it again\.\r?\n/,
  );
  assert.ok(!/\.\.\s*$/m.test(run.out()), 'no double full stop: ' + run.out());
});

test('the sign-in throttle counts failures only (probe: 12 correct sign-ins gave 429 from the 7th)', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const { req } = await serve(t, db);
  assert.equal((await req('POST', '/api/register', { body: company('a') })).status, 200);
  const good = [];
  for (let i = 0; i < 12; i++)
    good.push((await req('POST', '/api/login', { body: { email: 'a@example.test', password: pw } })).status);
  assert.deepEqual(good, Array(12).fill(200));
  const bad = [];
  for (let i = 0; i < 12; i++)
    bad.push(
      (await req('POST', '/api/login', { body: { email: 'a@example.test', password: 'not-the-password' } })).status,
    );
  assert.deepEqual(bad, [...Array(10).fill(401), 429, 429]);
  assert.equal(
    (await req('POST', '/api/login', { body: { email: 'a@example.test', password: pw } })).status,
    429,
    'then everything waits a minute',
  );
});
