# Public portfolio demo

TrustFlow checks a structured query before it can reach a database. Run a complete
SQL policy/execution/evidence/audit walkthrough without a model, API key, Docker,
or the restricted competition dataset:

```sh
npm ci --ignore-scripts
npm run demo:public
```

Requires Node.js 24+. Installation needs network access; execution is offline.
The command creates an isolated SQLite database with two fictional clients and
one fictional employee, runs the real orchestrator, and deletes the temporary
fixture afterward. It prints JSON and exits nonzero if any check fails.

| Request | Decision | Database calls |
|---|---|---|
| Read client names with LIMIT | ALLOW | 1 |
| Read client names without LIMIT | REPAIR | 1 |
| Analyst reads salaries without approval | APPROVAL_REQUIRED | 0 |
| Delete clients | DENY | 0 |

Checks cover the returned client names, original plan preservation, blocked tool
execution, unchanged client count, valid audit chain, and detection of a modified
audit record. Six audit records cover the two start/finish pairs and two blocked
requests. The answer is produced by the deterministic evidence composer.

## What this demonstrates

An AI data assistant needs more than a plausible answer: its proposed action must
be checked before execution and its result must remain traceable. This demo shows
that boundary with independently authored synthetic data and machine-checkable
expectations. It can be reproduced by a reviewer from a fresh checkout.

## Limits

This is a SQL orchestration demonstration, not an LLM accuracy benchmark. It does
not exercise natural-language planning, MCP transport, graph/vector retrieval,
PostgreSQL deployment, signed approval issuance, or production-scale performance.
The existing contest runtime and official dataset integrity gates are unchanged.

## 한국어 소개

TrustFlow는 AI가 만든 데이터 조회 계획을 실행 전에 검사하고, 실행 결과에
근거와 감사기록을 연결하는 프로젝트입니다. 공개 데모에서는 가상 데이터로
정상 조회, 조회 범위 보정, 민감정보 승인 대기, 삭제 요청 차단을 재현합니다.
승인 대기와 차단 요청은 데이터베이스에 전달되지 않는지 확인하며, 감사기록을
변조했을 때 탐지되는지도 함께 검사합니다.

## Dependency remediation (2026-11-03)

The MCP adapter now uses the official SDK 1.32.2 and Zod 4.6.6 directly. The
intermediate framework that required Zod 3 has been removed rather than overridden.
The dependency audit gate remains enabled. MCP protocol tests cover initialization,
tool discovery, invalid input rejection before planning, and sanitized errors.
The standard-input/output entry point is exercised through a real client process.

Question and approval strings have explicit size limits. Unknown input keys are
rejected and topK must be a positive integer no greater than 100; the policy gate
still applies its own execution limits. This is not a general security certification.
