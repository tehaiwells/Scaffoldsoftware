CREATE TABLE IF NOT EXISTS memberships(company_id TEXT NOT NULL REFERENCES companies(id),user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(company_id,user_id));
INSERT OR IGNORE INTO memberships SELECT company_id,id FROM users;
CREATE TABLE IF NOT EXISTS objects(
 id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), kind TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)), version INTEGER NOT NULL DEFAULT 1,
 UNIQUE(company_id,id)
);
CREATE INDEX IF NOT EXISTS objects_company_kind ON objects(company_id,kind);
CREATE TABLE IF NOT EXISTS contents(
 company_id TEXT NOT NULL, container_id TEXT NOT NULL, product_id TEXT NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity>=0),
 PRIMARY KEY(company_id,container_id,product_id),
 FOREIGN KEY(company_id,container_id) REFERENCES objects(company_id,id),
 FOREIGN KEY(company_id,product_id) REFERENCES objects(company_id,id)
);
CREATE TABLE IF NOT EXISTS ledger(
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,company_id TEXT NOT NULL REFERENCES companies(id),
 actor TEXT NOT NULL,event TEXT NOT NULL,product_id TEXT,container_id TEXT,quantity INTEGER NOT NULL,
 source TEXT,destination TEXT,task_id TEXT,request_id TEXT,reason TEXT NOT NULL,command_key TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_company_sequence ON ledger(company_id,sequence);
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'Ledger is append only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'Ledger is append only'); END;
CREATE TABLE IF NOT EXISTS commands(company_id TEXT NOT NULL REFERENCES companies(id),key TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(company_id,key));
CREATE TABLE IF NOT EXISTS engine_lease(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,expires_at INTEGER NOT NULL);
INSERT OR IGNORE INTO permissions VALUES('stock.adjust');
INSERT OR IGNORE INTO role_permissions VALUES('OWNER','stock.adjust');
INSERT OR IGNORE INTO schema_migrations VALUES(2);
