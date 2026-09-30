-- Phase 1A part 5 (owner brief 30 September 2026): gear lists, the workers' roster and their tasks. Additive only.
-- The gear-list builder's trip_arrival table (light arrivals at the pickup and the drop, append-only, a real yard only) goes above these
-- lines at the merge; the roster and task indexes below are the CREW builder's (roster.js, tasks.js read one person's or one day's rows).
CREATE INDEX IF NOT EXISTS objects_roster_person_day ON objects(company_id, json_extract(data,'$.person'), json_extract(data,'$.day')) WHERE kind='rosterDay';
CREATE INDEX IF NOT EXISTS objects_roster_day ON objects(company_id, json_extract(data,'$.day')) WHERE kind='rosterDay';
CREATE INDEX IF NOT EXISTS objects_task_day ON objects(company_id, json_extract(data,'$.day')) WHERE kind='workTask';
CREATE INDEX IF NOT EXISTS objects_task_list ON objects(company_id, json_extract(data,'$.list')) WHERE kind='workTask';
INSERT INTO schema_migrations VALUES(10);
