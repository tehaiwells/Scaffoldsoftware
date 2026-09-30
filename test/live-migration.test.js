// Migration 007 (LIVE mode, company time zone, ledger provenance) on an existing database: every company becomes the Practice yard (DEMO),
// every old ledger row is ENGINE with occurred_at = created_at, and nothing else changes. SCAFFOLD_MIGRATION_SAMPLE=<a copy of a real
// database at schema 5 or 6> runs the same check on that copy too (never the live database: the copy is copied again into a temp folder).
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

// Migrations 008 (trips, a driver's phone), 009 (charge lines, the YARD role), 010 (statements, the ACCOUNTS role) and 011 (ADR 0012:
// the trip_arrival table, the plan-day, roster and task indexes) come after it and are undone first (their triggers read companies.mode).
const UNDO_011 =
  'DROP TRIGGER trip_arrival_no_update;DROP TRIGGER trip_arrival_no_delete;DROP TRIGGER trip_arrival_live_only;DROP TABLE trip_arrival;DROP INDEX objects_plan_day;' +
  'DROP INDEX IF EXISTS objects_roster_person_day;DROP INDEX IF EXISTS objects_roster_day;DROP INDEX IF EXISTS objects_task_day;DROP INDEX IF EXISTS objects_task_list;DELETE FROM schema_migrations WHERE version=11;';
const UNDO_010 =
  UNDO_011 +
  'DROP TRIGGER objects_statement_no_update;DROP TRIGGER objects_statement_no_delete;DROP INDEX objects_statement_number;DROP INDEX objects_statement_customer;DROP INDEX objects_site_customer;DROP TABLE statement_items;DROP TABLE statement_exports;' +
  "DELETE FROM role_permissions WHERE role='ACCOUNTS' OR permission IN ('statements.manage','customers.manage');DELETE FROM permissions WHERE code IN ('statements.manage','customers.manage');DELETE FROM roles WHERE code='ACCOUNTS';DELETE FROM schema_migrations WHERE version=10;";
const UNDO_009 =
  UNDO_010 +
  'DROP TRIGGER charge_lines_no_update;DROP TRIGGER charge_lines_no_delete;DROP TRIGGER charge_lines_live_only;DROP TABLE charge_lines;' +
  "DELETE FROM role_permissions WHERE permission IN ('packs.confirm','asks.answer');DELETE FROM permissions WHERE code IN ('packs.confirm','asks.answer');DELETE FROM roles WHERE code='YARD';DELETE FROM schema_migrations WHERE version=9;" +
  '';
const UNDO_008 =
  UNDO_009 +
  'DROP TRIGGER trip_confirmation_no_update;DROP TRIGGER trip_confirmation_no_delete;DROP TRIGGER trip_confirmation_live_only;DROP TABLE crew_devices;DROP TABLE crew_links;DROP TABLE trip_confirmation;' +
  'DROP INDEX objects_container_place;DROP INDEX objects_container_support;DROP INDEX objects_trip_state;DROP INDEX objects_trip_plan;DROP INDEX objects_trip_truck;DROP INDEX objects_order_status;DROP INDEX objects_hold_order;' +
  'DELETE FROM schema_migrations WHERE version=8';
const UNDO_007 =
  UNDO_008 +
  ';DROP TRIGGER companies_mode_fixed;DROP TRIGGER ledger_live_people_only;ALTER TABLE companies DROP COLUMN mode;ALTER TABLE companies DROP COLUMN time_zone;' +
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
// Tables migration 008 adds (empty on a database from before it).
const ADDED = [
  'trip_confirmation',
  'crew_links',
  'crew_devices',
  'charge_lines',
  'statement_items',
  'statement_exports',
  'trip_arrival',
];
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
    const saved = readdirSync(backups).filter((n) => /-before-update-v[56]-to-v11-.*.sqlite$/.test(n));
    assert.equal(saved.length, 1, 'one copy saved before the update: ' + readdirSync(backups).join(', '));
    assert.deepEqual(dump(join(backups, saved[0])), before, 'the copy is the database exactly as it was');
  }
  const after = dump(path, { without: NEW });
  delete before.schema_migrations;
  delete after.schema_migrations;
  for (const name of ADDED) {
    assert.equal(after[name], '[]', name + ' starts empty');
    delete after[name];
  }
  // and the CREW role with its one permission (trips.confirm), which 008 adds to a database from before it
  const drop = (name, keep) => {
    for (const d of [before, after]) if (d[name]) d[name] = JSON.stringify(JSON.parse(d[name]).filter(keep));
  };
  // (and 009's YARD role with packs.confirm and asks.answer, and 010's ACCOUNTS role with statements.manage and customers.manage)
  const NEW_PERMS = ['trips.confirm', 'packs.confirm', 'asks.answer', 'statements.manage', 'customers.manage'];
  drop('roles', (r) => !['CREW', 'YARD', 'ACCOUNTS'].includes(r.code));
  drop('permissions', (r) => !NEW_PERMS.includes(r.code));
  drop('role_permissions', (r) => !NEW_PERMS.includes(r.permission) && r.role !== 'ACCOUNTS');
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
    const at = v.prepare('SELECT MAX(version) v FROM schema_migrations').get().v;
    assert.ok(at >= 5 && at <= 6, 'the sample is from before the real yard (schema 5 or 6), not ' + at);
    v.exec('DELETE FROM engine_lease;PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    v.close();
  }
  checkMigrated(path, join(dir, 'before-update'));
});
