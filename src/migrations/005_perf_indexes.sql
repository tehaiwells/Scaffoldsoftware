CREATE INDEX IF NOT EXISTS ledger_company_event_sequence ON ledger(company_id,event,sequence);
CREATE INDEX IF NOT EXISTS contents_company_product ON contents(company_id,product_id);
-- Per-company revision counters (catalogue: product, packaging, productSettings). The random token makes a rolled-back bump unrepeatable.
CREATE TABLE IF NOT EXISTS revisions(company_id TEXT NOT NULL,name TEXT NOT NULL,n INTEGER NOT NULL,token TEXT NOT NULL,PRIMARY KEY(company_id,name));
INSERT OR IGNORE INTO schema_migrations VALUES(5);
