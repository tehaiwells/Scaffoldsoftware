# 0005. New commercial kinds: contract, variation, claim, scaffold, quote; never job

- Status: Accepted, 30 September 2026 (Phase 0).

## Context

Records live in one `objects` table by `kind`. The word **job** already means a simulated yard job: a crew task on the job board
(`crew.js`, `jobs.js`) with its own statuses, timers and effects. The roadmap adds commercial records above sites: the accepted price,
variations, progress claims, the scaffold as a record of its own, and quotes. Reusing "job" for any of them would mix a simulator
concept with money and make every query, test and screen ambiguous.

## Decision

New commercial kinds are named `contract`, `variation`, `claim`, `scaffold` and `quote`. None of them is ever called `job`, in code,
in the database or in API names. Screens may use the owner's own words (for example "Job" as a heading for a contract) as long as the
stored kind stays one of these names.

## Consequences

- `job` stays the yard crew's task and can later be retired with the simulator without touching money records.
- Reports and hire read the commercial kinds explicitly; nothing that adds up money ever reads `kind='job'`.
- The kind names are part of the schema documentation and the export format.
