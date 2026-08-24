import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRuntime } from "../src/runtime.ts";

interface QuestionFixture { q: string; tool: "nl2sql" | "vector_search" | "knowledge_graph" }

test("all 30 official questions execute with evidence and verified claims", async () => {
  const questions = JSON.parse(await readFile(resolve("data/companyx/questions.json"), "utf8")) as QuestionFixture[];
  const runtime = await createRuntime({
    ...process.env,
    POLICYGRAPH_RUNTIME: "offline",
    POLICYGRAPH_APPROVAL_SECRET: "test-only-approval-secret-at-least-32-bytes",
    POLICYGRAPH_AUDIT_PATH: resolve(".policygraph", `test-official-${randomUUID()}.jsonl`),
    POLICYGRAPH_AUDIT_SIGNING_SECRET: "test-only-official-audit-signing-secret-at-least-32-bytes",
    POLICYGRAPH_AUDIT_CHECKPOINT_DIR: resolve(".policygraph", `test-official-checkpoints-${randomUUID()}`),
  });
  const failures: Array<{ question: string; status: string; reason?: string }> = [];
  try {
    for (const item of questions) {
      try {
        const plan = runtime.planner.buildPlan(item.q);
        const result = await runtime.orchestrator.run(plan, {
          approvalReceipt: runtime.approvals?.issue(plan, "official-evaluation"),
        });
        const usableEvidence = result.evidence.filter((evidence) => evidence.kind !== "policy");
        if (result.status !== "executed" || usableEvidence.length === 0 || result.answer?.verified !== true) {
          failures.push({ question: item.q, status: result.status });
        }
      } catch (error) {
        failures.push({
          question: item.q,
          status: "threw",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await runtime.close();
  }
  assert.deepEqual(failures, []);
});
