import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { InMemoryAuditLedger } from "../src/evidence/ledger.ts";
import { verifyAuditRecords } from "../src/evidence/ledger.ts";
import { TrustFlowOrchestrator } from "../src/orchestrator.ts";
import { PlanGate } from "../src/policy/plan-gate.ts";
import { CompanyXPlanner } from "../src/planner/companyx-planner.ts";
import { GraphStepExecutor, SqlStepExecutor, VectorStepExecutor } from "../src/tools/executors.ts";
import { GraphStore } from "../src/tools/graph-store.ts";
import { LocalVectorSearch } from "../src/tools/local-vector-search.ts";
import { SqliteFixture } from "../src/tools/sqlite-fixture.ts";

async function runtime() {
  const [database, graph, vector] = await Promise.all([
    SqliteFixture.fromDataset(resolve("data/companyx/sql")),
    GraphStore.fromDirectory(resolve("data/companyx/graph")),
    LocalVectorSearch.fromDirectory(resolve("data/companyx/documents")),
  ]);
  const ledger = new InMemoryAuditLedger();
  const orchestrator = new TrustFlowOrchestrator(new PlanGate(), ledger, [
    new SqlStepExecutor(database, "companyx.sqlite-fixture"),
    new VectorStepExecutor(vector),
    new GraphStepExecutor(graph),
  ]);
  return { database, ledger, orchestrator };
}

test("orchestrator repairs, executes, and audits a SQL plan", async () => {
  const { database, ledger, orchestrator } = await runtime();
  try {
    const planner = new CompanyXPlanner();
    const result = await orchestrator.run(planner.buildPlan("2025년 3분기 총 매출액은 얼마야?"));
    assert.equal(result.status, "executed");
    assert.equal(result.policy.decision, "REPAIR");
    assert.ok(result.evidence.some((item) => item.kind === "table"));
    assert.equal(result.answer?.verified, true);
    assert.equal(ledger.records.length, 2);
    assert.equal(ledger.records[0]?.status, "started");
    assert.equal(ledger.records[1]?.status, "executed");
    assert.equal(ledger.records[0]?.originalPlanHash.length, 64);
    assert.equal(ledger.records[0]?.recordHash.length, 64);
  } finally {
    await database.close();
  }
});

test("audit records form a verifiable hash chain", async () => {
  const { database, ledger, orchestrator } = await runtime();
  try {
    const planner = new CompanyXPlanner();
    await orchestrator.run(planner.buildPlan("2025년 3분기 총 매출액은 얼마야?"));
    await orchestrator.run(planner.buildPlan("Client-A가 사용 중인 제품 목록은?"));
    assert.deepEqual(verifyAuditRecords(ledger.records), { valid: true, errors: [] });
    assert.equal(ledger.records.length, 4);
    assert.equal(ledger.records[1]?.previousRecordHash, ledger.records[0]?.recordHash);
  } finally {
    await database.close();
  }
});

test("orchestrator does not execute a denied plan", async () => {
  const { database, ledger, orchestrator } = await runtime();
  try {
    const result = await orchestrator.run({
      planVersion: "1.0",
      query: "모두 삭제",
      actor: { id: "attacker", role: "analyst" },
      steps: [{ id: "s1", tool: "sql.query", rationale: "bad", input: { sql: "DELETE FROM clients" } }],
    });
    assert.equal(result.status, "denied");
    assert.equal(result.executions.length, 0);
    assert.equal(ledger.records.length, 1);
    assert.equal(ledger.records[0]?.status, "denied");
  } finally {
    await database.close();
  }
});

test("orchestrator keeps executor details out of client-visible evidence", async () => {
  const ledger = new InMemoryAuditLedger();
  const orchestrator = new TrustFlowOrchestrator(
    new PlanGate(),
    ledger,
    [new SqlStepExecutor({ async query() { throw new Error("password=secret host=db.internal"); } })],
  );
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const result = await orchestrator.run({
      planVersion: "1.0",
      query: "고객 목록",
      actor: { id: "tester", role: "analyst" },
      steps: [{ id: "s1", tool: "sql.query", rationale: "test", input: { sql: "SELECT id FROM clients LIMIT 1" } }],
    });
    assert.equal(result.status, "failed");
    assert.equal(ledger.records.length, 2);
    assert.equal(ledger.records[0]?.status, "started");
    assert.equal(ledger.records[1]?.status, "failed");
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /password=secret|db\.internal/u);
    assert.match(serialized, /EXECUTION_FAILED/u);
  } finally {
    console.error = originalConsoleError;
  }
});
