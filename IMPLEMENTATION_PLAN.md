# Milestones and continuation

## Working vertical slices

1. Foundation: existing server/auth retained; migrations, many-company memberships and scoped role tests added.
2. Yard/stock: measured perimeter, physical containers, provenance, opening stock, ledger and restart checks.
3. Delivery: exact full/partial allocation, existing empty pack, assigned resources, loading checks, dispatch, arrival, crane placement and conserved totals.
4. Returns/control: same-engine return, counts/variance approval, carrying recovery, replay/concurrency tests and scoped APIs/exports.
5. Handover: connected browser views, click/card-drag commands, test harness, benchmark, backup and documentation. Evidence and browser-driver limits are in VALIDATION.md.

## Remaining acceptance work

Keep KNOWN_LIMITATIONS.md visible rather than claiming the complete commercial brief has passed. Priorities: combined multi-line requests; guided multi-yard/site geometry; richer operator/path representation; global search; normalized production schema; wider browser/device testing; deployment security review.

Every increment must use the same backend commands. Run npm test, npm run check and the relevant browser workflow. Conservation, valid custody, idempotency and tenant isolation remain release gates. Never add frontend balance editing or animation-driven completion.
