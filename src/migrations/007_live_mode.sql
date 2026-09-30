-- Phase 1A (ADR 0001, 0002, 0003): every company is LIVE (the real yard) or DEMO (the Practice yard), with its own time zone, and the ledger
-- says who did each thing. Additive: new columns with defaults, two guard triggers, and a backfill of the two new ledger columns.
-- Every company that exists now was made by the simulation, so it becomes DEMO. A company's mode is set when it is made and never changes.
ALTER TABLE companies ADD COLUMN mode TEXT NOT NULL DEFAULT 'DEMO' CHECK(mode IN ('LIVE','DEMO'));
ALTER TABLE companies ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'Australia/Sydney';
CREATE TRIGGER IF NOT EXISTS companies_mode_fixed BEFORE UPDATE OF mode ON companies WHEN NEW.mode IS NOT OLD.mode
BEGIN SELECT RAISE(ABORT,'A company''s mode never changes.'); END;
-- Minimal provenance (ADR 0003 step 1): when it happened (occurred_at, may differ from created_at = when it was recorded), what kind of actor
-- (PERSON, ON_BEHALF = the office for someone else, ENGINE = the Practice yard's simulation, IMPORT = opening stock brought in), for whom, and
-- which command or process wrote it (origin). Rows written before this update were a mix nobody can tell apart now: they stay ENGINE.
ALTER TABLE ledger ADD COLUMN occurred_at TEXT;
ALTER TABLE ledger ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'ENGINE' CHECK(actor_kind IN ('PERSON','ON_BEHALF','ENGINE','IMPORT'));
ALTER TABLE ledger ADD COLUMN on_behalf_of TEXT;
ALTER TABLE ledger ADD COLUMN origin TEXT;
-- The ledger is append-only (its triggers refuse UPDATE): lifted for this one backfill inside the migration's transaction, then put back.
DROP TRIGGER IF EXISTS ledger_no_update;
UPDATE ledger SET occurred_at=created_at,origin='before-provenance' WHERE occurred_at IS NULL;
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'Ledger is append only'); END;
-- The hard wall: nothing the simulation writes can land in a real yard's ledger.
CREATE TRIGGER IF NOT EXISTS ledger_live_people_only BEFORE INSERT ON ledger
WHEN NEW.actor_kind='ENGINE' AND (SELECT mode FROM companies WHERE id=NEW.company_id)='LIVE'
BEGIN SELECT RAISE(ABORT,'A real yard records only what people did.'); END;
INSERT INTO schema_migrations VALUES(7);
