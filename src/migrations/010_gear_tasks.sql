-- Phase 1A part 5 (ADR 0011): gear lists (yard -> site, site -> site, site -> yard) with the driver's arrival taps, the workers' roster
-- and their tasks. Additive only. Nothing here changes a company's mode or any existing row.
-- A driver's arrival at the pickup place (the yard, or site A of a move) and at the drop place (the site, or the yard for a bring-back):
-- light confirmations that move no stock (the movement steps stay in trip_confirmation, whose CHECK lists only them). One row per step,
-- never changed or removed, and only for a real yard (the Practice yard's engine writes the same marks on the item itself).
CREATE TABLE IF NOT EXISTS trip_arrival(
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 company_id TEXT NOT NULL REFERENCES companies(id),
 trip_id TEXT NOT NULL,
 site_id TEXT,
 step TEXT NOT NULL CHECK(step IN ('ARRIVED_PICKUP','ARRIVED_DROP')),
 occurred_at TEXT NOT NULL,
 recorded_at TEXT NOT NULL,
 actor TEXT NOT NULL,
 actor_kind TEXT NOT NULL CHECK(actor_kind IN ('PERSON','ON_BEHALF')),
 on_behalf_of TEXT,
 origin TEXT NOT NULL,
 backdate_reason TEXT,
 command_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trip_arrival_trip ON trip_arrival(company_id,trip_id,sequence);
CREATE TRIGGER IF NOT EXISTS trip_arrival_no_update BEFORE UPDATE ON trip_arrival BEGIN SELECT RAISE(ABORT,'Trip arrivals are append only'); END;
CREATE TRIGGER IF NOT EXISTS trip_arrival_no_delete BEFORE DELETE ON trip_arrival BEGIN SELECT RAISE(ABORT,'Trip arrivals are append only'); END;
CREATE TRIGGER IF NOT EXISTS trip_arrival_live_only BEFORE INSERT ON trip_arrival
WHEN (SELECT mode FROM companies WHERE id=NEW.company_id) IS NOT 'LIVE'
BEGIN SELECT RAISE(ABORT,'Trips are confirmed in a real yard only.'); END;
-- Gear lists on the calendar by day (the day panel, the week list and the day-before asks read one day at a time).
CREATE INDEX IF NOT EXISTS objects_plan_day ON objects(company_id,json_extract(data,'$.day')) WHERE kind='planItem';
-- (CREW appends: the roster and task indexes of ADR 0011 §2.2 / §2.3)
INSERT INTO schema_migrations VALUES(10);
