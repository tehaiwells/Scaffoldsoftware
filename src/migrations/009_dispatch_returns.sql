-- Phase 1A part 3 (ADR 0010): Today as LIVE dispatch, returns counted and resolved, charge lines. Additive only.
-- YARD: a yard hand who signs in on their own phone (the crew link mechanism of 008) to confirm packs and count returns.
-- asks.answer: a person answering their own asks, signing their gang on and marking a yard task done from their phone.
INSERT OR IGNORE INTO roles VALUES('YARD');
INSERT OR IGNORE INTO permissions VALUES('packs.confirm');
INSERT OR IGNORE INTO permissions VALUES('asks.answer');
INSERT OR IGNORE INTO role_permissions VALUES('YARD','packs.confirm');
INSERT OR IGNORE INTO role_permissions VALUES('YARD','asks.answer');
INSERT OR IGNORE INTO role_permissions VALUES('CREW','asks.answer');
INSERT OR IGNORE INTO role_permissions VALUES('OWNER','packs.confirm');
INSERT OR IGNORE INTO role_permissions VALUES('OWNER','asks.answer');
INSERT OR IGNORE INTO role_permissions VALUES('GENERAL_MANAGER','packs.confirm');
INSERT OR IGNORE INTO role_permissions VALUES('GENERAL_MANAGER','asks.answer');
-- A charge line: what a site's customer is charged for a piece that did not come back (LOST at the replacement value), a damaged piece
-- charged after quarantine, or the missing pieces at a site's finish. Part 4's statements pick these up by site and period. Never changed
-- or removed: a correction is a new record. Cents ex GST. customer_id waits for part 4's customer record.
CREATE TABLE IF NOT EXISTS charge_lines(
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 company_id TEXT NOT NULL REFERENCES companies(id),
 site_id TEXT NOT NULL,
 customer_id TEXT,
 product_id TEXT NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity>0),
 unit_value INTEGER NOT NULL CHECK(unit_value>=0),
 amount INTEGER NOT NULL CHECK(amount>=0),
 reason TEXT NOT NULL CHECK(reason IN ('LOST','DAMAGED','SITE_FINISH')),
 source TEXT,
 occurred_at TEXT NOT NULL,
 recorded_at TEXT NOT NULL,
 actor TEXT NOT NULL,
 approved_by TEXT,
 command_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS charge_lines_site ON charge_lines(company_id,site_id,occurred_at);
CREATE TRIGGER IF NOT EXISTS charge_lines_no_update BEFORE UPDATE ON charge_lines BEGIN SELECT RAISE(ABORT,'Charge lines are append only'); END;
CREATE TRIGGER IF NOT EXISTS charge_lines_no_delete BEFORE DELETE ON charge_lines BEGIN SELECT RAISE(ABORT,'Charge lines are append only'); END;
CREATE TRIGGER IF NOT EXISTS charge_lines_live_only BEFORE INSERT ON charge_lines
WHEN (SELECT mode FROM companies WHERE id=NEW.company_id) IS NOT 'LIVE'
BEGIN SELECT RAISE(ABORT,'Charges are recorded in a real yard only.'); END;
INSERT INTO schema_migrations VALUES(9);
