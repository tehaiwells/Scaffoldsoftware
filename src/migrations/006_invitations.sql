-- Phase 0 (security): invitations the invitee accepts, a removable membership, the server administrator and two server settings.
-- Additive only: new tables and one new nullable column. Nothing existing is rewritten or dropped.
-- A membership is never deleted (audit_events point at it); removing someone sets removed_at and drops their roles in that company.
ALTER TABLE memberships ADD COLUMN removed_at TEXT;
CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,company_id TEXT NOT NULL REFERENCES companies(id),email TEXT NOT NULL,name TEXT,roles TEXT NOT NULL,invited_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,expires_at INTEGER NOT NULL,accepted_at TEXT,accepted_by TEXT REFERENCES users(id),cancelled_at TEXT);
CREATE INDEX IF NOT EXISTS invitations_company ON invitations(company_id,created_at);
-- Settings of this server (not of one company), e.g. open_registration and lan_sharing ('1' = on). Only the server administrator changes them.
CREATE TABLE IF NOT EXISTS server_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
-- The server administrator: sees file paths and backs up the whole server. On a new server it is whoever creates the first company.
-- On an existing server it is exactly one person: whoever created the first company (never every company creator: before this update anyone on the
-- network could sign up, and none of them may inherit the server). No such record: the first owner of the oldest company.
CREATE TABLE IF NOT EXISTS server_admins(user_id TEXT PRIMARY KEY REFERENCES users(id),since TEXT NOT NULL);
INSERT INTO server_admins SELECT actor_id,created_at FROM audit_events WHERE action='company.created' AND actor_id IN (SELECT id FROM users) ORDER BY created_at,rowid LIMIT 1;
INSERT INTO server_admins SELECT ur.user_id,c.created_at FROM companies c JOIN user_roles ur ON ur.company_id=c.id AND ur.role='OWNER' JOIN users u ON u.id=ur.user_id WHERE NOT EXISTS (SELECT 1 FROM server_admins) ORDER BY c.created_at,c.rowid,u.rowid LIMIT 1;
-- Before this update the desktop launcher let phones on the Wi-Fi open Scaffold Yard; now that is a switch, off. A server already in use says so once on Account.
INSERT INTO server_settings SELECT 'lan_notice','1' WHERE EXISTS (SELECT 1 FROM users);
INSERT INTO schema_migrations VALUES(6);
