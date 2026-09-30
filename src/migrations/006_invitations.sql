-- Phase 0 (security): invitations the invitee accepts, a removable membership, the server administrator and two server settings.
-- Additive only: new tables and one new nullable column. Nothing existing is rewritten or dropped.
-- A membership is never deleted (audit_events point at it); removing someone sets removed_at and drops their roles in that company.
ALTER TABLE memberships ADD COLUMN removed_at TEXT;
CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,company_id TEXT NOT NULL REFERENCES companies(id),email TEXT NOT NULL,name TEXT,roles TEXT NOT NULL,invited_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,expires_at INTEGER NOT NULL,accepted_at TEXT,accepted_by TEXT REFERENCES users(id),cancelled_at TEXT);
CREATE INDEX IF NOT EXISTS invitations_company ON invitations(company_id,created_at);
-- Settings of this server (not of one company), e.g. open_registration and lan_sharing ('1' = on). Only the server administrator changes them.
CREATE TABLE IF NOT EXISTS server_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
-- The server administrator: sees file paths and backs up the whole server. On a new server it is whoever creates the first company.
-- Every server that exists today is one PC run by one person, so everyone who has created a company on it so far stays able to do what they could.
CREATE TABLE IF NOT EXISTS server_admins(user_id TEXT PRIMARY KEY REFERENCES users(id),since TEXT NOT NULL);
INSERT OR IGNORE INTO server_admins SELECT actor_id,MIN(created_at) FROM audit_events WHERE action='company.created' AND actor_id IN (SELECT id FROM users) GROUP BY actor_id;
INSERT INTO schema_migrations VALUES(6);
