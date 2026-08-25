import test from "node:test";
import assert from "node:assert/strict";
import type { QueryPlan } from "../src/core/model.ts";
import { InMemoryAuditLedger } from "../src/evidence/ledger.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrustFlowOrchestrator } from "../src/orchestrator.ts";
import { PlanGate } from "../src/policy/plan-gate.ts";
import { ApprovalAuthority } from "../src/security/approval-authority.ts";
import { SqlStepExecutor } from "../src/tools/executors.ts";

function sensitivePlan(actorId = "analyst-1"): QueryPlan {
  return {
    planVersion: "1.0",
    query: "직원 연봉",
    actor: { id: actorId, role: "analyst" },
    steps: [{ id: "s1", tool: "sql.query", rationale: "test", input: { sql: "SELECT name, salary FROM employees LIMIT 10" } }],
  };
}

function setup() {
  const authority = new ApprovalAuthority("test-only-approval-secret-at-least-32-bytes");
  const ledger = new InMemoryAuditLedger();
  const runner = { async query() { return { rows: [{ name: "tester", salary: 1 }], rowCount: 1 }; } };
  const orchestrator = new TrustFlowOrchestrator(
    new PlanGate(),
    ledger,
    [new SqlStepExecutor(runner)],
    undefined,
    authority,
  );
  return { authority, ledger, orchestrator };
}

test("only a short-lived plan-bound signed receipt can approve sensitive execution", async () => {
  const { authority, ledger, orchestrator } = setup();
  const plan = sensitivePlan();

  assert.equal((await orchestrator.run(plan)).status, "approval_required");
  assert.equal((await orchestrator.run(plan, { approvedBy: "self" } as never)).status, "approval_required");
  assert.equal((await orchestrator.run(plan, { approvalReceipt: "forged.payload" })).status, "approval_required");
  assert.deepEqual(await authority.consume("x".repeat(4_097), plan), { valid: false, reason: "malformed" });

  const wrongPlanReceipt = authority.issue(plan, "security-admin");
  assert.equal((await orchestrator.run(sensitivePlan("different-actor"), { approvalReceipt: wrongPlanReceipt })).status, "approval_required");

  const receipt = authority.issue(plan, "security-admin");
  const approved = await orchestrator.run(plan, { approvalReceipt: receipt });
  assert.equal(approved.status, "executed");
  assert.equal(ledger.records.at(-1)?.approvedBy, "security-admin");
  assert.ok(ledger.records.at(-1)?.approvalId);

  const replay = await orchestrator.run(plan, { approvalReceipt: receipt });
  assert.equal(replay.status, "approval_required");
});

test("approval secrets shorter than 32 bytes are rejected", () => {
  assert.throws(() => new ApprovalAuthority("too-short"), /at least 32 bytes/);
});

test("approval replay protection survives authority restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "policygraph-approval-"));
  const secret = "test-only-persistent-approval-secret-32-bytes";
  const plan = sensitivePlan();
  try {
    const issuer = new ApprovalAuthority(secret, directory);
    const receipt = issuer.issue(plan, "security-admin");
    assert.equal((await issuer.consume(receipt, plan)).valid, true);
    const restarted = new ApprovalAuthority(secret, directory);
    assert.equal((await restarted.consume(receipt, plan)).reason, "replayed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
