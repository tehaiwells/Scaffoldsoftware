# Architecture — implemented local simulation

The existing Node 24 / SQLite / browser JavaScript stack was retained, as permitted by the revised brief. Rewriting working authentication would add migration risk. There is one backend, one browser application and one relational database. No AI service, outbound messaging, game engine or public hosting exists. Playwright is a locked development dependency.

## Actual structure

- src/server.js: HTTP, cookies, command dispatch, health and CSV.
- src/service.js: authentication, memberships, roles and company settings.
- src/database.js and migrations/: baseline schema, ordered migrations, atomic writes.
- src/repository.js: tenant-scoped objects, contents and immutable ledger.
- src/simulation.js: command authorization/idempotency, reports and scheduler.
- src/domain/catalogue.js: definitions, exact variants, sources, packaging, settings and import.
- src/domain/inventory.js: containers, placement, stock and counts.
- src/domain/logistics.js: requests, reservations, resources, trucks, sites and returns.
- src/domain/movement.js: persisted pickup/placement engine.
- src/domain/geometry.js: segments, polygons, rectangles and conservative routes.
- public/app.js: authentication and company/team settings.
- public/operations.js and visual.js: connected views, interaction and SVG.
- catalogues/synthetic.json: original DEMO ONLY seed, outside the UI.
- scripts/: demo seed, reviewed import, backup, benchmark and syntax checks.
- test/ and e2e/: business, integration, recovery, frontend and browser tests.
- data/: ignored runtime databases.

## Commands, tenancy and security

A hashed session selects a validated company membership. Roles are additive within that membership; an owner is not a global administrator. Supervisors see assigned sites, including scoped exports. Simulated workers are resources, never login accounts.

Each command requires an idempotency key and fingerprints actor/action/input. BEGIN IMMEDIATE serializes SQLite writers. Versioned updates detect stale writes. Command result, balances, reservations and events commit together. Step savepoints preserve equipment custody after failed placement. The browser cannot set balances or complete a movement.

Passwords use Node's established salted scrypt primitive and constant-time verification, not a new cryptographic algorithm. Opaque sessions expire after eight hours; token hashes are stored. HttpOnly/SameSite=Strict cookies, JSON-only writes, origin checks, input limits, parameterized SQL, server permissions and a local authentication throttle are implemented. Public deployment still needs the hardening in KNOWN_LIMITATIONS.md.

## Simulation and notifications

Only Simulation.tick advances physical activity. A database lease guards the scheduler; one machine route runs per handling area to avoid conflicting moving loads. Each callback advances 250 ms, never elapsed downtime. Pause state, remaining duration, resource assignments and custody survive restart. Live movement (walking and hand-driven positions, forklift-move countdowns) is held in memory per row version (src/domain/live.js) and applied on every read. It is written (json_set of the moved fields only; SQLite still rewrites the row) every 2 s of movement, fully on each state change, on the next tick once the engine stops holding it (e.g. the driver of a stopped drive), on pause and on stop; a crash can lose up to 2 s of travel. Savepoints around held movement use savepoint() in database.js so a ROLLBACK TO also restores what was held. A crash may leave the lease occupied for five seconds.

Future live operations require a separate authorized human/verified integration completion adapter. Timer or animation completion is never evidence of real handling. All present workspaces are simulation workspaces.

In-app notifications are created in the same committed transaction as their business event. Idempotent commands prevent duplicate notifications. No external provider is configured.

## Deployment preparation

Loopback binding, relative API paths, environment configuration, /health, structured scheduler errors and backup tooling exist. Before exposure: reviewed HTTPS proxy, secure cookies, explicit trusted-proxy scheme/host handling, registration/invite policy, recovery, durable rate limits, security review and operational monitoring. Do not trust arbitrary forwarded headers. No deployment or PostgreSQL environment was tested.

SQLite-specific SQL is isolated behind database/repository boundaries, but PostgreSQL needs explicit adapters and migrations. A connection-string change alone is insufficient. The hybrid relational/JSON schema is documented in DATABASE_SCHEMA.md.
