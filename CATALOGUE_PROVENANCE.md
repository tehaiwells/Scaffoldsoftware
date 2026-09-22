# Catalogue provenance and unresolved data

No manufacturer source documents were read or imported. None of the candidate PDFs was present in this project directory. The rejected internal/private AT-PAC Yard Pick Ticket was not read, used, compared, or turned into fixtures.

`catalogues/synthetic.json` is original, intentionally invented DEMO ONLY data, not a summary of any manufacturer catalogue. It contains two fictional component variants and one explicitly unknown-weight variant. The 5 kg/3 kg unit weights and 100/50 operating pack quantities are synthetic. The demo 2 m × 1 m × 1 m stillage with 50 kg tare is synthetic. These are not commercial factual specifications, load ratings, endorsements or safe-working limits.

The truck's initial 6000 × 2050 mm deck and 12,500 kg payload come from the user's brief and remain simulation configuration. Yard seven-level and truck two-level stack rules are simulation assumptions. Worker counts, pickup/placement times, travel speed, capacity and crane worker requirements are explicitly configurable demo values.

Data separates product definitions, exact variants, sources, packaging profiles and company settings. Every variant references source metadata with document, manufacturer, region, edition, page, URL, review status and limitations. Unknown dimensions/weights/pack settings remain NULL with a reason. Company overrides are separately recorded and audited. Duplicate manufacturer + region + reference imports are rejected rather than silently merged; use distinct references for genuine finishes/variants. Spanner settings use tenths of a millimetre, independently of any bolt/thread data.

For reviewed factual imports, prepare a JSON object with `name` and `products` (1–100 records). Each record needs `name`, `reference`, `system`, `manufacturer`, `region`, `verification`, and nullable `unitWeight` in grams, `length`/`width`/`height` in mm and `packQuantity`. SOURCE VERIFIED additionally requires `document` and `page`. Include `edition`, `url`, `limitations`, `nominalSize` and `finish` when known. `publishedQuantity` is separate from the company operating pack quantity. No import creates company stock.

Set IMPORT_EMAIL and IMPORT_PASSWORD in your local shell, then run `node scripts/import-catalogue.js approved-batch.json`. The importer authenticates the operator and executes one atomic command; any invalid/conflicting row rolls the whole batch back. It imports reviewed structured facts, not PDFs or photographs. Approval and legal suitability of factual source reuse remain a human review step. No commercial reuse or manufacturer endorsement is claimed.

All real manufacturer values, regional variants, container models, tare masses, safe ratings, pack conventions, machine profiles and operating times remain unverified and require owner review. Live operations are deliberately not implemented.
