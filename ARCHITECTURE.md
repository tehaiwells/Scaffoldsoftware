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

Only Simulation.tick advances physical activity. A database lease guards the scheduler; one machine route runs per handling area to avoid conflicting moving loads. Each callback advances 250 ms, never elapsed downtime. Pause state, remaining duration, resource assignments and custody survive restart. Live movement (walking and hand-driven positions, forklift-move countdowns, the trip countdown of a truck on the road) is held in memory per row version (src/domain/live.js) and applied on every read. It is written (json_set of the moved fields only; SQLite still rewrites the row) every 2 s of movement, fully on each state change, on the next tick once the engine stops holding it (e.g. the driver of a stopped drive), on pause and on stop; a crash can lose up to 2 s of travel. Savepoints around held movement use savepoint() in database.js so a ROLLBACK TO also restores what was held. A crash may leave the lease occupied for five seconds.

Future live operations require a separate authorized human/verified integration completion adapter. Timer or animation completion is never evidence of real handling. All present workspaces are simulation workspaces.

In-app notifications are created in the same committed transaction as their business event. Idempotent commands prevent duplicate notifications. No external provider is configured.

## Deployment preparation

Loopback binding, relative API paths, environment configuration, /health, structured scheduler errors and backup tooling exist. Before exposure: reviewed HTTPS proxy, secure cookies, explicit trusted-proxy scheme/host handling, registration/invite policy, recovery, durable rate limits, security review and operational monitoring. Do not trust arbitrary forwarded headers. No deployment or PostgreSQL environment was tested.

SQLite-specific SQL is isolated behind database/repository boundaries, but PostgreSQL needs explicit adapters and migrations. A connection-string change alone is insufficient. The hybrid relational/JSON schema is documented in DATABASE_SCHEMA.md.

## Home world map

Home draws the yard and every active site the viewer may see on one schematic district (`public/world.js`): one block per place on a street grid, the yard in block 0,0, each site where it was placed on the map (`site.map`, set by the `worldPlace` command, operations only) or in the nearest free block. The geometry — blocks, streets, where trucks stop and the road between two places — is the pure module `public/world-layout.js`, shared by the browser and the server (`src/domain/world.js`), so a trip is timed on the road it is drawn on.

At dispatch the server stores the road on the truck (`truck.route`: points, length, `durationMs`, where it ends) and sets `remainingMs` from the road length: the truck drives at twice the simulation's demo travel speed (`config.speed`, 8 m/s at the default), at least 14 s (still long enough to watch) and at most 45 s. The time comes from the road length with every block counted at no more than a standard block (`tripLength`), so one very large site that makes every block bigger never makes every trip longer. A trip to or from a place that is not on the map (a second yard) has no road and takes the time of a typical 150 m trip. The minimum scales with the demo speed, so the test fixtures' fast speed keeps trips under a second. A fault in the map geometry never blocks a dispatch: the trip then keeps the old fixed 3 s. Sites south of the yard face north, toward it, and a site is drawn turned so the top of its plan (where unloaded stillages are set down) faces its street; archived sites still size the blocks, and archiving or moving a site pins the auto-placed ones, so nothing else moves. An archived site that a truck is still driving to or from, or is parked at, stays on the map (faded) until the truck has left, so the truck and its load never vanish and can be sent back. `worldPlace` accepts blocks at most two blocks out from the others. While a truck is on the road its countdown is held on the live overlay (`src/domain/live.js`) like any other live movement: one clock, written about every 2 s of engine time, on pause, on arrival and on stop (`flushLive`), and read exactly by every reader (the map, the Today page, the Schedule and the collection cards all show the same arrival time). Arrival, pause and custody are unchanged. The snapshot's `world` block is built only for the Home map's own poll (`/api/state?world=REVS`; the Stock, Today and Schedule polls and exports never pay for it). It carries the lots every viewer draws (visible places only) and an unpaged list of the stillages at visible sites, on visible trucks and on site cranes, as short arrays grouped by location, each group with a revision: the page sends the revisions it has and gets unchanged groups back as the revision only (`wmWorldMerge` rebuilds the list). A viewer without operations.manage gets a truck's trip clock but not its road.

Every trip is drawn the same way, whichever way it goes: yard to site, site to yard (a scheduled collection: the site crane loads the truck, it drives back and reverses into the yard bay, the yard crew unloads it) or site to site. The truck card offers the next step to people with operations.manage (Load the collection, Bring it back to the yard, Unload at the yard or site, Send to a site). The browser moves each truck along its road every animation frame from that shared countdown (so two browsers agree), and predicts the site crane's lift from the task steps between polls. Static scenery (ground, streets, houses, trees, each site's building, shed and fence) is built once per layout and shown as pictures (blob-URL SVG images, `img-src blob:`, drawn into bitmaps at the zoom levels in use); the yard, each site's stock and crew are live SVG layers patched in place; trucks are small HTML elements over the map moved by Web Animations planned from the shared countdown, and the site cranes are drawn in a transparent overlay, so neither repaints the map. The camera slides a slightly oversized picture on the compositor between repaints (redrawn part-way through a long glide, so it is never shown blown up); the place name tags are a separate layer over everything, placed in screen pixels for the live camera, never overlapping (the yard and the places a truck is working at first; others drop their stock line, lift onto a leader line or wait hidden). Scenery bitmaps are drawn only while the camera rests, and encoded to PNG in a worker (`public/world-pic.js`). Animation runs in one requestAnimationFrame loop only while something moves and the map is on screen. On a phone the truck and site card sits under the map, with the lists behind Details. The map is excluded from the browser's scroll anchoring (`overflow-anchor:none`), and the page keeps the map in place when content above it changes height.
