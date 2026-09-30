-- Phase 1A part 4 (ADR 0011): billing you can send, and bringing an existing yard in. Additive only.
-- ACCOUNTS: the bookkeeper. Sees money, issues statements and keeps customers; never operations.
INSERT OR IGNORE INTO roles VALUES('ACCOUNTS');
INSERT OR IGNORE INTO permissions VALUES('statements.manage');
INSERT OR IGNORE INTO permissions VALUES('customers.manage');
INSERT OR IGNORE INTO role_permissions VALUES('ACCOUNTS','finance.view');
INSERT OR IGNORE INTO role_permissions VALUES('ACCOUNTS','statements.manage');
INSERT OR IGNORE INTO role_permissions VALUES('ACCOUNTS','customers.manage');
INSERT OR IGNORE INTO role_permissions VALUES('OWNER','statements.manage');
INSERT OR IGNORE INTO role_permissions VALUES('OWNER','customers.manage');
INSERT OR IGNORE INTO role_permissions VALUES('GENERAL_MANAGER','customers.manage');
-- An issued statement (kind statement) and an adjustment (kind adjustment) never change and are never removed: a statement is voided only
-- by a reversing statement; a change after issue is a new adjustment.
CREATE TRIGGER IF NOT EXISTS objects_statement_no_update BEFORE UPDATE ON objects WHEN OLD.kind IN ('statement','adjustment')
BEGIN SELECT RAISE(ABORT,'An issued statement never changes. Issue a reversing statement or an adjustment.'); END;
CREATE TRIGGER IF NOT EXISTS objects_statement_no_delete BEFORE DELETE ON objects WHEN OLD.kind IN ('statement','adjustment')
BEGIN SELECT RAISE(ABORT,'An issued statement is never removed.'); END;
-- One number per statement per company (ST-000001, ...).
CREATE UNIQUE INDEX IF NOT EXISTS objects_statement_number ON objects(company_id,json_extract(data,'$.number')) WHERE kind='statement';
CREATE INDEX IF NOT EXISTS objects_statement_customer ON objects(company_id,json_extract(data,'$.customer')) WHERE kind='statement';
CREATE INDEX IF NOT EXISTS objects_site_customer ON objects(company_id,json_extract(data,'$.customer')) WHERE kind='site';
-- Which charge lines (charge_lines.id) and adjustments a statement carried: each is billed once. A reversal releases its original's items.
CREATE TABLE IF NOT EXISTS statement_items(
 company_id TEXT NOT NULL REFERENCES companies(id),
 statement_id TEXT NOT NULL,
 item_kind TEXT NOT NULL CHECK(item_kind IN ('CHARGE','ADJUSTMENT')),
 item_id TEXT NOT NULL,
 PRIMARY KEY(company_id,item_kind,item_id)
);
CREATE INDEX IF NOT EXISTS statement_items_statement ON statement_items(company_id,statement_id);
-- Every download of the monthly accounting file: which statements went to which package, when, by whom.
CREATE TABLE IF NOT EXISTS statement_exports(
 id TEXT PRIMARY KEY,
 company_id TEXT NOT NULL REFERENCES companies(id),
 statement_id TEXT NOT NULL,
 format TEXT NOT NULL CHECK(format IN ('XERO','MYOB','GENERIC')),
 month TEXT NOT NULL,
 exported_at TEXT NOT NULL,
 actor TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS statement_exports_statement ON statement_exports(company_id,statement_id);
INSERT INTO schema_migrations VALUES(10);
