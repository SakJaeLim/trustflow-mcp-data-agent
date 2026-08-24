import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createTrustFlowServer } from "../src/mcp/server.ts";
import { createRuntime } from "../src/runtime.ts";

test("air server exposes exactly the three required Company-X tools", async () => {
  const runtime = await createRuntime({
    ...process.env,
    POLICYGRAPH_RUNTIME: "offline",
    POLICYGRAPH_AUDIT_PATH: resolve(".policygraph", `test-mcp-${randomUUID()}.jsonl`),
    POLICYGRAPH_AUDIT_SIGNING_SECRET: "test-only-mcp-audit-signing-secret-at-least-32-bytes",
    POLICYGRAPH_AUDIT_CHECKPOINT_DIR: resolve(".policygraph", `test-mcp-checkpoints-${randomUUID()}`),
  });
  try {
    const server = createTrustFlowServer(runtime);
    const names = server.tools().map((tool) => tool.name);
    assert.deepEqual(names, ["nl2sql", "vector_search", "knowledge_graph"]);

    const raw = await server.callTool("knowledge_graph", {
      question: "Client-A가 사용 중인 제품 목록은?",
    });
    const result = JSON.parse(String(raw)) as { status: string; policy: { decision: string } };
    assert.equal(result.status, "executed");
    assert.equal(result.policy.decision, "ALLOW");
  } finally {
    await runtime.close();
  }
});
