# SCAFFOLD — local V1 simulation

A working local yard → forklift → truck → site crane → site → truck → yard workflow, with persistent custody, reservations, append-only transactions and audited stocktake corrections. This extends the existing Node/SQLite application. See KNOWN_LIMITATIONS.md for unfinished parts of the wider brief.

## Start

Requires Node.js 24+. From PowerShell:

    cd C:\Users\tehai\OneDrive\Documents\ChatGPT\scaffold\SCAFFOLD_YARD_V1
    npm.cmd ci
    npm.cmd start

Open http://127.0.0.1:3000. Runtime needs no third-party packages; npm ci installs locked browser-test tooling. The database location is described under "Where your data lives" below. The app binds to loopback. Stop with Ctrl+C. After abrupt termination, allow five seconds for the engine lease to expire before restarting. No downtime is fast-forwarded.

## Desktop app setup

`scripts/launch.cmd` starts the server in a minimised "Scaffold Yard server" window if it is not already running (shared on the local network with HOST=0.0.0.0) and opens the app in its own Edge app window. It works from wherever the repo is cloned, so each collaborator points their own desktop shortcut at their clone's `scripts\launch.cmd` (run minimised) for a one-click icon. Close the server window to stop it, for example after changing code in `src/`; static files under `public/` reload on refresh without a restart.

## Fast demonstration

    npm.cmd run seed:demo

This creates an isolated SYNTHETIC DEMO company with a measured yard, five workers, a forklift, a site crane, a truck, two 100-piece packs and a real empty stillage. The command prints a generated password for demo@example.test. Keep the output for sign-in. Re-running refuses to overwrite that account; set DEMO_EMAIL for another demo.

1. In REQUESTS, request **120 DEMO ledgers** for George Street. Select T-01 and **Plan packs & load truck**. The engine reserves exactly 100 plus 20 and uses the existing empty stillage for partial picking.
2. Follow movement activity. Busy machines queue; BLOCKED tasks explain what must be fixed before Retry. Pause/Resume is available.
3. In TRUCKS, wait until loading finishes. Loaded weight should be **700 kg**: 120 × 5 kg plus two 50 kg stillages. Dispatch to the site. Departure and arrival alone do not create site stock.
4. Choose **Unload at current location**. After crane placement, STOCK shows 80 in the yard and 120 at the site.
5. In SITES select each container, choose **Move to → T-01 → Confirm move request**. After return loading, dispatch back to the yard and unload. All 200 pieces return to yard custody through the same movement engine.
6. In STOCK start a scoped stocktake, enter observations and a reason, then approve as owner. That scope is locked until completion/cancellation. Corrections append history instead of replacing it.

Day-to-day work happens on HOME: the live yard plan with the crew controls, the fleet column (+1/−1 forklift, worker, empty stillage, 2 t and 12.5 t trucks) and the stockpile grids — every catalogue component as an icon; pick a step (−100 … +100) and click an icon to add that many to the yard (into the first available stillage, stacking new stillages on the shortest pile) or take that many out. On YARD (layout plan), **Plan a new layout** lets you drag stillages (drop one onto another to stack it), **Check plan** shows the ordered forklift instructions and **Commit this plan** sends them to the crew. **Change yard shape & size** (next to the size in the LIVE YARD PLAN header) opens the shape editor: pick Rectangle, L-shape or Custom, type Width and Depth or drag corners, sides, the loading zone, the gate and fixtures (truck entry/exit lanes, a toilet, the yard office), then press the one Save button; its sentence says what saving will do, such as which stillages move. To turn a stillage, select it on a plan and press **⟳ Turn** beside it (or R); the crew turns it, and a pile turns as a whole after a confirm.

WORKERS is the crew board: every worker has the ten yard skills, the five controls (Move, Stop, Automatic, Mount forklift, Unmount forklift), a NOW / NEXT / THEN / IDLE line, and Allocate / Next up buttons; with automatic yard jobs on, idle workers take real jobs derived from the yard by priority (trucks, loads, returns, consolidation, counts, yard organisation, cleaning) and rotate through routine work so nobody is static. Custom jobs go on the board from the form at the bottom.

