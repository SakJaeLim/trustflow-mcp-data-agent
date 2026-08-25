# PolicyGraph 0.3.0 Security Remediation Report

## Scope

- Baseline scan: `41e9d69c-866e-41d1-b716-77a3c66cdba2`
- Baseline result: 17 validated findings (1 high, 12 medium, 4 low)
- Follow-up scan: `70a40dc0-329a-4ba5-8de9-cf40f58584a0`
- Follow-up result: 18 validated findings (3 high, 9 medium, 6 low), including supply-chain consumption, write-ahead audit, and bounded-work gaps not covered by the baseline
- Third full scan: `e4c9b1ce-2091-4542-bbd3-29ed2faac7e7`
- Third result: 13 validated findings (3 high, 9 medium, 1 low), focused on recursive SQL bypasses, runtime data provenance, bounded model/archive consumption, and final-release binding
- Remediation scope: authored application, test, data-installation, audit, and submission-packaging code
- Excluded from source changes: `sources/`, generated dependencies, official source data, and user account operations

The fixes preserve the three required Company-X MCP tools and the published 30-question behavior. Security checks fail closed before a database, model, document, or archive can cross its configured trust boundary.

## Finding-to-fix traceability

| # | Validated issue | Remediation | Primary code | Regression or verification |
|---:|---|---|---|---|
| 1 | Base-table column alias list hid sensitive columns | Parse and reject base-table column alias lists before sensitive-column analysis | `src/policy/sql-analyzer.ts`, `src/policy/plan-gate.ts` | `test/policy.test.ts` expects `SQL_TABLE_COLUMN_ALIAS_BLOCKED` |
| 2 | `JOIN ... USING` enabled sensitive-column inference | Parse and reject `USING` joins | `src/policy/sql-analyzer.ts`, `src/policy/plan-gate.ts` | `test/policy.test.ts` expects `SQL_JOIN_USING_BLOCKED` |
| 3 | NL2SQL could query internal `document_chunks` | Limit NL2SQL to the eight business tables; keep the internal table behind the vector adapter | `src/policy/plan-gate.ts`, `src/adapters/pgvector-search.ts` | `test/policy.test.ts` expects `SQL_UNKNOWN_TABLE` |
| 4 | SQL joins could amplify computation | Reject cross joins and plans referencing more than three physical relations | `src/policy/sql-analyzer.ts`, `src/policy/plan-gate.ts` | `test/policy.test.ts` expects `SQL_COMPLEXITY_BUDGET_EXCEEDED`; a normal sales-client join remains allowed |
| 5 | MCP questions were unbounded | Enforce a 4,096-byte UTF-8 question limit in planner, policy, MCP, and web paths | `src/core/input-limits.ts`, `src/planner/companyx-planner.ts`, `src/policy/plan-gate.ts`, `src/web/server.ts` | `test/planner.test.ts`, `test/mcp-server.test.ts`, `test/web-server.test.ts` |
| 6 | User question text could be mistaken for claim evidence | Remove the question from the support corpus; validate only structured execution evidence | `src/adapters/ollama-chat.ts` | `test/ollama-answer.test.ts` forces deterministic fallback |
| 7 | One claim could splice facts from different evidence items | Require exactly one known evidence ID per claim and validate an atomic table row, passage, graph path, ranking, or node | `src/adapters/ollama-chat.ts` | `test/ollama-answer.test.ts` rejects a Product-A/42 cross-evidence claim |
| 8 | Numeric substring matching accepted `42` from `142` and ignored units | Canonicalize complete numeric tokens and require the exact value and unit in the cited segment | `src/adapters/ollama-chat.ts` | `test/ollama-answer.test.ts` rejects 42/142 and unit mismatch while accepting the valid value |
| 9 | Offline audit records could be unsigned | Require an audit signing secret and checkpoint directory in every runtime mode | `src/runtime.ts`, `scripts/verify-audit.ts` | `test/runtime-security.test.ts` |
| 10 | A stale but valid checkpoint could hide appended records | Require checkpoint sequence and hash to equal the current ledger head | `src/evidence/ledger.ts` | `test/audit-ledger.test.ts` rejects a checkpoint behind the ledger |
| 11 | Audit ledger retained plaintext questions | Store a domain-separated SHA-256 `queryDigest` instead of the query | `src/evidence/ledger.ts`, `src/runtime.ts` | `test/audit-ledger.test.ts` proves plaintext absence and digest determinism |
| 12 | Citations could include unused evidence | Emit only evidence IDs referenced by accepted claims | `src/evidence/composer.ts`, `src/adapters/ollama-chat.ts` | `test/ollama-answer.test.ts` checks the exact citation set |
| 13 | Document index filenames allowed traversal or linked files | Require basename-only `.md` names, resolved containment, regular files, and no symlinks | `src/core/document-corpus.ts`, `src/tools/local-vector-search.ts` | `test/data-tools.test.ts` |
| 14 | Document ingestion had unbounded memory and embedding work | Bound index, document, corpus, chunk count, and embedding batch size | `src/core/document-corpus.ts`, `scripts/ingest-documents.ts` | `test/data-tools.test.ts`; 40-document ingestion remains supported |
| 15 | Official dataset download was unbounded | Stream with a 16 MiB cap and timeout; verify archive hash and every extracted file byte-for-byte | `scripts/fetch-companyx.ts`, `scripts/fetch-companyx.ps1` | `test/fetch-data.test.ts`; `npm run fetch:data` verifies the installed fixture |
| 16 | Source ZIP verification trusted extracted paths and a partial manifest | Parse ZIP metadata first, require one canonical root, and verify the complete manifest path, size, hash, and entry set | `src/core/archive-safety.ts`, `scripts/finalize-submission.ts` | `test/fetch-data.test.ts`; `npm run package:verify`; `npm run submission:finalize` |
| 17 | Submission DOCX/source ZIPs could trigger decompression bombs | Reject excessive entries, expanded size, per-entry size, compression ratio, links, encryption, ZIP64, duplicates, and unsafe names before decompression | `src/core/archive-safety.ts`, `scripts/finalize-submission.ts` | `test/fetch-data.test.ts` includes traversal and compression-ratio attacks; finalizer preflights both archives |

