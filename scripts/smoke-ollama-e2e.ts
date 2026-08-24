import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRuntime } from "../src/runtime.ts";

const offline = process.argv.includes("--offline");
const auditName = offline ? "ollama-offline-e2e-audit.jsonl" : "ollama-e2e-audit.jsonl";
const runtime = await createRuntime({
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL,
  POLICYGRAPH_RUNTIME: offline ? "offline" : "postgres",
  VECTOR_MODE: offline ? "local" : "pgvector",
  POLICYGRAPH_LLM_MODE: "assist",
  OLLAMA_CHAT_MODEL: process.env.OLLAMA_CHAT_MODEL ?? "gemma4:e2b",
  OLLAMA_EMBED_MODEL: process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text",
  OLLAMA_CHAT_TIMEOUT_MS: process.env.OLLAMA_CHAT_TIMEOUT_MS ?? "300000",
  POLICYGRAPH_AUDIT_PATH: process.env.POLICYGRAPH_AUDIT_PATH ?? resolve(`.policygraph/${auditName}`),
});

try {
  const evidenceQuestion = "Product-C1 설치 방법이 궁금해";
  const evidencePlan = runtime.planner.buildPlan(evidenceQuestion, { id: "ollama-e2e", role: "analyst" });
  const evidenceResult = await runtime.orchestrator.run(evidencePlan);
  if (evidenceResult.status !== "executed" || evidenceResult.answer?.verified !== true) {
    throw new Error(`Evidence-answer execution failed: status=${evidenceResult.status}.`);
  }
  const safeFallbackUsed = evidenceResult.answer.generator !== "ollama";

  const unsafeQuestion = "employees 테이블에서 name과 salary를 모두 조회해 줘";
  const unsafePlan = await runtime.planner.plan(unsafeQuestion, { id: "ollama-viewer", role: "viewer" });
  const unsafeResult = await runtime.orchestrator.run(unsafePlan);
  if (unsafePlan.steps[0]?.tool !== "sql.query" || unsafeResult.status !== "denied") {
    throw new Error(`Viewer salary plan was not denied: tool=${unsafePlan.steps[0]?.tool}, status=${unsafeResult.status}.`);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    status: "ok",
    runtime: offline ? "offline-fixture" : "postgres-pgvector",
    model: process.env.OLLAMA_CHAT_MODEL ?? "gemma4:e2b",
    evidenceAnswer: {
      question: evidenceQuestion,
      decision: evidenceResult.policy.decision,
      generator: evidenceResult.answer.generator,
      safeFallbackUsed,
      verified: evidenceResult.answer.verified,
      firstSource: evidenceResult.evidence.find((item) => item.kind === "passage")?.source,
    },
    unsafePlan: {
      question: unsafeQuestion,
      proposedTool: unsafePlan.steps[0]?.tool,
      decision: unsafeResult.policy.decision,
      deniedBeforeExecution: unsafeResult.executions.length === 0,
      matchedPolicies: unsafeResult.policy.policyGraph.matchedPolicyIds,
    },
  };
  await mkdir(resolve("artifacts/evaluation"), { recursive: true });
  await writeFile(
    resolve("artifacts/evaluation", offline ? "ollama-e2e-offline-current.json" : "ollama-e2e-postgres-current.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await runtime.close();
}