OVERVIEW is the glance page: crew and forklift counts, each truck class split into Scheduled / Loading / Unloading / Complete, the stock in the yard, and a site list whose hover (or click) card shows the address, client details and the materials on that site. Client details are entered on the Client sites page.

For blank setup, create a simulation company in the UI; choose systems; create a yard in the shape editor (it starts as a 20 × 16 m rectangle: adjust Width and Depth or the shape, then Create yard); configure resources; add the synthetic catalogue under Account; register physical containers; record opening stock under STOCK. New yards never receive automatic stock.

## Yard shape and turning API

POST /api/commands/yard and /api/commands/siteBoundary take {id?, shapeRev?, name, height, points, loading, gate, fixtures?}; points is the closed ring of corners in millimetres (segments with closed:true is still accepted). POST /api/boundary-preview takes the same body plus detail:'quick' or 'full' and never writes. POST /api/turn-preview {container, rotation?} explains what a turn would do, and POST /api/commands/rotate {container, rotation} queues it, where rotation is the target orientation (90 minus the current one); both need operations.manage.

POST /api/commands/loadTruck takes {truck, containers:[ids]} and loads those stillages onto a truck parked at their yard or site. Stillages stacked on them are included and loaded top first as chained crew movements; the whole request is refused if any stillage cannot go.

## Tests

    npm.cmd test
    npm.cmd run check
    npm.cmd run benchmark
    npm.cmd run test:e2e -- --list

For independent Playwright browser testing:

    npx.cmd playwright install chromium
    npm.cmd run test:e2e

To use the Edge that is already installed instead of downloading Chromium, and a port other than 3100 (for example while the app itself runs on 3100), set two variables first (PowerShell):

    $env:PW_CHANNEL='msedge'; $env:E2E_PORT='3417'; npm.cmd run test:e2e

The browser tests start their own server with a throwaway database and backup folder in the system temp folder (never data/ or your live database) and use fresh demo emails.

GitHub runs the same checks automatically on every push and pull request to main (.github/workflows/ci.yml): npm ci, npm run check and npm test on Node 24, then the browser tests with Playwright's bundled Chromium on Linux. The results show as a tick or cross next to each commit on GitHub. See VALIDATION.md for tests actually executed; listing a test is not a completed run.

## Configuration and maintenance

PORT, HOST, DATABASE_PATH, BACKUP_DIR and COOKIE_SECURE are shell environment variables. .env.example documents them; .env is not loaded automatically.

### Where your data lives

- **Windows:** the live database is `%LOCALAPPDATA%\ScaffoldYard\scaffold.sqlite` (for example `C:\Users\<you>\AppData\Local\ScaffoldYard\scaffold.sqlite`). That folder is on the PC only and is not synced by OneDrive, so the server can write to it several times a second without sync churn or file locks.
- **Other systems:** data/scaffold.sqlite in the project folder.
- **DATABASE_PATH** overrides both. The server prints the path it uses when it starts ("Database: …"), and the Account page shows it under Backups.

**One-time move from data/scaffold.sqlite.** Older versions kept the database in the project's data folder. On the first start of this version (Windows, DATABASE_PATH not set, no database at the new place yet, data/scaffold.sqlite present) the server moves it, safely:

1. It takes a lock file (%LOCALAPPDATA%\ScaffoldYard\relocate.lock) so only one Scaffold Yard program at a time can choose, move or create the database. A second server started at the same moment waits for the first, then finds the moved database already in use and stops ("Another movement engine is running…"). A lock left by a program that no longer runs is taken over automatically.
2. If another Scaffold Yard server is still using the old file (its engine lease is live), nothing is moved: the server prints "Database NOT moved …" and keeps using the old file. Close the other server window and start again.
3. Otherwise it holds a write lock on the old file (anything else that tries to write waits, then fails, rather than writing to a file that is about to be retired; the lock disappears by itself if the server is killed, so nothing is left blocking the next start), makes a consistent copy with SQLite's backup API, and checks the copy (integrity check, and identical row counts in every table).
4. It puts the checked copy in the new place first, while the old file is still untouched, and only then renames the old file to data/scaffold.sqlite.moved-<date and time>, so it is kept as a backup and can never be opened by accident. data/DATABASE-MOVED.txt says where the live database went. If the old file changed in the moment between the copy and the rename, the move is undone and tried again next time.
5. If any step fails, the copy is removed, the old database is left as it was and stays in use, and the move is tried again on the next start. If the server is killed half-way, the next start finds either the untouched old file or the complete new one, never nothing.

