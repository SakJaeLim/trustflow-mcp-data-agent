import { basename, resolve } from "node:path";
import type { ActorRole } from "./core/model.ts";
import { JsonlAuditLedger } from "./evidence/ledger.ts";
import { TrustFlowOrchestrator } from "./orchestrator.ts";
import { PlanGate } from "./policy/plan-gate.ts";
import { CompanyXPlanner } from "./planner/companyx-planner.ts";
import { OllamaEmbedder } from "./adapters/ollama-embedder.ts";
import { OllamaChatClient } from "./adapters/ollama-chat.ts";
import { PgVectorDocumentSearch } from "./adapters/pgvector-search.ts";
import { PostgresDatabase } from "./adapters/postgres.ts";
import { GraphStepExecutor, SqlStepExecutor, VectorStepExecutor } from "./tools/executors.ts";
import { GraphStore } from "./tools/graph-store.ts";
import { LocalVectorSearch } from "./tools/local-vector-search.ts";
import type { SqlRunner } from "./tools/sqlite-fixture.ts";
import { ApprovalAuthority } from "./security/approval-authority.ts";

export interface TrustFlowRuntime {
  actorRole: ActorRole;
  planner: CompanyXPlanner;
  orchestrator: TrustFlowOrchestrator;
  approvals?: ApprovalAuthority;
  close(): Promise<void>;
}

function actorRole(value: string | undefined): ActorRole {
  return value === "viewer" || value === "hr_analyst" || value === "admin" ? value : "analyst";
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function createRuntime(environment = process.env): Promise<TrustFlowRuntime> {
  const dataDirectory = resolve(environment.COMPANYX_DATA_DIR ?? "data/companyx");
  const auditPath = resolve(environment.POLICYGRAPH_AUDIT_PATH ?? environment.TRUSTFLOW_AUDIT_PATH ?? ".policygraph/audit.jsonl");
  const mode = environment.POLICYGRAPH_RUNTIME ?? environment.TRUSTFLOW_RUNTIME ?? "offline";
  const auditSigningSecret = environment.POLICYGRAPH_AUDIT_SIGNING_SECRET;
  const auditCheckpointPath = environment.POLICYGRAPH_AUDIT_CHECKPOINT_DIR
    ? resolve(environment.POLICYGRAPH_AUDIT_CHECKPOINT_DIR, `${basename(auditPath)}.head.json`)
    : undefined;
  if (!auditSigningSecret || !auditCheckpointPath) {
    throw new Error("PolicyGraph runtime requires POLICYGRAPH_AUDIT_SIGNING_SECRET and POLICYGRAPH_AUDIT_CHECKPOINT_DIR.");
  }
  const graph = await GraphStore.fromDirectory(resolve(dataDirectory, "graph"));
  const llmMode = environment.POLICYGRAPH_LLM_MODE ?? "disabled";
  const approvals = environment.POLICYGRAPH_APPROVAL_SECRET
    ? new ApprovalAuthority(
      environment.POLICYGRAPH_APPROVAL_SECRET,
      resolve(environment.POLICYGRAPH_APPROVAL_REPLAY_DIR ?? ".policygraph/approval-replays"),
    )
    : undefined;
  const ollama = llmMode === "disabled" ? undefined : new OllamaChatClient(
    environment.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    environment.OLLAMA_CHAT_MODEL ?? "gemma4:e2b",
    positiveInteger(environment.OLLAMA_CHAT_TIMEOUT_MS, 300_000),
  );
  let sql: SqlRunner;
  let vector: LocalVectorSearch | PgVectorDocumentSearch;

  if (mode === "postgres") {
    const connectionString = environment.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required when POLICYGRAPH_RUNTIME=postgres.");
    const database = new PostgresDatabase(connectionString);
    sql = database;
    if ((environment.VECTOR_MODE ?? "pgvector") === "pgvector") {
      vector = new PgVectorDocumentSearch(
        database,
        new OllamaEmbedder(
          environment.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
          environment.OLLAMA_EMBED_MODEL ?? "nomic-embed-text",
        ),
      );
    } else {
      vector = await LocalVectorSearch.fromDirectory(resolve(dataDirectory, "documents"));
    }
  } else {
    const { SqliteFixture } = await import("./tools/sqlite-fixture.ts");
    sql = await SqliteFixture.fromDataset(resolve(dataDirectory, "sql"));
    vector = await LocalVectorSearch.fromDirectory(resolve(dataDirectory, "documents"));
  }

  const orchestrator = new TrustFlowOrchestrator(
    new PlanGate(),
    new JsonlAuditLedger(auditPath, auditSigningSecret, auditCheckpointPath),
    [
    new SqlStepExecutor(sql, mode === "postgres" ? "sql://companyx/postgresql" : "sql://companyx/sqlite-fixture"),
    new VectorStepExecutor(
      vector,
      vector instanceof PgVectorDocumentSearch
        ? "pgvector+nomic-embed-text"
        : "local-vector-baseline",
    ),
    new GraphStepExecutor(graph),
    ],
    ollama ? (question, evidence) => ollama.composeAnswer(question, evidence) : undefined,
    approvals,
  );

  return {
    actorRole: actorRole(environment.POLICYGRAPH_ACTOR_ROLE ?? environment.TRUSTFLOW_ACTOR_ROLE),
    planner: new CompanyXPlanner(ollama),
    orchestrator,
    approvals,
    async close(): Promise<void> {
      if (sql.close) await sql.close();
    },
  };
}
