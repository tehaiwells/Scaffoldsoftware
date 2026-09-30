# 0004. Hosting: one instance per customer behind a TLS proxy

- Status: Accepted, 30 September 2026 (Phase 0). Applies from the first paying customer.

## Context

Today the app runs on one Windows PC in the yard office, over plain HTTP, and until Phase 0 any company owner on a shared server could
see its file paths and back up the whole server. Drivers on the road cannot reach a PC on the office network, and one person cannot
support installs at many customers. A shared multi-tenant database would need a shared identity and session store and scheduler
changes.

## Decision

- **Managed single-tenant:** one instance (a Node process plus its own SQLite database file) per customer, hosted by the vendor in an
  Australian region, behind a TLS-terminating reverse proxy.
- The server trusts the proxy only for the forwarded scheme and client address; Host and Origin are checked against an allowlist
  (Phase 0 D1), and the session cookie is Secure behind TLS.
- Per-company database files inside one server process, or one shared multi-tenant database, are **Phase 5 decisions**, taken only on a
  measured cost trigger.
- On-premises "yard box" installs are not sold. The owner's own PC stays supported as customer zero, loopback-only by default.

## Consequences

- Each customer's data is physically separate, which removes cross-tenant backup exposure by construction and answers the
  vendor-trust question.
- Backups, restore drills and the encrypted off-machine copy (Phase 0 D13) are per instance.
- Deployment needs a small runbook: provisioning, TLS certificates, updates with a pre-migration backup, monitoring.