The server prints one line either way ("Database moved to …" or "Database NOT moved (…)"). Later starts find the database at its new place and do nothing. Two safety nets:

- If the new place holds an empty database (for example one an old test run created) while data/scaffold.sqlite still has your companies, the empty one is set aside as scaffold.sqlite.empty-<date and time> and your real database is moved in.
- If the database is missing from the new place (or is there but empty) while a scaffold.sqlite.moved-… file with your data shows it was moved before, the server refuses to start ("Scaffold Yard did NOT start: … EMPTY database …") instead of quietly starting with an empty database. Put the file back (see Restoring a backup) and start again.

Scripts that write (seed:demo, import-catalogue) take the same lock and keep using the old file until the server has moved it; npm run backup only reads.

### Automatic backups

While the server runs it makes a consistent copy of the whole database once a day (the first hourly check after midnight) and, 30 seconds after start-up, whenever the newest daily copy is more than 24 hours old. Copies go to data/backups in the project folder (BACKUP_DIR overrides it), named scaffold-YYYY-MM-DD.sqlite. A server run on another database with DATABASE_PATH names its copies scaffold-<file name>-<8-character code>-YYYY-MM-DD.sqlite instead, so a test database never takes the live database's daily slot or rotates its files, even in the same folder. On Windows that folder is inside the synced project folder on purpose: one file a day gives an off-site copy without constant churn. Each copy is made through its own read-only connection with SQLite's backup API, never inside the movement engine's transaction, checked, and saved as a single self-contained file. The 14 newest daily copies are kept plus one per week for 8 weeks; only files named exactly scaffold-YYYY-MM-DD.sqlite (and the manual copies below) are ever removed. Copies dated in the future (from a wrong clock) are left alone and never push real ones out. Unfinished copies (*.partial) from a server that stopped mid-backup are removed at the next start. The server prints "Backup saved: …" or "Backup FAILED (…)".

Owners see a **Backups** panel on the Account page: the live database path, when the last backup ran, the backup folder, how many are kept, and **Back up now** (at most once a minute). Those manual copies are named scaffold-<date>T<time>-manual.sqlite; the 10 newest are kept and older ones are removed automatically.

A one-off copy to a file name of your choice still works, and never overwrites an existing file:

    npm.cmd run backup -- my-backup-2026-09-22.sqlite

### Restoring a backup

There is no restore button, on purpose. To restore:

1. Stop the server: close the "Scaffold Yard server" window (or press Ctrl+C where it runs).
2. In the live database folder (shown on the Account page), move scaffold.sqlite and any scaffold.sqlite-wal and scaffold.sqlite-shm files next to it into a spare folder. Keep them until you are sure.
3. Copy the backup you want from the backup folder into the live database folder and rename the copy to scaffold.sqlite.
4. Start Scaffold Yard again and check your stock.

On Windows the live database folder is normally C:\Users\<you>\AppData\Local\ScaffoldYard (paste %LOCALAPPDATA%\ScaffoldYard into the File Explorer address bar), and the backup folder is data\backups inside the project folder.

Never copy a backup over the live file while the server is running, and never leave an old -wal file next to a restored database.

Reviewed JSON catalogue batches can be imported with node scripts/import-catalogue.js approved-batch.json and local IMPORT_EMAIL / IMPORT_PASSWORD environment variables. See CATALOGUE_PROVENANCE.md. No PDFs are read automatically.

Read ARCHITECTURE.md, DOMAIN_MODEL.md, DATABASE_SCHEMA.md, IMPLEMENTATION_PLAN.md, CATALOGUE_PROVENANCE.md, VALIDATION.md and KNOWN_LIMITATIONS.md for boundaries, evidence and remaining work.
