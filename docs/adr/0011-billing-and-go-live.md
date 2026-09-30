# 0011. Billing you can send, and bringing an existing yard in (Phase 1A, part 4)

- Status: Accepted, 30 September 2026 (Phase 1A part 4 of 4). Builds audit §11 #6 (billing you can send: customer record, off-hire notice,
  issued statements, accounting file), the opening-lots core of #9 (go-live), §4.1 C7 (retention) and C9, §5.2 F3 and F6, and the audit's
  recommended defaults for §15 decisions 10 and 11 (invoicing stays in Xero or MYOB; the hire-stop rule is a company setting). Rests on
  [0008](0008-live-foundation.md), [0009](0009-record-reality.md) and [0010](0010-dispatch-and-returns.md). A real yard only: the Practice
  yard and its ticking suite are unchanged.

## Context

After part 3 a real yard prices hire from confirmed movements, but nothing it produces can go to a client: the statement number is
re-derived on every view, a rate edit re-prices periods already sent, the client is free text per site (five sites, five statements),
off-hire is not recorded, and month-end means re-keying into the accounting package. A buyer also starts with gear already on hire, and
nothing lets hire start "on 3 March". Money records must be kept for years, yet sites, rates and paperwork could be deleted outright.

## Decisions

**Invoicing stays in the accounting package (§15 decision 11, the audit's default).** The app issues *statements* and a monthly import
file; Xero or MYOB issues the tax invoice and tracks payment. Every statement carries the footer "statement — your accounting package
issues the tax invoice". (Whether a document must be a tax invoice, what it must show, and how long records are kept are matters for the
owner's adviser: the app makes no such claim in its UI; see *Verify with an adviser* below.)

**Customer (kind `customer`, migration 010 adds nothing to the schema for it).** `{name, abn, billingEmail, address, termsDays,
defaultPO, status ACTIVE|REMOVED}`; the ABN is checked with the same checksum as the company's own (`brand.js bdAbnValid`); names are unique
per company (case and spacing ignored). A site links to one customer (`site.customer`) and may carry its own PO (`site.po`), set when the
site is made (board, Send's New site, Office) or later (`siteDetails`). Existing free-text `client` fields become customers with
`customerLinkSites` — one command, run once by a person, within one company only: a site whose client text equals a customer's name
(normalised) links to it; otherwise a customer of exactly that name is made; each linked site remembers `customerFrom: 'client'` so
`customerUnlinkSite` undoes it. Nothing is ever matched across companies. New charge lines (ADR 0010) get `customer_id` from their site;
older lines (null) resolve through the site when a statement is issued.

**Off-hire (kind `offHire`, F3).** `offHireRequested {site, when (the day the builder called it off), whoCalled, note, pickupDay}` records
the notice, gives it the next pickup number (`P-1`, `P-2`, ...) and makes one bring-back order (ADR 0009, `B-n`) for everything on the
site's record, for the pickup day (default: the off-hire day, or today when that has passed). A pickup whose day passes without a
collection is `OFF_HIRE_OVERDUE` on Needs you.

**The hire-stop rule (§15 decision 10) is a company setting** (`hireSettings`, owner only, kind `hireSettings`): hire stops on
(a) the off-hire day, (b) the day after, or (c) at collection; default (a). (a) and (b) hold only when the gear is collected within
`collectWithinDays` (default 7) of the off-hire day; otherwise hire runs to collection. The rule is applied when the hire book is read
(`hire.js hireOffHire`, a pure function over one site and product's lots): a lot on hire on the off-hire day that was collected after the
stop day and within the window ends on the stop day instead; one collected later keeps its collection day and is marked "ran to
collection"; an uncollected lot inside the window is provisionally stopped on the stop day (the minimum hire applies as at collection) and
runs again if the window closes without a collection. Every statement line the rule touched says which pickup, who called, the stop day
and the collection day, and whether the rule or the window applied (`line.offHire[]`). The ledger is not changed: the rule is a reading
of it, and an issued statement freezes that reading.

**Issued, locked statements (kind `statement`).** `statementIssue {customer, to}` makes ONE statement per customer across every site of
that customer: for each site the period runs from the day after the site's `billedUpTo` (or its first hire day) to `to`, priced exactly
as the Hire page's preview (`hireStatement`), plus the site's charge lines (LOST, SITE_FINISH, quarantine CHARGED, with their approver)
not yet on a statement, plus the customer's open adjustments. The number is sequential per company (`ST-000001`; a unique index on the
number). The stored record is a complete snapshot (customer and company details, lines, rates, GST, totals, the hire-stop rule wording,
the charge lines, an `issuedBy`) plus the rendered text and its SHA-256, so a reprint (`GET /api/statement.txt?id=`) returns the stored
bytes. Two triggers refuse UPDATE and DELETE of a statement row; `statement_items` records which charge lines and adjustments a statement
carried (a charge is billed once); `site.billedUpTo` and `site.lastStatement` move on. Issuing is idempotent by command key; a second
issue for a period already billed is refused (`ALREADY_ISSUED`) with the statement that covers it. A statement with an unpriced product
is refused (`UNPRICED`), never sent incomplete. A statement is voided only by a reversing statement (`statementReverse`, owner): the same
lines negated under the next number, the sites' `billedUpTo` rolled back (refused when a later statement already bills the site), the
original's charges and adjustments released to the next statement. Changes after issue are `adjustment` records (`adjustmentAdd`, owner:
amount ex GST, description, reason, approver), carried by the customer's next statement. **A rate change after issue never re-prices an
issued statement**: in a real yard, "Correct past hire too" (a rate for every day) and any dated rate whose day falls inside a period
already billed for that product (a line of a standing statement, for that site when it is a site rate) are refused (`BILLED`, with the
statement, the site and the earliest day the rate may start) and point at an adjustment; a product never billed is priced freely; the
preview and the accrual read only days after `billedUpTo`. The due date is the issue day plus the customer's terms.

**The accounting file (one monthly export per company).** `GET /api/accounting.csv?format=xero|myob|generic&month=YYYY-MM` writes one
row per statement line (hire lines, charge lines, adjustments; a reversal's lines negative) for every statement issued in that month,
invoice number = statement number, customer = the customer's name, dates as the package expects (DD/MM/YYYY), amounts **ex GST** with the
account code from `hireSettings` (never invented: the download is refused with plain words until the owner sets it). Each download is
recorded in `statement_exports`. No API sync (Phase 2).

- *Xero:* the "Sales invoices" CSV import layout. Header, in Xero's order: `*ContactName, EmailAddress, POAddressLine1, POAddressLine2,
  POAddressLine3, POAddressLine4, POCity, PORegion, POPostalCode, POCountry, *InvoiceNumber, Reference, *InvoiceDate, *DueDate,
  InventoryItemCode, *Description, *Quantity, *UnitAmount, Discount, *AccountCode, *TaxType, TrackingName1, TrackingOption1,
  TrackingName2, TrackingOption2, Currency, BrandingTheme`. Sources: Xero's own template as reproduced in Milient's Xero export notes
  (https://docs.milientsoftware.com/help/moment-by-topic/integrations/file-exports/file-export-accounting-system/xero/xero-templates) and
  in a published conversion script (https://notestoself.dev/posts/etsy-sales-csv-xero-import-python-script/); Xero's rule that columns are
  not removed, re-ordered or renamed and that ContactName and InvoiceNumber are the strictly required columns
  (https://www.saasant.com/blog/import-sales-invoices-into-xero/, https://entryrocket.com/guides/xero-csv-import-guide). Xero's article
  itself (central.xero.com, "Import invoices") could not be fetched by the tooling (a script-rendered page), so the header is **verified
  against two independent reproductions of the template, not against a live Xero upload**: the first month's file must be tried on a Xero
  demo company. `TaxType` is the tax rate's name in Xero (`GST on Income` for an Australian organisation); it is a setting, shown with its
  default. When Xero asks, the amounts are *Tax Exclusive*; the page says so.
- *MYOB:* the "Sales – Service" import layout of MYOB AccountRight / MYOB Business, tab-delimited with a header row, field names in
  MYOB's order: `Co./Last Name, First Name, Addr 1 - Line 1 … Addr 1 - Line 4, Inclusive, Invoice No., Date, Customer PO, Ship Via,
  Delivery Status, Description, Account No., Amount, Job, Comment, Journal Memo, Salesperson Last Name, Salesperson First Name, Promised
  Date, Referral Source, Tax Code, Tax Amount, Freight Amount, Freight Tax Code, Freight Tax Amount, Sale Status, Currency Code, Terms -
  Payment is Due, Terms - Discount Days, Terms - Balance Due Days, Terms - % Discount, Terms - % Monthly Charge, Amount Paid, Payment
  Method, Payment Notes, Name on Card, Card Number, Authorisation Code, BSB, Account Number, Drawer/Account Name, Cheque Number, Category,
  Card ID, Record ID`. Source: MYOB's published "Import and export fields" page
  (https://www.myob.com/au/support/myob-business/import-export/myob-business-importing-and-exporting-data-import-and-export-fields):
  `Co./Last Name`, `Account No.` and `Amount` are mandatory; `Inclusive` = `X` marks a tax-inclusive amount (left blank: the amounts are
  ex tax); tab-delimited or comma-separated with a header row. **Verified against MYOB's published field list**, not against a live
  import. The customer must already exist as a card in MYOB with the same name (MYOB matches on it). `Tax Code` is a setting (default
  `GST`, MYOB's standard Australian code); the line's `Tax Amount` is the statement's GST shared across its lines by largest remainder, so
  the file's GST equals the statement's.
- *Generic:* every field in plain columns, for any other package or a spreadsheet.

**"Unbilled since <date>" and an Accounts role.** `unbilledView` (finance) gives, per customer and site, hire accrued after
`billedUpTo` plus unbilled charges and open adjustments, and the day it started; Today's business card shows it; Needs you gets
`UNBILLED` (hire accrued more than 31 days past `billedUpTo`, or a site on hire with no customer). Role `ACCOUNTS` (`finance.view`,
`statements.manage`, `customers.manage`; no `operations.manage`) is invited like any other role: it sees money and statements and never
operations (no sites, trucks, trips or Needs you); supervisors and crew never see money; an operations manager keeps customers and sees
"unbilled since <day>" on Needs you without the amount.

**Opening lots and the go-live import (the core of #9).** `openingLot {product, quantity, site, onHireSince, customer?}` puts pieces on a
site's record in a bundle with provenance `IMPORT` and `occurred_at` on that day (midday, company time), so hire runs from `onHireSince`
at the rates in force then — never from the import day (`hire.js` reads `occurred_at`). `goLiveImport {kind, rows}` takes a pasted
spreadsheet (kinds `customers`, `sites`, `stock`, `onHire`, `rates`) and, like the catalogue import, checks every row first
(`goLiveCheck`, pure): the whole batch is refused when any row is wrong, with each row's problems in plain words
(`POST /api/golive-preview` shows the same check without writing). In a real yard the three-system gate is lifted: a product may carry any
system and category name, and weight is optional (it is needed only for the truck-mass check; a part without one goes on the truck with
no mass shown). `parallelRun {from, to, invoiced: [{customer, amount}]}` puts the app's figure per customer beside what the office
invoiced, with the difference. The parts picker on the board is offered again after the first list (the page's job: `gameCatalogue` only
adds what is missing).

**Retention in a real yard.** Nothing money- or time-relevant is hard-deleted: customers, sites, rates and paperwork are removed with a
reason and kept (`removedAt`, `removedReason`; the existing removed / finished lists show them; Remove site keeps the site's history and
archives even a never-used site instead of deleting it); statements are never removed. The ledger, trip confirmations, charge lines,
statements and messages are not pruned within `retentionYears` (a setting, default 7); the clock's daily housekeeping in a real yard
removes only closed messages and notifications older than that.

## Verify with an adviser (notes, never claims in the UI)

- Tax invoices: a GST-registered supplier must give a tax invoice on request for taxable sales over $82.50 (ATO). This design leaves the
  tax invoice to the accounting package on purpose; confirm the statement wording with an adviser.
- Record keeping: business records are generally kept for 5 years (ATO); employee time records 7 years (Fair Work). `retentionYears`
  defaults to 7 so both are covered; confirm.
- GST: 10 % on the ex-GST subtotal, rounded to the cent, as before; confirm the rounding rule the accountant prefers (per line or per total).

## Consequences

- New commands (all LIVE only, on the allow-list): `customerSave`, `customerRemove`, `customerRestore`, `customerLinkSites`,
  `customerUnlinkSite` (`customers.manage`); `offHireRequested` (`operations.manage`); `hireSettings`, `statementReverse`,
  `adjustmentAdd` (`company.manage`); `statementIssue` (`statements.manage`); `openingLot` (`stock.adjust`); `goLiveImport`
  (`company.manage`). `siteDetails`, `site`, `gameSite` and `archive` take `customer`, `po` and `reason`.
- New reads: `GET /api/customers`, `/api/hire-settings`, `/api/statements?customer=&month=`, `/api/statement?id=`,
  `/api/statement.txt?id=`, `/api/statement-preview?customer=&to=`, `/api/unbilled`, `/api/accounting.csv?format=&month=`,
  `/api/off-hire`, `POST /api/golive-preview`, `POST /api/parallel-run`. `GET /api/hire` carries `offHire` on statement lines,
  `billedUpTo` per site and `settings`; Today's business card carries `unbilled`.
- The Practice yard is untouched: every command here is `requireLive`; the triggers and tables of migration 010 are additive.
- Tests: `test/live-billing.test.js` (customers and the one-time link; the hire-stop rule in each variant with the window; off-hire →
  pickup → collected → the statement says so; one statement per customer across two sites; idempotent issue, byte-identical reprint,
  the DB trigger; a rate change after issue changes nothing issued and is refused past `billedUpTo`; reversal; adjustments; charge lines on
  the right customer; Xero and MYOB files parse and carry the totals; unbilled and Needs you; permissions; the LIVE invariant),
  `test/live-golive.test.js` (opening lots run from `onHireSince`, the import checks and refusals, any system name, weight optional,
  the parallel run, retention), and `e2e/live-billing-api.spec.js` on the running server.
