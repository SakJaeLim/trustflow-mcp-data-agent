import test from "node:test";
import assert from "node:assert/strict";
import type { QueryPlan } from "../src/core/model.ts";
import { PlanGate } from "../src/policy/plan-gate.ts";

const gate = new PlanGate();

function sqlPlan(sql: string, role: QueryPlan["actor"]["role"] = "analyst"): QueryPlan {
  return {
    planVersion: "1.0",
    query: "test",
    actor: { id: "tester", role },
    steps: [{ id: "s1", tool: "sql.query", rationale: "test", input: { sql } }],
  };
}

test("PlanGate repairs a SELECT without LIMIT", () => {
  const result = gate.evaluate(sqlPlan("SELECT id, name FROM clients"));
  assert.equal(result.decision, "REPAIR");
  const repaired = result.executablePlan?.steps[0];
  assert.match(repaired?.tool === "sql.query" ? repaired.input.sql : "", /LIMIT 100$/);
  assert.deepEqual(result.repairs.map((item) => item.code), ["SQL_LIMIT_ADDED"]);
});

test("PlanGate denies write SQL", () => {
  const result = gate.evaluate(sqlPlan("DELETE FROM clients"));
  assert.equal(result.decision, "DENY");
  assert.equal(result.executablePlan, undefined);
  assert.ok(result.findings.some((item) => item.code === "SQL_AST_NOT_READ_ONLY"));
});

test("PlanGate denies destructive original intent even when the model sanitizes the SQL step", () => {
  const plan = sqlPlan("SELECT id FROM clients LIMIT 10");
  plan.query = "SELECT id FROM clients; DELETE FROM clients 를 실행해";
  const result = gate.evaluate(plan);
  assert.equal(result.decision, "DENY");
  assert.ok(result.findings.some((item) => item.code === "QUERY_UNSAFE_INTENT"));
  assert.ok(result.policyGraph.matchedPolicyIds.includes("POL-PLAN-002"));
});