## Follow-up hardening traceability

The follow-up scan deliberately re-examined the complete release instead of assuming the baseline fixes were sufficient. Its 18 validated issues were closed through the controls below.

| # | Follow-up issue | Implemented control | Primary code or verification |
|---:|---|---|---|
| 1 | Installed data could be replaced after download verification | Verify the official archive, exact extracted file set, paths, sizes, and hashes at every runtime, evaluation, and ingestion boundary | `src/core/companyx-integrity.ts`, `src/runtime.ts`, `scripts/evaluate.ts`, `scripts/ingest-documents.ts` |
| 2 | Database reader role retained unnecessary capability or unexpected ownership/membership | Enforce explicit role flags, connection limit, grants, no owned objects, and no unexpected role memberships | `db/init/03-readonly-role.sql`; live role query |
| 3 | Row-valued aliases outside the select list could bypass column authorization | Detect and reject row aliases throughout the parsed statement | `src/policy/sql-analyzer.ts`, `test/policy.test.ts` |
| 4 | CTE reuse could multiply logical relation work | Count physical and logical relation occurrences, including CTE references, and reject `ON TRUE` fan-out | `src/policy/sql-analyzer.ts`, `src/policy/plan-gate.ts` |
| 5 | System columns and session expressions were not governed by the business-column allowlist | Enforce exact per-table columns and reject unknown/system columns and keyword/session expressions | `src/policy/plan-gate.ts`, `test/policy.test.ts` |
| 6 | Model evidence checks allowed semantically unsupported paraphrases | Permit model text only as an exact normalized contiguous passage span; construct table/graph answers deterministically | `src/adapters/ollama-chat.ts`, `test/ollama-answer.test.ts` |
| 7 | Graph inputs and ranked starts could exceed intended work | Validate graph schema/size/reference integrity, index adjacency, and cap traversal/ranking starts and outputs | `src/tools/graph-store.ts`, `test/data-tools.test.ts` |
| 8 | Local and pgvector retrieval could perform unbounded feature/corpus work | Cap input/features/corpus bytes, precompute bounded candidates, and materialize snippets only after top-k | `src/tools/local-vector-search.ts`, `src/adapters/pgvector-search.ts` |
| 9 | Audit ledger could grow without a hard quota | Enforce 64 MiB ledger, 50,000 records, and 64 KiB record limits | `src/evidence/ledger.ts`, `test/audit-ledger.test.ts` |
| 10 | Age-based lock removal could break mutual exclusion | Never unlink a lock merely because it is old; fail closed for manual recovery | `src/evidence/ledger.ts` |
| 11 | A crash after tool execution could leave no execution intent record | Durably append signed `started` before calling a tool and then append the terminal state | `src/orchestrator.ts`, `test/orchestrator.test.ts` |
| 12 | Approval receipt parsing accepted oversized input | Cap receipts at 4,096 bytes and validate segment encoding and signature length before verification | `src/security/approval-authority.ts` |
| 13 | Chunked web bodies could occupy a connection indefinitely | Enforce length precheck, streamed byte cap, body deadline, and server timeout values | `src/web/server.ts`, `test/web-server.test.ts` |
| 14 | Path checks and later reads could observe different files | Open once, compare `lstat`/`fstat`, read within a cap, and recheck identity before accepting bytes | `src/core/safe-file.ts`, document/graph/release loaders |
| 15 | Source release construction lacked per-file and aggregate budgets | Use an exact release allowlist with 500-file, 16 MiB/file, and 64 MiB aggregate limits | `src/core/source-release.ts`, `scripts/build-source-bundle.ts` |
| 16 | Finalization trusted the ZIP's own manifest | Independently snapshot the workspace and compare exact manifest schema, root, date, exclusions, files, sizes, and hashes | `scripts/finalize-submission.ts` |
| 17 | Secret scanning covered only selected text extensions | Scan raw bytes for every allowlisted release file and reject archive/database signatures and the official data digest | `scripts/check-secrets.ts`, `artifacts/compliance/secret-scan.json` |
| 18 | Archive names could collide on Windows despite passing POSIX checks | Reject Unicode/case collisions, reserved devices, invalid characters, trailing dot/space, and overlong segments | `src/core/archive-safety.ts`, archive regression tests |

