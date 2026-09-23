# SCAFFOLD — local V1 simulation

A working local yard → forklift → truck → site crane → site → truck → yard workflow, with persistent custody, reservations, append-only transactions and audited stocktake corrections. This extends the existing Node/SQLite application. See KNOWN_LIMITATIONS.md for unfinished parts of the wider brief.

## Start

Requires Node.js 24+. From PowerShell:

    cd C:\Users\tehai\OneDrive\Documents\ChatGPT\scaffold\SCAFFOLD_YARD_V1
    npm.cmd ci
    npm.cmd start

Open http://127.0.0.1:3000. Runtime needs no third-party packages; npm ci installs locked browser-test tooling. SQLite is at data/scaffold.sqlite. The app binds to loopback. Stop with Ctrl+C. After abrupt termination, allow five seconds for the engine lease to expire before restarting. No downtime is fast-forwarded.

## Desktop app setup

`scripts/launch.cmd` starts the server in a minimised "Scaffold Yard server" window if it is not already running (shared on the local network with HOST=0.0.0.0) and opens the app in its own Edge app window. It works from wherever the repo is cloned, so each collaborator points their own desktop shortcut at their clone's scriptslaunch.cmd (run minimised) for a one-click icon. Close the server window to stop it, for example after changing code in `src/`; static files under `public/` reload on refresh without a restart.

## Fast demonstration

    npm.cmd run seed:demo

This creates an isolated SYNTHETIC DEMO company with a measured yard, five workers, a forklift, a site crane, a truck, two 100-piece packs and a real empty stillage. The command prints a generated password for demo@example.test. Keep the output for sign-in. Re-running refuses to overwrite that account; set DEMO_EMAIL for another demo.

1. In REQUESTS, request **120 DEMO ledgers** for George Street. Select T-01 and **Plan packs & load truck**. The engine reserves exactly 100 plus 20 and uses the existing empty stillage for partial picking.
2. Follow movement activity. Busy machines queue; BLOCKED tasks explain what must be fixed before Retry. Pause/Resume is available.
3. In TRUCKS, wait until loading finishes. Loaded weight should be **700 kg**: 120 × 5 kg plus two 50 kg stillages. Dispatch to the site. Departure and arrival alone do not create site stock.
4. Choose **Unload at current location**. After crane placement, STOCK shows 80 in the yard and 120 at the site.
5. In SITES select each container, choose **Move to → T-01 → Confirm move request**. After return loading, dispatch back to the yard and unload. All 200 pieces return to yard custody through the same movement engine.
6. In STOCK start a scoped stocktake, enter observations and a reason, then approve as owner. That scope is locked until completion/cancellation. Corrections append history instead of replacing it.

For blank setup, create a simulation company in the UI; choose systems; draw a yard (RIGHT 20 m, DOWN 16 m, LEFT 20 m, explicitly close); configure resources; add the synthetic catalogue under SETTINGS; register physical containers; record opening stock under STOCK. New yards never receive automatic stock.

## Tests

    npm.cmd test
    npm.cmd run check
    npm.cmd run benchmark
    npm.cmd run test:e2e -- --list

For independent Playwright browser testing:

    npx.cmd playwright install chromium
    npm.cmd run test:e2e

The browser test uses port 3100 and data/e2e.sqlite with a fresh demo email. See VALIDATION.md for tests actually executed; listing a test is not a completed run.

## Configuration and maintenance

PORT, DATABASE_PATH and COOKIE_SECURE are shell environment variables. .env.example documents them; .env is not loaded automatically.

    npm.cmd run backup -- data/backup-2026-09-22.sqlite

This uses SQLite's consistent backup API, including committed WAL data, and never overwrites an existing backup. To restore: stop the server; preserve the old database/WAL/SHM files; copy the backup to a new filename; point DATABASE_PATH to it; start and verify integrity and stock totals. Do not copy an active main database while ignoring its WAL.

Reviewed JSON catalogue batches can be imported with node scripts/import-catalogue.js approved-batch.json and local IMPORT_EMAIL / IMPORT_PASSWORD environment variables. See CATALOGUE_PROVENANCE.md. No PDFs are read automatically.

Read ARCHITECTURE.md, DOMAIN_MODEL.md, DATABASE_SCHEMA.md, IMPLEMENTATION_PLAN.md, CATALOGUE_PROVENANCE.md, VALIDATION.md and KNOWN_LIMITATIONS.md for boundaries, evidence and remaining work.
