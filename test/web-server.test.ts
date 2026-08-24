import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createRuntime } from "../src/runtime.ts";
import { createPolicyGraphWebServer } from "../src/web/server.ts";

test("web demo serves health, executes a question, and blocks an attack", async () => {
  const runtime = await createRuntime({
    ...process.env,
    POLICYGRAPH_RUNTIME: "offline",
    POLICYGRAPH_AUDIT_PATH: resolve(".policygraph", `test-web-${randomUUID()}.jsonl`),
    POLICYGRAPH_AUDIT_SIGNING_SECRET: "test-only-web-audit-signing-secret-at-least-32-bytes",
    POLICYGRAPH_AUDIT_CHECKPOINT_DIR: resolve(".policygraph", `test-web-checkpoints-${randomUUID()}`),
  });
  const server = createPolicyGraphWebServer(runtime, { maxRequestsPerMinute: 3 });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const healthResponse = await fetch(`${base}/api/health`);
    const health = await healthResponse.json() as { status: string; actorRole: string; mcpTools: string[] };
    assert.equal(health.status, "ok");
    assert.equal(health.actorRole, "analyst");
    assert.deepEqual(health.mcpTools, ["nl2sql", "vector_search", "knowledge_graph"]);
    assert.match(healthResponse.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    const hostileOrigin = await fetch(`${base}/api/ask`, {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "text/plain" },
      body: JSON.stringify({ question: "현재 활성 상태인 계약 수는 몇 개야?" }),
    });
    assert.equal(hostileOrigin.status, 403);
    const wrongType = await fetch(`${base}/api/ask`, {
      method: "POST",
      headers: { origin: base, "content-type": "text/plain" },
      body: JSON.stringify({ question: "현재 활성 상태인 계약 수는 몇 개야?" }),
    });
    assert.equal(wrongType.status, 415);
    const answer = await fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "Client-A가 사용 중인 제품 목록은?", role: "analyst" }) }).then((response) => response.json()) as { status: string; answer?: { verified: boolean } };
    assert.equal(answer.status, "executed");
    assert.equal(answer.answer?.verified, true);
    const attack = await fetch(`${base}/api/scenario`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "write-attack" }) }).then((response) => response.json()) as { status: string; policy: { decision: string } };
    assert.equal(attack.status, "denied");
    assert.equal(attack.policy.decision, "DENY");
    const selfApproval = await fetch(`${base}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "기술지원팀 직원 목록과 연봉을 알려줘",
        role: "admin",
        approved: true,
      }),
    }).then((response) => response.json()) as { status: string; policy: { decision: string } };
    assert.equal(selfApproval.status, "approval_required");
    assert.equal(selfApproval.policy.decision, "APPROVAL_REQUIRED");
    const limited = await fetch(`${base}/api/scenario`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "budget-repair" }),
    });
    assert.equal(limited.status, 429);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await runtime.close();
  }
});
