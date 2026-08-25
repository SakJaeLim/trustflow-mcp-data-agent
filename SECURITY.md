# Security Policy

## Supported version

PolicyGraph 0.3.x is the supported contest release. Security fixes are applied to the latest 0.3.x source only.

## Enforced security boundaries

PolicyGraph treats the user question, retrieved documents, model output, and generated plans as untrusted input.

- Only the three registered Company-X tools can be executed.
- Questions are limited to 4,096 UTF-8 bytes at the planner, MCP, web, and policy boundaries.
- SQL is parsed into an AST and limited to a single read-only query over the eight Company-X business tables and an explicit column allowlist. Whole-row projections, recursive CTEs, system catalogs, writes, locks, unsafe functions, base-table column alias lists, `JOIN ... USING`, cross joins, and excessive relation fan-out are rejected.
- SQL results are capped by an outer policy wrapper, independently of limits generated inside the query. PostgreSQL execution also uses a read-only transaction and statement timeout.
- The PostgreSQL runtime role has no superuser, database/role creation, inheritance, replication, or row-security bypass capability, has a five-connection limit, and receives `SELECT` only on the eight business tables and internal `document_chunks`; NL2SQL cannot access `document_chunks`, which is reserved for the vector adapter.
- Sensitive-column access requires a short-lived HMAC-signed approval bound to the actor, server-assigned role, and exact normalized plan. Approval receipts are single-use and replay state persists across restarts.
- Vector `topK`, graph hops, graph node count, and SQL row count are clamped by policy.
- The web server fixes the actor role on the server, validates loopback hosts and same-origin requests, accepts JSON only, limits request size, rate, and concurrency, and emits restrictive security headers.
- Shared Ollama chat and embedding adapters admit at most one in-flight request each and reject excess model work before starting a network request.
- Each generated claim must cite exactly one known atomic evidence record. Table and graph answers are deterministic. A model-generated passage claim is accepted only when its normalized text is an exact contiguous span of the cited passage, with identifiers, numeric values, units, punctuation, and bidirectional-control checks preserved; unsafe output falls back to deterministic evidence composition.
- Every runtime mode writes an HMAC-signed `started` audit record before tool execution and a terminal record afterward. The SHA-256 hash-chained ledger stores a domain-separated question digest instead of plaintext, enforces ledger/record/count quotas, writes signed checkpoints atomically, and rejects checkpoints that do not exactly match the current ledger head. Lock files are never removed merely because of age.
- The official Company-X archive digest and every extracted file are verified at runtime, evaluation, and ingestion, not only at installation. Consumers read an authenticated in-memory snapshot rather than reopening mutable paths. PostgreSQL startup also compares all eight business tables and every pgvector chunk, dimension, dataset/generation/source/chunk hash, and reader-role capability with that snapshot.
- Document indexes, document files, graph files, official dataset archives, DOCX files, and source ZIPs are read through bounded same-file handles. ZIP validation binds central and local headers, CRCs, payload ranges, non-overlap, canonical paths, case/Unicode collisions, Windows path semantics, links, entry counts, expanded sizes, and compression ratios before use.
- Source releases are built from an exact allowlisted tree with per-file and aggregate limits and reject symlink, hardlink, and physical-path aliases. Finalization independently recomputes the workspace manifest, rejects duplicate manifest paths, and rescans the exact accepted ZIP entries for secret-shaped values, embedded archives, databases, and the official dataset digest.
- Ollama calls accept only an uncredentialed loopback HTTP origin, reject redirects, cap streamed JSON responses, validate embedding dimensions/scalars, and retain a finite timeout. Model planning failures fall back to a bounded known-document plan or a fail-closed non-executable plan; evidence-answer failures use deterministic verified evidence.
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
- Protect the audit checkpoint directory independently from the JSONL ledger and retain it in an append-only or WORM system in production. Coordinated deletion or replacement of both the ledger and checkpoint remains outside this local-file integrity boundary.
- Terminate TLS and provide authenticated reverse-proxy identity before exposing the web process beyond loopback. The contest UI is intentionally local-only.
- The policy engine reduces model and query risk but does not replace operating-system, database, container, or network hardening.

## Reporting a vulnerability

Use a private GitHub Security Advisory after the repository is published. Until then, report privately to the project owner. Do not include credentials, tokens, approval receipts, or Company-X source data in a public issue.
