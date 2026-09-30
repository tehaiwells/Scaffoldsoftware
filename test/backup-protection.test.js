// D13 data protection: a checked copy before any start-up migration, an encrypted copy somewhere else, and a logged restore drill.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/database.js';
import { Service } from '../src/service.js';
import { createApp } from '../src/server.js';
import { createBackups } from '../src/backups.js';
import { backupName } from '../src/paths.js';
import { createBackupKey, encryptBackup, decryptBackup, readDrillLog } from '../src/protect.js';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'scaffold-protect-test-'));
  dirs.push(dir);
  return dir;
};
const owner = {
  companyName: 'Protect DEMO',
  name: 'Owner',
  email: 'owner@example.test',
  password: 'a-long-test-password',
  systems: ['quickstage'],
};
const quiet = () => {
  const lines = [];
  const log = (line) => lines.push(line);
  log.lines = lines;
  return log;
};
const FAST = { N: 1024 }; // test-only scrypt cost (the app uses the full cost)
const PASS = 'correct horse battery staple';
// A clock that moves on a minute per call, so two backups in one test never share a file name.
const clock = () => {
  let t = Date.parse('2026-09-30T08:00:00Z');
  return () => new Date((t += 60000));
};
const version = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v;
  } finally {
    db.close();
  }
};
const companies = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT COUNT(*) n FROM companies').get().n;
  } finally {
    db.close();
  }
};
// A database one migration behind: made now, then the newest migration (6, invitations) undone by dropping what it added, so it runs again cleanly.
function olderDatabase(dir) {
  const path = join(dir, 'live', 'scaffold.sqlite');
  const db = openDatabase(path, { backupDirectory: null });
  new Service(db).register(owner);
  db.exec(
    'DROP TABLE invitations;DROP TABLE server_settings;DROP TABLE server_admins;ALTER TABLE memberships DROP COLUMN removed_at;DELETE FROM schema_migrations WHERE version=6',
  );
  db.close();
  return path;
}

test('before a start-up migration changes an existing database, a checked copy of it as it was is saved first', () => {
  const dir = temp(),
    path = olderDatabase(dir),
    backups = join(dir, 'backups');
  assert.equal(version(path), 5);
  const db = openDatabase(path, { backupDirectory: backups, backupName: 'scaffold' });
  db.close();
  assert.equal(version(path), 6, 'the migration ran');
  const saved = readdirSync(backups);
  assert.equal(saved.length, 1, 'one copy');
  assert.match(saved[0], /^scaffold-before-update-v5-to-v6-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sqlite$/);
  assert.equal(version(join(backups, saved[0])), 5, 'the copy is the database before the update');
  assert.equal(companies(join(backups, saved[0])), 1, 'with the data in it');
});

test('no copy for a new database or one that is already up to date; scripts without a folder save next to the database', () => {
  const dir = temp(),
    backups = join(dir, 'backups'),
    fresh = join(dir, 'fresh.sqlite');
  openDatabase(fresh, { backupDirectory: backups }).close();
  openDatabase(fresh, { backupDirectory: backups }).close();
  assert.equal(existsSync(backups), false, 'nothing to protect, nothing saved');
  openDatabase(':memory:').close();
  const path = olderDatabase(dir);
  openDatabase(path).close();
  assert.equal(readdirSync(join(dir, 'live', 'before-update')).length, 1, 'default folder next to the database');
});

test('if the copy cannot be saved, the migration does not run and the database is left as it was', () => {
  const dir = temp(),
    path = olderDatabase(dir),
    blocked = join(dir, 'not-a-folder');
  writeFileSync(blocked, 'x');
  assert.throws(
    () => openDatabase(path, { backupDirectory: blocked }),
    /Could not save a copy of the database before updating it/,
  );
  assert.equal(version(path), 5, 'not migrated');
});

