-- Phase 1A part 2 (ADR 0009): record what really happened in a real yard. Additive only: a new role and permission, the append-only
-- trip_confirmation record, and the tables behind a driver's phone (a one-time link and a long-lived, revocable device sign-in).
-- CREW: a driver who signs in on their own phone with a link the office sends. They can confirm their own trips and nothing else.
INSERT OR IGNORE INTO roles VALUES('CREW');
INSERT OR IGNORE INTO permissions VALUES('trips.confirm');
INSERT OR IGNORE INTO role_permissions VALUES('CREW','trips.confirm');
INSERT OR IGNORE INTO role_permissions VALUES('OWNER','trips.confirm');
INSERT OR IGNORE INTO role_permissions VALUES('GENERAL_MANAGER','trips.confirm');
-- One row per confirmed step of a trip (PACKED, LOADED = loaded & left, DELIVERED, COLLECTED, RETURNED = back at yard): what (lines, per
-- product), when it happened (occurred_at, backdated only with a reason) and when it was recorded, who (actor, PERSON or ON_BEHALF of the
-- driver) and by which command (origin). Never changed or removed: a correction is a new record.
CREATE TABLE IF NOT EXISTS trip_confirmation(
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 company_id TEXT NOT NULL REFERENCES companies(id),
 trip_id TEXT NOT NULL,
 site_id TEXT NOT NULL,
 step TEXT NOT NULL CHECK(step IN ('PACKED','LOADED','DELIVERED','COLLECTED','RETURNED')),
 lines TEXT NOT NULL CHECK(json_valid(lines)),
 received_by TEXT,
 occurred_at TEXT NOT NULL,
 recorded_at TEXT NOT NULL,
 actor TEXT NOT NULL,
 actor_kind TEXT NOT NULL CHECK(actor_kind IN ('PERSON','ON_BEHALF')),
 on_behalf_of TEXT,
 origin TEXT NOT NULL,
 backdate_reason TEXT,
 command_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trip_confirmation_trip ON trip_confirmation(company_id,trip_id,sequence);
CREATE INDEX IF NOT EXISTS trip_confirmation_site ON trip_confirmation(company_id,site_id,step,sequence);
CREATE INDEX IF NOT EXISTS trip_confirmation_time ON trip_confirmation(company_id,recorded_at);
CREATE TRIGGER IF NOT EXISTS trip_confirmation_no_update BEFORE UPDATE ON trip_confirmation BEGIN SELECT RAISE(ABORT,'Trip confirmations are append only'); END;
CREATE TRIGGER IF NOT EXISTS trip_confirmation_no_delete BEFORE DELETE ON trip_confirmation BEGIN SELECT RAISE(ABORT,'Trip confirmations are append only'); END;
-- Only a real yard confirms trips (the Practice yard's trucks are the simulation's).
CREATE TRIGGER IF NOT EXISTS trip_confirmation_live_only BEFORE INSERT ON trip_confirmation
WHEN (SELECT mode FROM companies WHERE id=NEW.company_id) IS NOT 'LIVE'
BEGIN SELECT RAISE(ABORT,'Trips are confirmed in a real yard only.'); END;
-- A sign-in link for one driver's phone: only its hash is kept, it works once, for 7 days.
CREATE TABLE IF NOT EXISTS crew_links(
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, company_id TEXT NOT NULL REFERENCES companies(id), driver_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id), created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 expires_at INTEGER NOT NULL, used_at TEXT, cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS crew_links_driver ON crew_links(company_id,driver_id);
-- A phone signed in with a link: long-lived (180 days, renewed while it is used), scoped to that driver's own trips, and signed out from the
-- office ("Sign out this phone") or from the phone itself.
CREATE TABLE IF NOT EXISTS crew_devices(
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, company_id TEXT NOT NULL REFERENCES companies(id), driver_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id), link_id TEXT NOT NULL REFERENCES crew_links(id), label TEXT, created_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at TEXT, revoked_by TEXT
);
CREATE INDEX IF NOT EXISTS crew_devices_driver ON crew_devices(company_id,driver_id);
-- What a real yard's commands look up (src/domain/trips.js tripRows): partial indexes, so the Practice yard's other kinds never pay for them.
CREATE INDEX IF NOT EXISTS objects_container_place ON objects(company_id,json_extract(data,'$.location')) WHERE kind='container';
CREATE INDEX IF NOT EXISTS objects_container_support ON objects(company_id,json_extract(data,'$.support')) WHERE kind='container';
CREATE INDEX IF NOT EXISTS objects_trip_state ON objects(company_id,json_extract(data,'$.state')) WHERE kind='trip';
CREATE INDEX IF NOT EXISTS objects_trip_plan ON objects(company_id,json_extract(data,'$.truckPlan')) WHERE kind='trip';
CREATE INDEX IF NOT EXISTS objects_trip_truck ON objects(company_id,json_extract(data,'$.truck')) WHERE kind='trip';
CREATE INDEX IF NOT EXISTS objects_order_status ON objects(company_id,json_extract(data,'$.status')) WHERE kind='order';
CREATE INDEX IF NOT EXISTS objects_hold_order ON objects(company_id,json_extract(data,'$.order')) WHERE kind='reservation';
INSERT INTO schema_migrations VALUES(8);
