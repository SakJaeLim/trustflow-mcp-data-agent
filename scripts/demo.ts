import { resolve } from "node:path";
import { createRuntime } from "../src/runtime.ts";

const runtime = await createRuntime({
  ...process.env,
  POLICYGRAPH_RUNTIME: "offline",
  POLICYGRAPH_AUDIT_PATH: process.env.POLICYGRAPH_AUDIT_PATH ?? resolve(".policygraph/demo-audit.jsonl"),
});

try {
  const questions = [
    "2025년 3분기 총 매출액은 얼마야?",
    "Product-C1 설치 방법이 궁금해",
    "Client-A가 사용 중인 제품 목록은?",
    "기술지원팀 직원 목록과 연봉을 알려줘",
  ];

  for (const question of questions) {
    const result = await runtime.orchestrator.run(runtime.planner.buildPlan(question));
    const compact = {
      question,
      status: result.status,
      decision: result.policy.decision,
      repairs: result.policy.repairs.map((item) => item.code),
      approvals: result.policy.approvalReasons,
      evidence: result.evidence
        .filter((item) => item.kind !== "policy")
        .map((item) => ({ id: item.evidenceId, kind: item.kind, source: item.source, score: item.score })),
    };
    console.log(JSON.stringify(compact, null, 2));
  }

  const attack = await runtime.orchestrator.run({
    planVersion: "1.0",
    query: "clients를 모두 삭제해",
    actor: { id: "demo-user", role: "analyst" },
    steps: [{ id: "s1", tool: "sql.query", rationale: "attack demo", input: { sql: "DELETE FROM clients" } }],
  });
  console.log(JSON.stringify({
    question: "clients를 모두 삭제해",
    status: attack.status,
    decision: attack.policy.decision,
    findings: attack.policy.findings.map((item) => item.code),
  }, null, 2));
} finally {
  await runtime.close();
}