test('encrypted copy: AES-256-GCM with a key only the passphrase unlocks; the passphrase is never stored; tampering and a wrong passphrase are refused', () => {
  const dir = temp(),
    src = join(dir, 'plain.sqlite');
  const db = openDatabase(src, { backupDirectory: null });
  new Service(db).register(owner);
  db.close();
  const key = createBackupKey(PASS, FAST),
    stored = JSON.stringify(key);
  assert.ok(!stored.includes(PASS), 'no passphrase in what is kept');
  assert.ok(!stored.includes('PRIVATE KEY'), 'no unprotected private key in what is kept');
  const enc = join(dir, 'plain.sqlite.enc');
  encryptBackup(src, enc, key);
  const bytes = readFileSync(enc);
  assert.ok(!bytes.includes(Buffer.from('Protect DEMO')), 'the company name is not readable in the copy');
  assert.ok(!bytes.includes(Buffer.from('SQLite format 3')));
  assert.deepEqual(
    decryptBackup(enc, PASS),
    readFileSync(src),
    'the passphrase alone restores it (the copy carries its own locked key)',
  );
  assert.throws(() => decryptBackup(enc, 'the wrong passphrase'), /passphrase is not right/);
  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 10] ^= 1;
  writeFileSync(enc, tampered);
  assert.throws(() => decryptBackup(enc, PASS), /damaged or changed/);
  assert.throws(() => createBackupKey('short', FAST), /at least 12 characters/);
});

test('with an encrypted copy folder set, every backup is also copied there encrypted; a missing folder never stops the normal backup', async () => {
  const dir = temp(),
    path = join(dir, 'live.sqlite'),
    backups = join(dir, 'backups'),
    usb = join(dir, 'usb');
  mkdirSync(usb);
  const db = openDatabase(path, { backupDirectory: null });
  new Service(db).register(owner);
  const log = quiet(),
    b = createBackups({
      databasePath: path,
      directory: backups,
      log,
      settingsPath: join(dir, 'offsite-backup.json'),
      minGapMs: 0,
      keyCost: FAST,
      now: clock(),
    });
  assert.equal(b.status().offsite.configured, false);
  await b.setOffsite({ folder: usb, passphrase: PASS });
  assert.equal(b.status().offsite.configured, true);
  const settings = readFileSync(join(dir, 'offsite-backup.json'), 'utf8');
  assert.ok(!settings.includes(PASS));
  const r = await b.backupNow();
  assert.equal(r.ok, true, r.error);
  const copies = readdirSync(usb);
  assert.equal(copies.length, 1);
  assert.match(copies[0], /-manual\.sqlite\.enc$/);
  assert.deepEqual(decryptBackup(join(usb, copies[0]), PASS), readFileSync(r.file));
  assert.equal(b.status().offsite.lastCopy.ok, true);
  rmSync(usb, { recursive: true });
  const again = await b.backupNow();
  assert.equal(again.ok, true, 'the normal backup still worked');
  const st = b.status().offsite;
  assert.equal(st.lastCopy.ok, false);
  assert.match(st.lastCopy.error, /folder .* is not there/);
  await assert.rejects(b.setOffsite({ folder: join(dir, 'nowhere'), passphrase: PASS }), /That folder was not found/);
  await assert.rejects(b.setOffsite({ folder: 'relative\\path', passphrase: PASS }), /full folder path/);
  // "somewhere else" means somewhere else: not the backup folder in other letters or a folder inside it, not the live database's folder, never a network share
  // (secrev case.mjs: the backup folder in other letter case was accepted, and the encrypted copies landed next to the plain ones)
  mkdirSync(join(backups, 'inside'), { recursive: true });
  const other = process.platform === 'win32' ? backups.toUpperCase() : backups;
  for (const folder of [other, join(backups, 'inside'), backups + sep, dir])
    await assert.rejects(
      b.setOffsite({ folder, passphrase: PASS }),
      /different place from the normal backup folder and the live database/,
      folder,
    );
  for (const folder of ['\\\\attacker\\share', '//attacker/share'])
    await assert.rejects(b.setOffsite({ folder, passphrase: PASS }), /not a network share/, folder);
  b.clearOffsite();
  assert.equal(b.status().offsite.configured, false);
  assert.equal(existsSync(join(dir, 'offsite-backup.json')), false);
  db.close();
});

