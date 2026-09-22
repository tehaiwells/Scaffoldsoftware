# Catalogue provenance and unresolved data

No manufacturer source documents were read or imported. None of the candidate PDFs was present in this project directory. The rejected internal/private AT-PAC Yard Pick Ticket was not read, used, compared, or turned into fixtures.

`catalogues/synthetic.json` is original, intentionally invented DEMO ONLY data, not a summary of any manufacturer catalogue. It contains two fictional component variants and one explicitly unknown-weight variant. The 5 kg/3 kg unit weights and 100/50 operating pack quantities are synthetic. The demo 2 m × 1 m × 1 m stillage with 50 kg tare is synthetic. These are not commercial factual specifications, load ratings, endorsements or safe-working limits.

The truck's initial 6000 × 2050 mm deck and 12,500 kg payload come from the user's brief and remain simulation configuration. Yard seven-level and truck two-level stack rules are simulation assumptions. Worker counts, pickup/placement times, travel speed, capacity and crane worker requirements are explicitly configurable demo values.

Data separates product definitions, exact variants, sources, packaging profiles and company settings. Every variant references source metadata with document, manufacturer, region, edition, page, URL, review status and limitations. Unknown dimensions/weights/pack settings remain NULL with a reason. Company overrides are separately recorded and audited. Duplicate manufacturer + region + reference imports are rejected rather than silently merged; use distinct references for genuine finishes/variants. Spanner settings use tenths of a millimetre, independently of any bolt/thread data.

For reviewed factual imports, prepare a JSON object with `name` and `products` (1–100 records). Each record needs `name`, `reference`, `system`, `manufacturer`, `region`, `verification`, and nullable `unitWeight` in grams, `length`/`width`/`height` in mm and `packQuantity`. SOURCE VERIFIED additionally requires `document` and `page`. Include `edition`, `url`, `limitations`, `nominalSize` and `finish` when known. `publishedQuantity` is separate from the company operating pack quantity. No import creates company stock.

Set IMPORT_EMAIL and IMPORT_PASSWORD in your local shell, then run `node scripts/import-catalogue.js approved-batch.json`. The importer authenticates the operator and executes one atomic command; any invalid/conflicting row rolls the whole batch back. It imports reviewed structured facts, not PDFs or photographs. Approval and legal suitability of factual source reuse remain a human review step. No commercial reuse or manufacturer endorsement is claimed.

All real manufacturer values, regional variants, container models, tare masses, safe ratings, pack conventions, machine profiles and operating times remain unverified and require owner review. Live operations are deliberately not implemented.


## Supplier catalogue batches (catalogues/verified/)

Seven reviewed batches (514 variants) were transcribed from nine supplier documents the owner supplied on 2026-09-22 and are imported with status SOURCE VERIFIED, each record citing the document and page:

- Turbo Scaffolding (Australia) product sheets: Scaffold-Tubes, Scaffold-Fittings, Scaffold-Parts-&-Tools, Scaffold-Stairs-&-Ladders, Scaffold-Accessories-&-Specials, Aluminium-Lattice-Beams, Aluminium-Stairs, Kwikstage-Modular-Scaffold. Kwikstage items map to the Quickstage system; the tube, fitting, access, beam and accessory sheets map to Tube & Clip.
- AT-PAC (Atlantic Pacific Equipment) Product Catalog, North America edition 2020, Ringlock and Tube & Clamp: 337 variants mapped to the AT-PAC system.

Method: each document was transcribed by an automated reader working only from the printed text and tables; a second, independent checker re-read the cited pages for a sample of 90 records (about one in six) and found three discrepancies, all corrected before import. Every recorded unit weight is a value printed by the supplier (kg converted to grams exactly); nothing was estimated. Known limits: the supplier name on the Turbo sheets is a logo plus the printed website, and the region is inferred from the .com.au domain and Australian branch numbers; the Turbo sheets state that pictures are illustrative and product weight may vary; the Turbo lattice-beam sheet prints no product codes, so those references (ALB-P3-…) are generated and flagged; Turbo prints the code 2.0MALSTR on two different stair products, so the Aluminium-Stairs one is stored as ALS-2.0MALSTR; two AT-PAC 6.5" aluminium beam rows print placeholder weights and are stored without a weight; AT-PAC non-stock / lead-time markers are graphic icons and were not captured; some AT-PAC imperial size strings reproduce catalogue misprints. These remain supplier statements, not certified ratings, and the owner should review any value before relying on it.
