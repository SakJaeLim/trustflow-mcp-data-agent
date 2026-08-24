import { resolve } from "node:path";
import { createRuntime } from "../src/runtime.ts";
import { PostgresDatabase } from "../src/adapters/postgres.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required. Run npm run setup:local first.");

const runtime = await createRuntime({
  ...process.env,
  DATABASE_URL: connectionString,
  POLICYGRAPH_RUNTIME: "postgres",
  VECTOR_MODE: process.env.VECTOR_MODE ?? "pgvector",
  POLICYGRAPH_ACTOR_ROLE: "admin",
  POLICYGRAPH_AUDIT_PATH: process.env.POLICYGRAPH_AUDIT_PATH ?? resolve(".policygraph/postgres-smoke-audit.jsonl"),
});

try {
  const permissionProbe = new PostgresDatabase(connectionString);
  let writeBlocked = false;
  try {
    await permissionProbe.write("UPDATE clients SET name = name WHERE FALSE");
  } catch {
    writeBlocked = true;
  } finally {
    await permissionProbe.close();
  }
  if (!writeBlocked) throw new Error("Read-only database role unexpectedly accepted UPDATE.");

  const questions = [
    "2025년 3분기 총 매출액은 얼마야?",
    "Product-C1 설치 방법이 궁금해",
    "Client-A가 사용 중인 제품 목록은?",
  ];
  const results = [];
  for (const question of questions) {
    const result = await runtime.orchestrator.run(runtime.planner.buildPlan(question, { id: "postgres-smoke", role: "admin" }));
    if (result.status !== "executed" || result.answer?.verified !== true) {
      throw new Error(`PostgreSQL smoke test failed for ${question}: status=${result.status}`);
    }
    results.push({
      question,
      decision: result.policy.decision,
      sources: result.evidence.filter((item) => item.kind !== "policy").map((item) => item.source),
    });
    if ((process.env.VECTOR_MODE ?? "pgvector") === "pgvector" && question.includes("Product-C1")) {
      const firstSource = result.evidence.find((item) => item.kind === "passage")?.source;
      if (firstSource !== "doc://companyx/DOC-011") {
        throw new Error(`pgvector hybrid ranking expected DOC-011 first but received ${firstSource}`);
      }
    }
  }
  console.log(JSON.stringify({
    status: "ok",
    runtime: "postgres",
    vectorMode: process.env.VECTOR_MODE ?? "pgvector",
    readOnlyRoleVerified: true,
    results,
  }, null, 2));
} finally {
  await runtime.close();
}