## Third-scan hardening traceability

The third scan targeted compositional bypasses that remained after the first two remediation rounds.

| # | Third-scan issue | Implemented control | Primary code or verification |
|---:|---|---|---|
| 1 | CTE names and projection aliases could shadow sensitive base-table references | Resolve schema-qualified base tables independently from CTE names and track source projection columns separately from output aliases | `src/policy/sql-analyzer.ts`, `test/policy.test.ts` |
| 2 | Nested qualified wildcard expressions could evade whole-row projection checks | Recursively inspect expressions and reject qualified row wildcards while retaining only safe unqualified `COUNT(*)` | `src/policy/sql-analyzer.ts`, `test/policy.test.ts` |
| 3 | PostgreSQL and pgvector evidence did not authenticate the current stored state | Compare reader identity, eight business-table snapshots, all vector rows, dimensions, and dataset/generation/source/chunk hashes before runtime starts | `src/core/postgres-integrity.ts`, `src/runtime.ts`, live PostgreSQL smoke |
| 4 | Verified Company-X files could be reopened after snapshot verification | Retain immutable bytes from the checksum-pinned archive and construct SQL, document, and graph consumers from that snapshot | `src/core/companyx-integrity.ts`, `src/core/document-corpus.ts`, tool factories |
| 5 | A growing file could force allocation beyond its configured cap | Read through the already verified handle into a buffer capped at `maxBytes + 1` and reject size/identity drift | `src/core/safe-file.ts` |
| 6 | pgvector refresh could leave a partially replaced corpus | Prepare embeddings first, then delete and insert under one transaction and advisory lock | `src/adapters/postgres.ts`, `scripts/ingest-documents.ts`; 40 authenticated chunks |
| 7 | Ollama responses and embedding scalar values were insufficiently bounded | Restrict endpoints to uncredentialed loopback HTTP, reject redirects, stream within byte caps, and validate finite bounded scalars | `src/adapters/bounded-http-json.ts`, Ollama adapters, `test/http-boundary.test.ts` |
| 8 | Secret scanning was not bound to the exact final source ZIP | Apply one raw-byte scanner to source snapshots before ZIP creation and to the exact accepted ZIP entries during finalization | `src/core/release-secret-scan.ts`, packaging scripts, `test/release-security.test.ts` |
| 9 | Duplicate manifest paths could hide one omitted authorized file | Reject duplicate canonical paths and require exact manifest/workspace path-set equality | `scripts/finalize-submission.ts` |
| 10 | Nested recursive/derived relations could evade SQL complexity budgets | Count recursive CTEs, all FROM items, AST nodes, AST depth, SQL bytes, and constant join fan-out | `src/policy/sql-analyzer.ts`, `src/policy/plan-gate.ts`, `test/policy.test.ts` |
| 11 | ZIP central metadata could disagree with local headers or overlapping payload ranges | Bind flags, method, CRC, sizes, data descriptors, local names, payload bounds and non-overlap; verify extracted CRCs | `src/core/archive-safety.ts`, `test/fetch-data.test.ts` |
| 12 | Source release files could alias through hardlinks or physical ancestors | Require realpath containment, single-link files, stable identity, and unique device/inode identities | `src/core/source-release.ts` |
| 13 | Audit quota admission did not reserve both terminal records | Reserve `started` plus terminal record capacity before append | `src/evidence/ledger.ts`, `test/audit-ledger.test.ts` |
| 14 | Shared pgvector embedding requests had no model-work admission | Reject a second in-flight embedding request before `fetch` and release capacity in `finally` | `src/adapters/ollama-embedder.ts`, `test/http-boundary.test.ts` |

## Verification performed

```powershell
npm run typecheck
npm test
npm run fetch:data
npm run smoke:postgres
npm run smoke:audit
npm run audit:verify
npm audit --audit-level=low
npm run compliance
npm run submission:finalize
```

Expected release gates are zero TypeScript errors, 49 passing tests, a healthy least-privilege PostgreSQL path, authenticated business/vector state, valid signed write-ahead/terminal audit records and exact-head checkpoint, 8/8 labeled model-or-fallback resilience cases, zero npm vulnerabilities, every allowlisted release file scanned, an independently validated source manifest, and a finalized checksum list. Model-backed and fallback case counts must be reported separately.

## Residual boundary

The local contest UI is loopback-only and is not an Internet-facing identity system. External deployment still requires TLS, OIDC/RBAC, independent secret storage, and an externally protected or WORM audit checkpoint. An attacker able to delete or replace both the ledger and checkpoint together remains outside the local-file integrity boundary.
