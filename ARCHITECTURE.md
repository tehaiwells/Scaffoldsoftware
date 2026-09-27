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

## The game board (main screen)

Operations people open on the game board (`public/game.js`). It is view `HOME`, so the Home map's own poll (and its `?world=` block) feeds it: the world map fills the screen, a Factorio-style inventory window fills the side panel (a dark grid of small slots, one per component, its picture from `public/game-art.js` and one short number in the corner; empty slots fill the window; picture tabs with words, by kind; a hover or long-press card beside the window with where every piece is), and three big buttons do the three everyday jobs. Every other page is a picture tile in the Office drawer (three short groups: every day, yard and fleet, business); an Office page has a slim bar with Back to the yard and the Office door instead of the old sidebar. The old Home (crew orders, fleet, set-up guide, stock grids, layout planner) is the Control room tile, view `CONTROL`, with the yard plan in place of the district map. Supervisors keep their pages, behind the same Office drawer.

The board patches itself on every poll and never shows counters, alert strips or checklists: one speech-bubble hint at a time (`hintOf`; it points at the button or the site it talks about and carries that button), pops when a truck sets off or a load lands (from the in-app notifications, never twice for one trip), and small truck cards in words with a fill bar only while a truck is on a trip or an order waits. Numbers live only in the slots' corners; a slot's length label shows only while picking. The map hides stillage names, crew tags, measurements and piece counts and leaves about half the house lots as lawn (`CALM` in `public/world.js`). Taps on the map go to the board first (`ctx.onPick`): a site opens its stock (or becomes the Send / Bring back target), a truck its load, the yard its stock, an empty block a new site there.

The one-tap jobs are server commands in `src/domain/game.js`, built from the existing ones:

- `gameStart` (first run): a small / medium / large yard with a yard office, 4 workers, 2 forklifts and two 12.5 t trucks.
- `gameCatalogue`: "Which scaffold do you use?" is asked here, not at sign-up (four boxes): the systems picked become the company's, and the reviewed supplier lists in `catalogues/verified` load for them (every figure cited; nothing invented), skipping rows already there.
- `gameAddStock`: stock arriving at the yard. One product per stillage; a stillage holds a pack when the product has a pack size, otherwise as much as a yard forklift lifts. New stillages go on the product's own piles while they are under three high, else on the ground with a 1.2 m forklift aisle all round, so every stillage can be driven out.
- `gameSite`: a client site by name (on the tapped block of the map when there is one), with a site crane and two workers.
- `gameSend`: the whole stillages holding the picked materials (`public/game-pick.js`, shared with the amount slider: tops of piles first, single-product first, fuller first; a buried one takes what is on it along, and the Send window shows what rides along before the button is pressed) loaded onto the next free truck(s) with `loadTruck`.
- `gameCollect`: a collection for today (everything on the site, or the stillages holding the picked materials) booked on the next free truck, which is sent there empty.
- When every truck is out, Send and Bring back wait as a `gameOrder` (oldest first; `result.gameOrders` on the poll; `gameCancel` takes one off) and go on the next truck back at the yard; the stillages are chosen then. An order that can no longer go is dropped with a Not sent note.

A truck on such a trip carries `truck.game = {kind, site, stage, ...}`. After every engine tick (`tickJobs`, which every tick ends with) the autopilot takes the next step when the last one is finished: dispatch when loaded, unload with the site crane, say Delivered and drive home; or load the collection, bring it back and unload it at the yard; then the waiting orders. A step that fails leaves the truck where it is with `game.problem` (shown as the hint) and is tried again four seconds later; `gameStop` hands a truck back to the Office pages. The slider's stops come from `GET /api/game-items?loc=` (the stillages at the yard or one site, their contents and whether each can be lifted now), asked for only while Send or Bring back is open, so the 1 s poll carries nothing extra for the board.

## Home world map

Home draws the yard and every active site the viewer may see on one schematic district (`public/world.js`): one block per place on a street grid, the yard in block 0,0, each site where it was placed on the map (`site.map`, set by the `worldPlace` command, operations only) or in the nearest free block. The geometry — blocks, streets, where trucks stop and the road between two places — is the pure module `public/world-layout.js`, shared by the browser and the server (`src/domain/world.js`), so a trip is timed on the road it is drawn on.

At dispatch the server stores the road on the truck (`truck.route`: points, length, `durationMs`, where it ends) and sets `remainingMs` from the road length: the truck drives at twice the simulation's demo travel speed (`config.speed`, 8 m/s at the default), at least 8 s and at most 45 s, so a site across the street from the yard is a short trip. The minimum scales with the demo speed, so the test fixtures' fast speed keeps trips under a second. A fault in the map geometry never blocks a dispatch: the trip then keeps the old fixed 3 s. Sites south of the yard face north, toward it, and a site is drawn turned so the top of its plan (where unloaded stillages are set down) faces its street; archived sites still size the blocks, and archiving or moving a site pins the auto-placed ones, so nothing else moves. While a truck is on the road its countdown is held on the live overlay (`src/domain/live.js`) like any other live movement: one clock, written about every 2 s of engine time, on pause, on arrival and on stop (`flushLive`), and read exactly by every reader (the map, the Today page, the Schedule and the collection cards all show the same arrival time). Arrival, pause and custody are unchanged. The snapshot's `world` block carries the lots every viewer draws (visible places only) and an unpaged list of stillages at visible sites, on visible trucks and on site cranes.

Every trip is drawn the same way, whichever way it goes: yard to site, site to yard (a scheduled collection: the site crane loads the truck, it drives back and reverses into the yard bay, the yard crew unloads it) or site to site. The truck card offers the next step to people with operations.manage (Load the collection, Bring it back to the yard, Unload at the yard or site, Send to a site). The browser moves each truck along its road every animation frame from that shared countdown (so two browsers agree), and predicts the site crane's lift from the task steps between polls. Static scenery (ground, streets, houses, trees, each site's building, shed and fence) is built once per layout and shown as pictures (blob-URL SVG images, `img-src blob:`, drawn into bitmaps at the zoom levels in use); the yard, each site's stock and crew are live SVG layers patched in place; trucks are small HTML elements over the map moved by Web Animations planned from the shared countdown, and the site cranes are drawn in a transparent overlay, so neither repaints the map. The camera slides a slightly oversized picture on the compositor between repaints; animation runs only while something moves and the map is on screen. The map is excluded from the browser's scroll anchoring (`overflow-anchor:none`), and the page keeps the map in place when content above it changes height.