test("PlanGate uses the PostgreSQL AST for CTEs, functions, locks, and wildcard projections", () => {
  const readOnlyCte = gate.evaluate(sqlPlan("WITH active_clients AS (SELECT id, name FROM clients WHERE is_active = true) SELECT id, name FROM active_clients LIMIT 10"));
  assert.equal(readOnlyCte.decision, "ALLOW");
  const chainedCte = gate.evaluate(sqlPlan("WITH a AS (SELECT id FROM clients), b AS (SELECT id FROM a) SELECT id FROM b LIMIT 10"));
  assert.equal(chainedCte.decision, "ALLOW");

  for (const table of ["pg_settings", "pg_roles", "secrets"]) {
    const shadowed = gate.evaluate(sqlPlan(`WITH ${table} AS (SELECT name FROM ${table}) SELECT name FROM ${table} LIMIT 10`));
    assert.equal(shadowed.decision, "DENY");
    assert.ok(shadowed.findings.some((item) => item.code === "SQL_UNKNOWN_TABLE"));
  }

  const writeCte = gate.evaluate(sqlPlan("WITH changed AS (DELETE FROM clients RETURNING id) SELECT id FROM changed LIMIT 10"));
  assert.equal(writeCte.decision, "DENY");
  assert.ok(writeCte.findings.some((item) => item.code === "SQL_AST_NOT_READ_ONLY"));

  const unsafeFunction = gate.evaluate(sqlPlan("SELECT pg_sleep(1) FROM clients LIMIT 1"));
  assert.equal(unsafeFunction.decision, "DENY");
  assert.ok(unsafeFunction.findings.some((item) => item.code === "SQL_FUNCTION_NOT_ALLOWED"));

  const rowLock = gate.evaluate(sqlPlan("SELECT id FROM clients LIMIT 1 FOR UPDATE"));
  assert.equal(rowLock.decision, "DENY");
  assert.ok(rowLock.findings.some((item) => item.code === "SQL_ROW_LOCK_BLOCKED"));

  assert.equal(gate.evaluate(sqlPlan("SELECT * FROM clients LIMIT 1")).decision, "DENY");
  const wholeRow = gate.evaluate(sqlPlan("SELECT e FROM employees e LIMIT 1", "viewer"));
  assert.equal(wholeRow.decision, "DENY");
  assert.ok(wholeRow.findings.some((item) => item.code === "SQL_WHOLE_ROW_PROJECTION"));
  assert.equal(gate.evaluate(sqlPlan("SELECT employees FROM employees LIMIT 1", "viewer")).decision, "DENY");
  assert.equal(gate.evaluate(sqlPlan("SELECT ARRAY[e] AS records FROM employees e LIMIT 1", "viewer")).decision, "DENY");
  assert.equal(gate.evaluate(sqlPlan("SELECT COALESCE(e, e) AS record FROM employees e LIMIT 1", "viewer")).decision, "DENY");
  assert.equal(gate.evaluate(sqlPlan("SELECT e::text AS record FROM employees e LIMIT 1", "viewer")).decision, "DENY");
  assert.equal(gate.evaluate(sqlPlan("SELECT (e.*)::text AS record FROM employees e LIMIT 1", "viewer")).decision, "DENY");
  assert.equal(gate.evaluate(sqlPlan("SELECT (e.*, 0) AS record FROM employees e LIMIT 1", "viewer")).decision, "DENY");
  assert.equal(gate.evaluate(sqlPlan("SELECT CASE WHEN true THEN e ELSE e END AS record FROM employees e LIMIT 1", "viewer")).decision, "DENY");
  assert.equal(gate.evaluate(sqlPlan("WITH x AS (SELECT e FROM employees e) SELECT x FROM x LIMIT 1", "viewer")).decision, "DENY");
  assert.equal(gate.evaluate(sqlPlan("SELECT e.name FROM employees e WHERE e::text LIKE '%50000000%' LIMIT 10", "viewer")).decision, "DENY");
  assert.equal(gate.evaluate(sqlPlan("SELECT xmin FROM employees LIMIT 10")).decision, "DENY");
  assert.equal(gate.evaluate(sqlPlan("SELECT current_user AS db_role LIMIT 10")).decision, "DENY");
  assert.notEqual(gate.evaluate(sqlPlan("SELECT COUNT(*) AS count FROM clients LIMIT 1")).decision, "DENY");
  assert.notEqual(gate.evaluate(sqlPlan("SELECT id FROM clients WHERE name = 'DELETE' LIMIT 1")).decision, "DENY");

  const aliasedSensitive = gate.evaluate(sqlPlan(
    "SELECT e.safe_email, e.safe_salary FROM employees AS e(id, name, safe_email, position, dept_id, hire_date, safe_salary) LIMIT 100",
    "viewer",
  ));
  assert.equal(aliasedSensitive.decision, "DENY");
  assert.ok(aliasedSensitive.findings.some((item) => item.code === "SQL_TABLE_COLUMN_ALIAS_BLOCKED"));

  const usingSensitive = gate.evaluate(sqlPlan(
    "SELECT e.id FROM employees e JOIN (VALUES (5000)) probe(salary) USING (salary) LIMIT 100",
    "viewer",
  ));
  assert.equal(usingSensitive.decision, "DENY");
  assert.ok(usingSensitive.findings.some((item) => item.code === "SQL_JOIN_USING_BLOCKED"));

  const documentBypass = gate.evaluate(sqlPlan("SELECT doc_id, content, metadata, embedding FROM document_chunks LIMIT 100"));
  assert.equal(documentBypass.decision, "DENY");
  assert.ok(documentBypass.findings.some((item) => item.code === "SQL_UNKNOWN_TABLE"));
  const shadowedDocumentBypass = gate.evaluate(sqlPlan(
    "WITH document_chunks AS (SELECT id FROM sales LIMIT 1) SELECT content AS content FROM public.document_chunks LIMIT 1",
  ));
  assert.equal(shadowedDocumentBypass.decision, "DENY");
  assert.ok(shadowedDocumentBypass.findings.some((item) => item.code === "SQL_UNKNOWN_TABLE"));
  const quotedCteAliasBypass = gate.evaluate(sqlPlan(
    'WITH "DOCUMENT_CHUNKS" AS (SELECT doc_id, content FROM document_chunks) SELECT content AS safe FROM "DOCUMENT_CHUNKS" WHERE safe IS NOT NULL LIMIT 1',
  ));
  assert.equal(quotedCteAliasBypass.decision, "DENY");
  assert.ok(quotedCteAliasBypass.findings.some((item) => item.code === "SQL_UNKNOWN_TABLE"));
  assert.ok(quotedCteAliasBypass.findings.some((item) => item.code === "SQL_UNKNOWN_COLUMN"));

  const tautologicalJoin = gate.evaluate(sqlPlan(
    "SELECT c.name, s.amount FROM clients c JOIN sales s ON c.id = c.id AND s.id = s.id LIMIT 5",
  ));
  assert.equal(tautologicalJoin.decision, "DENY");
  assert.ok(tautologicalJoin.findings.some((item) => item.code === "SQL_COMPLEXITY_BUDGET_EXCEEDED"));

  const oversizedSql = gate.evaluate(sqlPlan(`SELECT id FROM clients WHERE name = '${"a".repeat(16_384)}' LIMIT 1`));
  assert.equal(oversizedSql.decision, "DENY");
  assert.ok(oversizedSql.findings.some((item) => item.code === "SQL_COMPLEXITY_BUDGET_EXCEEDED"));

  const expensive = gate.evaluate(sqlPlan(
    "SELECT COUNT(*) AS n FROM sales a CROSS JOIN sales b CROSS JOIN sales c CROSS JOIN sales d LIMIT 1",
  ));
  assert.equal(expensive.decision, "DENY");
  assert.ok(expensive.findings.some((item) => item.code === "SQL_COMPLEXITY_BUDGET_EXCEEDED"));
  const repeatedCte = gate.evaluate(sqlPlan(
    "WITH x AS (SELECT id FROM sales) SELECT COUNT(*) AS n FROM x a JOIN x b ON TRUE JOIN x c ON TRUE LIMIT 1",
  ));
  assert.equal(repeatedCte.decision, "DENY");
  assert.ok(repeatedCte.findings.some((item) => item.code === "SQL_COMPLEXITY_BUDGET_EXCEEDED"));
  const nestedRecursive = gate.evaluate(sqlPlan(
    "SELECT COUNT(*) AS count FROM (WITH RECURSIVE sales(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM sales) SELECT id FROM sales) nested LIMIT 1",
  ));
  assert.equal(nestedRecursive.decision, "DENY");
  const derivedFanout = gate.evaluate(sqlPlan(
    "SELECT COUNT(*) AS count FROM (VALUES (1),(2)) a(id) JOIN (VALUES (1),(2)) b(id) ON 1=1 JOIN (VALUES (1),(2)) c(id) ON 1=1 JOIN (VALUES (1),(2)) d(id) ON 1=1 LIMIT 1",
  ));
  assert.equal(derivedFanout.decision, "DENY");
  assert.notEqual(gate.evaluate(sqlPlan(
    "SELECT c.name, SUM(s.amount) AS total_sales FROM sales s JOIN clients c ON c.id = s.client_id GROUP BY c.id, c.name ORDER BY total_sales DESC LIMIT 5",
  )).decision, "DENY");
});

