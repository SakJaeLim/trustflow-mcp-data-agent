# PolicyGraph 0.3.0 Security Remediation Report

## Scope

- Baseline scan: `41e9d69c-866e-41d1-b716-77a3c66cdba2`
- Baseline result: 17 validated findings (1 high, 12 medium, 4 low)
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

Expected release gates are zero TypeScript errors, 37 passing tests, a healthy read-only PostgreSQL path, a valid signed audit chain and exact-head checkpoint, zero npm vulnerabilities, a validated source manifest, and a finalized checksum list.

## Residual boundary

The local contest UI is loopback-only and is not an Internet-facing identity system. External deployment still requires TLS, OIDC/RBAC, independent secret storage, and an externally protected or WORM audit checkpoint. An attacker able to delete the ledger, checkpoint, and signing secret together remains outside the local-file integrity boundary.
