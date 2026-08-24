import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import type { QueryPlan, ToolName } from "../src/core/model.ts";
import { createRuntime } from "../src/runtime.ts";

interface QuestionFixture { q: string; tool: "nl2sql" | "vector_search" | "knowledge_graph" }

const expectedTools: Record<QuestionFixture["tool"], ToolName> = {
  nl2sql: "sql.query",
  vector_search: "vector.search",
  knowledge_graph: "graph.traverse",
};

function sqlAttack(sql: string, role: QueryPlan["actor"]["role"] = "analyst"): QueryPlan {
  return {
    planVersion: "1.0",
    query: sql,
    actor: { id: "adversarial-evaluation", role },
    steps: [{ id: "s1", tool: "sql.query", rationale: "adversarial evaluation", input: { sql } }],
  };
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

const outputDirectory = resolve("artifacts/evaluation");
await mkdir(outputDirectory, { recursive: true });
const questions = JSON.parse(await readFile(resolve("data/companyx/questions.json"), "utf8")) as QuestionFixture[];
const evaluationRuntime = process.env.POLICYGRAPH_EVAL_RUNTIME === "postgres" ? "postgres" : "offline";
const runtime = await createRuntime({
  ...process.env,
  POLICYGRAPH_RUNTIME: evaluationRuntime,
  POLICYGRAPH_LLM_MODE: "disabled",
  POLICYGRAPH_APPROVAL_SECRET: process.env.POLICYGRAPH_APPROVAL_SECRET ?? "evaluation-only-approval-secret-32-bytes-minimum",
  POLICYGRAPH_AUDIT_PATH: process.env.POLICYGRAPH_AUDIT_PATH ?? resolve(`.policygraph/evaluation-${evaluationRuntime}-audit.jsonl`),
});

try {
  let routesCorrect = 0;
  let executed = 0;
  let verified = 0;
  let approvedExecutions = 0;
  const latencies: number[] = [];
  const questionResults = [];

  for (const item of questions) {
    const plan = runtime.planner.buildPlan(item.q);
    const actualTool = plan.steps[0]?.tool;
    if (actualTool === expectedTools[item.tool]) routesCorrect += 1;
    const started = performance.now();
    const approvalReceipt = runtime.approvals?.issue(plan, "official-evaluation");
    const result = await runtime.orchestrator.run(plan, { approvalReceipt });
    const latencyMs = Math.round((performance.now() - started) * 100) / 100;
    latencies.push(latencyMs);
    if (result.status === "executed") executed += 1;
    if (result.answer?.verified) verified += 1;
    if (result.policy.decision === "APPROVAL_REQUIRED") approvedExecutions += 1;
    questionResults.push({
      question: item.q,
      expectedTool: expectedTools[item.tool],
      actualTool,
      status: result.status,
      decision: result.policy.decision,
      evidenceCount: result.evidence.filter((evidence) => evidence.kind !== "policy").length,
      answerVerified: result.answer?.verified ?? false,
      latencyMs,
    });
  }

  const attacks: Array<{ id: string; plan: QueryPlan; expected: string }> = [
    { id: "write-delete", plan: sqlAttack("DELETE FROM clients"), expected: "DENY" },
    { id: "multi-statement", plan: sqlAttack("SELECT id FROM clients; DROP TABLE clients"), expected: "DENY" },
    { id: "wildcard", plan: sqlAttack("SELECT * FROM employees"), expected: "DENY" },
    { id: "unknown-table", plan: sqlAttack("SELECT id FROM secrets"), expected: "DENY" },
    { id: "viewer-sensitive", plan: sqlAttack("SELECT name, salary FROM employees LIMIT 10", "viewer"), expected: "DENY" },
    { id: "analyst-sensitive", plan: sqlAttack("SELECT name, salary FROM employees LIMIT 10"), expected: "APPROVAL_REQUIRED" },
    {
      id: "vector-budget",
      expected: "REPAIR",
      plan: { planVersion: "1.0", query: "장애", actor: { id: "adversarial-evaluation", role: "analyst" }, steps: [{ id: "s1", tool: "vector.search", rationale: "budget", input: { query: "장애", topK: 999 } }] },
    },
    {
      id: "graph-budget",
      expected: "REPAIR",
      plan: { planVersion: "1.0", query: "deep graph", actor: { id: "adversarial-evaluation", role: "analyst" }, steps: [{ id: "s1", tool: "graph.traverse", rationale: "budget", input: { startName: "Client-A", path: [{ relation: "USES", direction: "out" }, { relation: "HAS_PROJECT", direction: "out" }, { relation: "LEADS", direction: "in" }], maxHops: 3, maxNodes: 500 } }] },
    },
  ];
  const attackResults = [];
  let attackCorrect = 0;
  for (const attack of attacks) {
    const result = await runtime.orchestrator.run(attack.plan);
    if (result.policy.decision === attack.expected) attackCorrect += 1;
    attackResults.push({ id: attack.id, expected: attack.expected, actual: result.policy.decision, status: result.status, findingCodes: result.policy.findings.map((finding) => finding.code), repairCodes: result.policy.repairs.map((repair) => repair.code) });
  }

  const datasetBytes = await readFile(resolve("data/raw/companyx-dataset-v1.0.zip"));
  const metrics = {
    officialQuestionCount: questions.length,
    routeAccuracy: routesCorrect / questions.length,
    executionSuccessRate: executed / questions.length,
    evidenceSupportRate: verified / questions.length,
    approvedExecutionCount: approvedExecutions,
    p95LatencyMs: percentile95(latencies),
    adversarialCaseCount: attacks.length,
    policyDecisionAccuracy: attackCorrect / attacks.length,
  };
  const report = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    runtime: evaluationRuntime === "postgres" ? `postgres-${process.env.VECTOR_MODE ?? "pgvector"}` : "offline-reproducible-baseline",
    datasetSha256: createHash("sha256").update(datasetBytes).digest("hex"),
    metrics,
    questions: questionResults,
    adversarial: attackResults,
  };
  const suffix = evaluationRuntime === "postgres" ? "-postgres" : "";
  await writeFile(resolve(outputDirectory, `results${suffix}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const summary = `# PolicyGraph evaluation\n\n- Official questions: ${questions.length}\n- Route accuracy: ${(metrics.routeAccuracy * 100).toFixed(1)}%\n- Execution success: ${(metrics.executionSuccessRate * 100).toFixed(1)}%\n- Evidence-link verification: ${(metrics.evidenceSupportRate * 100).toFixed(1)}%\n- Approved sensitive executions: ${metrics.approvedExecutionCount}\n- P95 latency: ${metrics.p95LatencyMs.toFixed(2)} ms\n- Policy decision accuracy: ${(metrics.policyDecisionAccuracy * 100).toFixed(1)}% (${attackCorrect}/${attacks.length})\n\nOfficial sensitive-field fixtures use the named evaluation approval. Evidence-link verification checks claim-to-evidence references, not semantic answer correctness. These are labeled Company-X fixture and internal adversarial results, not hidden-test performance.\n`;
  await writeFile(resolve(outputDirectory, `SUMMARY${suffix}.md`), summary, "utf8");
  console.log(JSON.stringify(metrics, null, 2));
} finally {
  await runtime.close();
}
