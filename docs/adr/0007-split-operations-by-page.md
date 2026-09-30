# 0007. Split operations.js by page as pages are touched; no PostgreSQL, microservices or SSE now

- Status: Accepted, 30 September 2026 (Phase 0).

## Context

`public/operations.js` is about 777 KB in about 3,300 lines, with lines up to 4,332 characters, and was touched by 50 of 69 commits.
It is hard to review, and one change can reach every page. The browser downloads it all on first load (about 1.9 MB uncompressed with
the rest). Proposals on the table included a rewrite, PostgreSQL, microservices and push updates (SSE).

## Decision

- **Split `operations.js` by page, as each page is next touched** for a feature or a fix: that page's code moves into its own module,
  loaded with a dynamic `import()`, in the same commit or the one before it. No big-bang split and no rewrite.
- First, one formatting commit and a line-length rule (Phase 0 D16), so the splits can be reviewed.
- **Not now:** PostgreSQL (one SQLite database per instance suffices, [0004](0004-one-instance-per-customer.md)), microservices, an
  event bus ([0003](0003-provenance-before-events.md)) and SSE. Live screens improve with better polling first (gzip, ETag/304 on a
  revision, idle back-off); SSE only if a measured cost demands it (Phase 4).

## Consequences

- The file shrinks steadily, and the pages the crew uses on phones load less at first.
- Tests stay on behaviour (rendered HTML through the page modules' exports, and the browser), so moving code does not break them.
- Revisit with a new record only on a measured trigger: response times from the benchmark gate, or hosting cost per customer.
