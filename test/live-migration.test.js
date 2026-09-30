// Migration 007 (LIVE mode, company time zone, ledger provenance) on an existing database: every company becomes the Practice yard (DEMO),
// every old ledger row is ENGINE with occurred_at = created_at, and nothing else changes. SCAFFOLD_MIGRATION_SAMPLE=<a copy of a real
// database at schema 6> runs the same check on that copy too (never the live database: the copy is copied again into a temp folder).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, atomic } from '../src/database.js';
import { Service } from '../src/service.js';
import { Simulation } from '../src/simulation.js';

const UNDO_007 =
  'DROP TRIGGER companies_mode_fixed;DROP TRIGGER ledger_live_people_only;ALTER TABLE companies DROP COLUMN mode;ALTER TABLE companies DROP COLUMN time_zone;' +
  'ALTER TABLE ledger DROP COLUMN occurred_at;ALTER TABLE ledger DROP COLUMN actor_kind;ALTER TABLE ledger DROP COLUMN on_behalf_of;ALTER TABLE ledger DROP COLUMN origin;' +
  'DELETE FROM schema_migrations WHERE version=7';
const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'scaffold-mig-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
// Every row of every table, by rowid (the ledger and companies without their new columns, so old and new can be compared).
function dump(path, { without = {} } = {}) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const out = {};
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()) {
      const cols = db
        .prepare(`PRAGMA table_info("${name}")`)
        .all()
        .map((c) => c.name)
        .filter((c) => !(without[name] ?? []).includes(c));
      const hasRowid = !/WITHOUT ROWID/i.test(
        db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name).sql,
      );
      out[name] = JSON.stringify(
        db
          .prepare(`SELECT ${cols.map((c) => `"${c}"`).join(',')} FROM "${name}" ${hasRowid ? 'ORDER BY rowid' : ''}`)
          .all(),
      );
    }
    return out;
  } finally {
    db.close();
  }
}
const NEW = {
  companies: ['mode', 'time_zone'],
  ledger: ['occurred_at', 'actor_kind', 'on_behalf_of', 'origin'],
};
// backups: where the copy saved before the update goes (null: none, as other tests); when given, the copy must be the database as it was.
function checkMigrated(path, backups = null) {
  const before = dump(path),
    db = openDatabase(path, { backupDirectory: backups });
  try {
    assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE version=7').get());
    const companies = db.prepare('SELECT mode,time_zone FROM companies').all();
    assert.ok(companies.length > 0);
    assert.ok(
      companies.every((c) => c.mode === 'DEMO' && c.time_zone === 'Australia/Sydney'),
      'every company is DEMO',
    );
    const odd = db
      .prepare(
        "SELECT COUNT(*) n FROM ledger WHERE actor_kind<>'ENGINE' OR occurred_at IS NOT created_at OR on_behalf_of IS NOT NULL OR origin<>'before-provenance'",
      )
      .get().n;
    assert.equal(odd, 0, 'old ledger rows: ENGINE, occurred when recorded');
    assert.throws(
      () => db.prepare("UPDATE ledger SET reason='x'").run(),
      /append only/,
      'the ledger is append-only again',
    );
  } finally {
    db.close();
  }
  if (backups) {
    const saved = readdirSync(backups).filter((n) => /-before-update-v6-to-v7-.*.sqlite$/.test(n));
    assert.equal(saved.length, 1, 'one copy saved before the update: ' + readdirSync(backups).join(', '));
    assert.deepEqual(dump(join(backups, saved[0])), before, 'the copy is the database exactly as it was');
  }
  const after = dump(path, { without: NEW });
  delete before.schema_migrations;
  delete after.schema_migrations;
  assert.deepEqual(Object.keys(after), Object.keys(before), 'no table added or dropped');
  for (const name of Object.keys(before)) assert.equal(after[name], before[name], name + ' unchanged');
}

test('migration 007 on a database with Practice yards in use: all DEMO, old ledger rows ENGINE, nothing else changed', (t) => {
  const dir = temp(t),
    path = join(dir, 'scaffold.sqlite');
  const db = openDatabase(path, { backupDirectory: null }),
    auth = new Service(db);
  for (const name of ['tee', 'Harbour Scaffolds']) {
    const user = auth.authenticate(
      auth.register({
        name: 'Owner',
        companyName: name,
        email: randomUUID() + '@example.com',
        password: 'demonstration-password',
        systems: ['quickstage'],
      }),
    );
    const sim = new Simulation(db, user),
      cmd = (a, i = {}) => sim.execute(a, i, randomUUID());
    cmd('gameStart', { size: 'S' });
    cmd('gameCatalogue');
    const p = sim.repo
      .all('product')
      .map((x) => sim.effective(x.id))
      .find((x) => x.unitWeight > 0 && x.packQuantity == null);
    cmd('gameAddStock', { lines: [{ product: p.id, quantity: 20 }] });
    const site = cmd('gameSite', { name: 'Bondi' }).site;
    cmd('gameSend', { site: site.id, lines: [{ product: p.id, quantity: 10 }] });
    for (let i = 0; i < 60; i++) atomic(db, () => sim.tick(1000));
  }
  db.exec(UNDO_007);
  db.close();
  checkMigrated(path, join(dir, 'before-update'));
});

test('migration 007 on a copy of a real database (SCAFFOLD_MIGRATION_SAMPLE)', (t) => {
  const sample = process.env.SCAFFOLD_MIGRATION_SAMPLE;
  if (!sample || !existsSync(sample)) {
    t.skip('no sample database given');
    return;
  }
  const dir = temp(t),
    path = join(dir, 'sample.sqlite');
  for (const ext of ['', '-wal', '-shm']) if (existsSync(sample + ext)) copyFileSync(sample + ext, path + ext);
  const v = new DatabaseSync(path);
  try {
    assert.equal(v.prepare('SELECT MAX(version) v FROM schema_migrations').get().v, 6, 'the sample is at schema 6');
    v.exec('DELETE FROM engine_lease;PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    v.close();
  }
  checkMigrated(path, join(dir, 'before-update'));
});