test("PlanGate requires approval for sensitive fields", () => {
  const result = gate.evaluate(sqlPlan("SELECT name, salary FROM employees LIMIT 10"));
  assert.equal(result.decision, "APPROVAL_REQUIRED");
  assert.equal(result.approvalReasons.length, 1);
});

test("PlanGate denies sensitive fields to a viewer", () => {
  const result = gate.evaluate(sqlPlan("SELECT name, salary FROM employees LIMIT 10", "viewer"));
  assert.equal(result.decision, "DENY");
  assert.ok(result.findings.some((item) => item.code === "SQL_SENSITIVE_FIELD_DENIED"));
  assert.ok(result.policyGraph.matchedPolicyIds.includes("POL-SQL-005"));
});

test("PlanGate allows HR to read salary within a bounded query", () => {
  const result = gate.evaluate(sqlPlan("SELECT name, salary FROM employees LIMIT 10", "hr_analyst"));
  assert.equal(result.decision, "ALLOW");
});

test("PlanGate clamps vector and graph budgets", () => {
  const plan: QueryPlan = {
    planVersion: "1.0",
    query: "test",
    actor: { id: "tester", role: "analyst" },
    steps: [
      { id: "v1", tool: "vector.search", rationale: "test", input: { query: "장애", topK: 999 } },
      {
        id: "g1",
        tool: "graph.traverse",
        rationale: "test",
        input: {
          startName: "Client-A",
          path: [
            { relation: "USES", direction: "out" },
            { relation: "HAS_PROJECT", direction: "out" },
            { relation: "LEADS", direction: "in" },
          ],
          maxHops: 3,
          maxNodes: 500,
        },
      },
    ],
  };
  const result = gate.evaluate(plan);
  assert.equal(result.decision, "REPAIR");
  const vector = result.executablePlan?.steps[0];
  const graph = result.executablePlan?.steps[1];
  assert.equal(vector?.tool === "vector.search" ? vector.input.topK : undefined, 10);
  assert.equal(graph?.tool === "graph.traverse" ? graph.input.path.length : undefined, 2);
  assert.equal(graph?.tool === "graph.traverse" ? graph.input.maxNodes : undefined, 50);
  assert.ok(result.policyGraph.matchedPolicyIds.includes("POL-VEC-001"));
  assert.ok(result.policyGraph.matchedPolicyIds.includes("POL-GRAPH-002"));

  const oversized = structuredClone(plan);
  oversized.query = "가".repeat(2_000);
  if (oversized.steps[0]?.tool === "vector.search") oversized.steps[0].input.query = oversized.query;
  const denied = gate.evaluate(oversized);
  assert.equal(denied.decision, "DENY");
  assert.ok(denied.findings.some((item) => item.code === "QUERY_SIZE_EXCEEDED"));
  assert.ok(denied.findings.some((item) => item.code === "VECTOR_QUERY_SIZE_EXCEEDED"));
});