test('HTTP: the encrypted copy is set up and turned off by an owner; the key material never leaves the server', async (t) => {
  const dir = temp(),
    path = join(dir, 'live.sqlite'),
    usb = join(dir, 'usb');
  mkdirSync(usb);
  const db = openDatabase(path, { backupDirectory: null }),
    service = new Service(db);
  const token = service.register(owner);
  const backups = createBackups({
    databasePath: path,
    directory: join(dir, 'backups'),
    log: quiet(),
    settingsPath: join(dir, 'offsite-backup.json'),
    keyCost: FAST,
  });
  const server = createApp(db, { backups });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (p, body, cookie = token) =>
    fetch(base + '/api/' + p, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', cookie: 'session=' + cookie },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const other = service.register({ ...owner, email: 'someone@example.test', companyName: 'Other' });
  let r = await call('backup-offsite', { folder: usb, passphrase: 'short' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /at least 12 characters/);
  r = await call('backup-offsite', { folder: usb, passphrase: PASS });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.offsite.configured, true);
  r = await call('backups');
  const text = JSON.stringify(r.body);
  assert.ok(
    !text.includes('PRIVATE') && !text.includes('publicKey') && !text.includes(PASS),
    'no key material in the status',
  );
  r = await call('backup-offsite', { off: true });
  assert.equal(r.body.offsite.configured, false);
  const guest = await fetch(base + '/api/backup-offsite', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(guest.status, 401);
  assert.ok(other);
});

const root = fileURLToPath(new URL('..', import.meta.url));
const drill = (env, args = []) =>
  spawnSync(process.execPath, ['scripts/restore-drill.js', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, SCAFFOLD_BACKUP_PASSPHRASE: '', ...env },
  });

test('restore drill: restores the newest backup into a temporary folder, checks it and compares row counts, and logs the result', async () => {
  const dir = temp(),
    path = join(dir, 'live.sqlite'),
    backups = join(dir, 'backups'),
    usb = join(dir, 'usb');
  mkdirSync(usb);
  const db = openDatabase(path, { backupDirectory: null });
  new Service(db).register(owner);
  const b = createBackups({
    databasePath: path,
    directory: backups,
    name: backupName({ env: { DATABASE_PATH: path }, databasePath: path }),
    log: quiet(),
    settingsPath: join(dir, 'offsite-backup.json'),
    minGapMs: 0,
    keyCost: FAST,
    now: clock(),
  });
  const env = { DATABASE_PATH: path, BACKUP_DIR: backups, SCAFFOLD_BACKUP_SETTINGS: join(dir, 'offsite-backup.json') };
  let r = drill(env);
  assert.equal(r.status, 1, 'no backup yet');
  assert.match(r.stdout + r.stderr, /No backup found/);
  assert.equal((await b.backupNow()).ok, true);
  db.close();
  r = drill(env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Restore drill PASSED/);
  assert.match(r.stdout, /integrity: ok/);
  assert.match(r.stdout, /companies\s+1\s+1/);
  let last = readDrillLog(backups);
  assert.equal(last.ok, true);
  assert.equal(last.encrypted, false);
  assert.equal(last.integrity, 'ok');
  assert.equal(last.rows.companies, 1);
  assert.equal(b.status().lastDrill.ok, true, 'Account > Backups shows the last drill');
  assert.equal(b.status().lastDrill.at, last.at);
  // The encrypted copy: the drill asks for the passphrase (here from the environment) and proves it opens.
  const db2 = openDatabase(path, { backupDirectory: null });
  await b.setOffsite({ folder: usb, passphrase: PASS });
  assert.equal((await b.backupNow()).ok, true);
  db2.close();
  r = drill({ ...env, SCAFFOLD_BACKUP_PASSPHRASE: PASS }, ['--encrypted']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /encrypted copy/);
  last = readDrillLog(backups);
  assert.equal(last.encrypted, true);
  assert.equal(last.ok, true);
  r = drill({ ...env, SCAFFOLD_BACKUP_PASSPHRASE: 'not the passphrase' }, ['--encrypted']);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /passphrase is not right/);
  assert.match(r.stdout, /not logged as a drill/);
  assert.ok(!/\.\.\r?$/m.test(r.stdout), 'one full stop: ' + r.stdout);
  last = readDrillLog(backups);
  assert.equal(
    last.ok,
    true,
    'a wrong passphrase restored nothing, so Account keeps showing the last real test (it showed "did not pass" before)',
  );
  r = drill(env, ['--encrypted']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /needs its passphrase/);
  assert.equal(readDrillLog(backups).ok, true, 'nor a missing one');
  // A damaged plain backup fails the drill.
  const newest = readdirSync(backups)
      .filter((n) => n.endsWith('.sqlite'))
      .sort()
      .at(-1),
    file = join(backups, newest),
    bytes = readFileSync(file);
  bytes.fill(0x55, 4096, bytes.length);
  writeFileSync(file, bytes);
  r = drill(env, ['--file=' + file]);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /Restore drill FAILED/);
  assert.equal(readDrillLog(backups).ok, false);
  assert.equal(
    readFileSync(join(backups, 'restore-drill.log'), 'utf8').trim().split('\n').length,
    4,
    'one line per drill that restored something or found nothing to restore; none for a missing or wrong passphrase',
  );
});

