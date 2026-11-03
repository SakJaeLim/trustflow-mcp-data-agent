import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanGate } from '../src/policy/plan-gate.ts';
import { TrustFlowOrchestrator } from '../src/orchestrator.ts';
import { InMemoryAuditLedger, verifyAuditRecords } from '../src/evidence/ledger.ts';
import { SqliteFixture } from '../src/tools/sqlite-fixture.ts';
import { SqlStepExecutor } from '../src/tools/executors.ts';
import type { DecisionKind, QueryPlan, RunResult } from '../src/core/model.ts';

// Independently authored synthetic data; no contest dataset or model.
const scenarios: Array<{ title: string; sql: string; decision: DecisionKind; status: RunResult['status'] }> = [
  { title: 'Bounded client lookup', sql: 'SELECT id, name FROM clients LIMIT 10', decision: 'ALLOW', status: 'executed' },
  { title: 'Unbounded lookup gets a limit', sql: 'SELECT id, name FROM clients', decision: 'REPAIR', status: 'executed' },
  { title: 'Salary access needs approval', sql: 'SELECT name, salary FROM employees LIMIT 10', decision: 'APPROVAL_REQUIRED', status: 'approval_required' },
  { title: 'Destructive statement is blocked', sql: 'DELETE FROM clients', decision: 'DENY', status: 'denied' },
];
const temporary = await mkdtemp(join(tmpdir(), 'trustflow-public-'));
let database: SqliteFixture | undefined;
try {
  const sqlDirectory = join(temporary, 'sql');
  await mkdir(sqlDirectory);
  await writeFile(join(sqlDirectory, '01-schema.sql'), 'CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT, salary INTEGER);');
  await writeFile(join(sqlDirectory, '02-data.sql'), "INSERT INTO clients VALUES (1, 'Synthetic Alpha'), (2, 'Synthetic Beta'); INSERT INTO employees VALUES (1, 'Synthetic Employee', 70000);");
  database = await SqliteFixture.fromDataset(sqlDirectory);
  let queryCalls = 0;
  const runner = { query: async (sql: string, maxRows?: number) => { queryCalls++; return database!.query(sql, maxRows); } };
  const ledger = new InMemoryAuditLedger();
  const orchestrator = new TrustFlowOrchestrator(new PlanGate(), ledger, [new SqlStepExecutor(runner, 'synthetic.sqlite')]);
  const results = [];
  for (const scenario of scenarios) {
    const plan: QueryPlan = {
      planVersion: '1.0', query: scenario.title, actor: { id: 'synthetic-portfolio-user', role: 'analyst' },
      steps: [{ id: 's1', tool: 'sql.query', rationale: 'Public execution demonstration', input: { sql: scenario.sql } }],
    };
    const original = JSON.stringify(plan);
    const callsBefore = queryCalls;
    const result = await orchestrator.run(plan);
    assert.equal(result.policy.decision, scenario.decision, scenario.title);
    assert.equal(result.status, scenario.status, scenario.title);
    assert.equal(JSON.stringify(plan), original, 'Caller plan must not be mutated');
    if (scenario.status === 'executed') {
      assert.equal(queryCalls - callsBefore, 1);
      const payload = result.evidence.find(e => e.kind === 'table')!.payload as { rows: Array<{name: string}>; rowCount: number };
      assert.equal(payload.rowCount, 2);
      assert.deepEqual(payload.rows.map(row => row.name).sort(), ['Synthetic Alpha', 'Synthetic Beta']);
      assert.ok(result.answer);
    } else {
      assert.equal(queryCalls, callsBefore, 'Blocked requests must never reach SQL');
      assert.equal(result.executions.length, 0);
      assert.equal(result.evidence.filter(e => e.kind === 'table').length, 0);
    }
    results.push({ title: scenario.title, decision: result.policy.decision, status: result.status, sqlCalls: queryCalls - callsBefore, evidence: result.evidence, answer: result.answer ?? null });
  }
  assert.equal((await database.query('SELECT COUNT(*) AS n FROM clients')).rows[0].n, 2);
  const auditVerification = verifyAuditRecords(ledger.records);
  assert.equal(auditVerification.valid, true);
  const tampered = structuredClone(ledger.records);
  tampered[0].actor.id = 'tampered-actor';
  assert.equal(verifyAuditRecords(tampered).valid, false, 'Tampering must be detected');
  console.log(JSON.stringify({ scope: 'Synthetic SQL orchestration, policy and audit demo. No LLM, MCP transport, retrieval benchmark or production claim.', passed: true, results, auditVerification, auditRecordCount: ledger.records.length, tamperingDetected: true }, null, 2));
} finally {
  await database?.close();
  await rm(temporary, { recursive: true, force: true });
}
