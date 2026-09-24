import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // synchronous=NORMAL: WAL stays consistent; a power cut (not a process crash) can lose the last few commits.
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS companies(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL, UNIQUE(company_id,id));
    CREATE TABLE IF NOT EXISTS roles(code TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS permissions(code TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS role_permissions(role TEXT REFERENCES roles(code),permission TEXT REFERENCES permissions(code),PRIMARY KEY(role,permission));
    CREATE TABLE IF NOT EXISTS user_roles(company_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL REFERENCES roles(code),PRIMARY KEY(company_id,user_id,role),FOREIGN KEY(company_id,user_id) REFERENCES users(company_id,id));
    CREATE TABLE IF NOT EXISTS scaffold_systems(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS company_systems(company_id TEXT REFERENCES companies(id),system_id TEXT REFERENCES scaffold_systems(id),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),PRIMARY KEY(company_id,system_id));
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_events(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),actor_id TEXT NOT NULL,action TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(company_id,actor_id) REFERENCES users(company_id,id));
    CREATE INDEX IF NOT EXISTS audit_company_time ON audit_events(company_id,created_at);
    CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);
    INSERT OR IGNORE INTO schema_migrations VALUES(1);`);
  for (const role of ['OWNER','GENERAL_MANAGER','SUPERVISOR']) db.prepare('INSERT OR IGNORE INTO roles VALUES(?)').run(role);
  const grants = {OWNER:['company.manage','users.manage','operations.manage','sites.assigned','requests.create','finance.view'],GENERAL_MANAGER:['operations.manage','requests.create'],SUPERVISOR:['sites.assigned','requests.create']};
  for (const [role, permissions] of Object.entries(grants)) for (const p of permissions) {
    db.prepare('INSERT OR IGNORE INTO permissions VALUES(?)').run(p);
    db.prepare('INSERT OR IGNORE INTO role_permissions VALUES(?,?)').run(role,p);
  }
  for (const [id,name] of [['quickstage','Quickstage'],['at-pac','AT-PAC'],['tube-clip','Tube & Clip']]) db.prepare('INSERT OR IGNORE INTO scaffold_systems VALUES(?,?)').run(id,name);
  if(!db.prepare('SELECT version FROM schema_migrations WHERE version=2').get()) atomic(db,()=>db.exec(readFileSync(new URL('./migrations/002_simulation.sql',import.meta.url),'utf8')));
  if(!db.prepare('SELECT version FROM schema_migrations WHERE version=3').get()) atomic(db,()=>db.exec(readFileSync(new URL('./migrations/003_memberships.sql',import.meta.url),'utf8')));
  if(!db.prepare('SELECT version FROM schema_migrations WHERE version=4').get()) atomic(db,()=>db.exec(readFileSync(new URL('./migrations/004_manager_stock_adjust.sql',import.meta.url),'utf8')));
  if(!db.prepare('SELECT version FROM schema_migrations WHERE version=5').get()) atomic(db,()=>db.exec(readFileSync(new URL('./migrations/005_perf_indexes.sql',import.meta.url),'utf8')));
  return db;
}

// One prepared statement per SQL text per connection (statements are synchronous and reset after every call).
const statements=new WeakMap();
export function cached(db, sql) {
  let map=statements.get(db); if(!map) statements.set(db,map=new Map());
  let statement=map.get(sql); if(!statement) map.set(sql,statement=db.prepare(sql));
  return statement;
}

export function atomic(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try { const result=operation(); db.exec('COMMIT'); return result; }
  catch(error) { db.exec('ROLLBACK'); throw error; }
}
