# Security Policy

## Supported version

PolicyGraph 0.3.x is the supported contest release. Security fixes are applied to the latest 0.3.x source only.

## Enforced security boundaries

PolicyGraph treats the user question, retrieved documents, model output, and generated plans as untrusted input.

- Only the three registered Company-X tools can be executed.
- Questions are limited to 4,096 UTF-8 bytes at the planner, MCP, web, and policy boundaries.
- SQL is parsed into an AST and limited to a single read-only query over the eight Company-X business tables and an explicit column allowlist. Whole-row projections, recursive CTEs, system catalogs, writes, locks, unsafe functions, base-table column alias lists, `JOIN ... USING`, cross joins, and excessive relation fan-out are rejected.
- SQL results are capped by an outer policy wrapper, independently of limits generated inside the query. PostgreSQL execution also uses a read-only transaction and statement timeout.
- The PostgreSQL runtime role receives `SELECT` only on the eight business tables and internal `document_chunks`; NL2SQL cannot access `document_chunks`, which is reserved for the vector adapter.
- Sensitive-column access requires a short-lived HMAC-signed approval bound to the actor, server-assigned role, and exact normalized plan. Approval receipts are single-use and replay state persists across restarts.
- Vector `topK`, graph hops, graph node count, and SQL row count are clamped by policy.
- The web server fixes the actor role on the server, validates loopback hosts and same-origin requests, accepts JSON only, limits request size, rate, and concurrency, and emits restrictive security headers.
- Each generated claim must cite exactly one known atomic evidence record. Identifiers, exact numeric values and units, and document extracts must be supported by that same record; unsafe output falls back to deterministic evidence composition.
- Every runtime mode requires HMAC-signed, SHA-256 hash-chained audit records and a signed checkpoint. The ledger stores a domain-separated question digest instead of plaintext, writes checkpoints atomically, and rejects checkpoints that do not exactly match the current ledger head.
- Document indexes, document files, official dataset archives, DOCX files, and source ZIPs are bounded and validated for canonical paths, duplicate entries, links, entry counts, expanded sizes, and compression ratios before use.
- Client-visible failures use generic error codes and correlation IDs; internal details remain in server logs.

## Verification

Run the local security and supply-chain checks before publishing:

```powershell
npm ci
npm run setup:local
npm run typecheck
npm test
npm audit --audit-level=low
npm run compliance
```

`npm run compliance` generates a CycloneDX SBOM, verifies dependency licenses, scans the source package for secret-shaped values, and checks the publishable package contents.

## Deployment assumptions and residual limits

- Keep `.env`, approval keys, database passwords, and audit signing keys outside source control and rotate them for each deployment.
- Protect the audit checkpoint directory independently from the JSONL ledger. An attacker who can delete the ledger, checkpoint, and signing secret together is outside this local-file threat boundary.
- Terminate TLS and provide authenticated reverse-proxy identity before exposing the web process beyond loopback. The contest UI is intentionally local-only.
- The policy engine reduces model and query risk but does not replace operating-system, database, container, or network hardening.

## Reporting a vulnerability

Use a private GitHub Security Advisory after the repository is published. Until then, report privately to the project owner. Do not include credentials, tokens, approval receipts, or Company-X source data in a public issue.