test('Account "Test the newest backup" runs the drill on the server and the card shows when it last passed; an encrypted copy is unlocked by npm run decrypt-backup', async (t) => {
  const dir = temp(),
    path = join(dir, 'live.sqlite'),
    usb = join(dir, 'usb');
  mkdirSync(usb);
  const db = openDatabase(path, { backupDirectory: null }),
    service = new Service(db);
  const token = service.register(owner);
  const backups = createBackups({
    databasePath: path,
    directory: join(dir, 'backups'),
    log: quiet(),
    settingsPath: join(dir, 'offsite-backup.json'),
    keyCost: FAST,
    minGapMs: 0,
    now: clock(),
  });
  const server = createApp(db, { backups });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    db.close();
  });
  const call = (p, body) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/${p}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', cookie: 'session=' + token },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  let r = await call('restore-drill', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.drill.ok, false, 'nothing to test yet');
  assert.match(r.body.drill.error, /No backup found/);
  assert.equal((await call('backup-now', {})).status, 200);
  r = await call('restore-drill', {});
  assert.equal(r.body.drill.ok, true, r.body.drill.error);
  assert.equal(r.body.lastDrill.ok, true);
  assert.equal(r.body.lastDrill.at, r.body.drill.at);
  r = await call('backup-offsite', { folder: usb, passphrase: PASS });
  assert.equal(r.body.offsite.lastCopy.ok, true, 'the newest backup is copied at once');
  const copy = r.body.offsite.lastCopy.file,
    out = join(dir, 'unlocked.sqlite');
  const run = (pass) =>
    spawnSync(process.execPath, ['scripts/decrypt-backup.js', copy, out], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, SCAFFOLD_BACKUP_PASSPHRASE: pass },
    });
  let d = run('');
  assert.equal(d.status, 1);
  assert.match(d.stderr, /needs its passphrase/, 'nobody at a keyboard and none given');
  assert.equal(existsSync(out), false);
  d = run('not the passphrase at all');
  assert.equal(d.status, 1);
  assert.match(d.stderr, /passphrase is not right/);
  assert.equal(existsSync(out), false);
  d = run(PASS);
  assert.equal(d.status, 0, d.stderr);
  assert.equal(companies(out), 1);
  d = run(PASS);
  assert.equal(d.status, 1, 'never overwrites');
});
