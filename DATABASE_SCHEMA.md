# Implemented schema and migrations

SQLite uses foreign keys, WAL, a five-second busy timeout and transactional migrations. Version 1 is the preserved baseline in database.js. Ordered migrations 002-006 migrate existing data (006_invitations.sql is additive: memberships.removed_at, invitations, server_settings, server_admins); schema_migrations records completion.

| Table | Purpose |
|---|---|
| companies / users | Company identity and global normalized login identity; salted password hash |
| memberships | Composite company/user key; one identity may join several companies; removed_at marks someone removed (the row stays for the audit history) |
| invitations | One-time invitation: company, email, roles, inviter, SHA-256 of the link token, expiry (7 days), accepted/cancelled |
| server_settings / server_admins | Server-wide switches (open_registration, lan_sharing) and the server administrator(s) |
| roles / permissions / role_permissions | Shared policy definitions |
| user_roles | Roles scoped through a membership foreign key |
| sessions | Token digest, user, active company and expiry |
| scaffold_systems / company_systems | System reference data and preserved enable/disable selection |
| audit_events | Membership-scoped administrative history |
| objects | UUID, company, kind, validated JSON, optimistic version; company/kind index |
| contents | Company/container/product key, nonnegative integer quantity, tenant composite foreign keys |
| ledger | Append-only sequence, actor/event/product/container/quantity, source/destination, request/task, reason/key/time |
| commands | Unique company/idempotency key, fingerprint and committed result |
| engine_lease | Singleton scheduler owner/expiry |

Object kinds include definitions, products, sources, packaging, company settings, import batches, yards, sites, containers, resources, config, trucks, requests, tasks, reservations, deliveries, counts and notifications. Domain commands resolve object references with company-scoped lookups. These JSON references do not all have SQL foreign keys; full normalization remains a production migration task.

Ledger UPDATE/DELETE are rejected by triggers. Corrections append events. Balances, reservations and steps commit with events. Empty containers remain audited assets even with no product lines. Stock reports combine contents with each container's one physical location, not reservations/status as extra quantities.

State responses page containers in groups of 100; company totals and scoped stock CSV include every page. History uses indexed sequence cursors and max 200 rows per API page. History CSV explicitly caps at 10,000 records. PostgreSQL support is neither implemented nor tested.
