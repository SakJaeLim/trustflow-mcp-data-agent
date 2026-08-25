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
import { FailoverDocumentSearch, LocalVectorSearch, type DocumentSearch } from "./tools/local-vector-search.ts";
import type { SqlRunner } from "./tools/sqlite-fixture.ts";
import { ApprovalAuthority } from "./security/approval-authority.ts";
import { loadVerifiedCompanyXQuestions, verifyCompanyXDataDirectory, type CompanyXQuestion } from "./core/companyx-integrity.ts";
import { loadVerifiedDocumentCorpus } from "./core/document-corpus.ts";
import { AttestedPostgresSqlRunner, loadEmbeddingAttestation, verifyPostgresCompanyX } from "./core/postgres-integrity.ts";

export interface TrustFlowRuntime {
  actorRole: ActorRole;
  planner: CompanyXPlanner;
  orchestrator: TrustFlowOrchestrator;
  approvals?: ApprovalAuthority;
  officialQuestions: readonly CompanyXQuestion[];
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
  const integrity = await verifyCompanyXDataDirectory(dataDirectory, environment.COMPANYX_ARCHIVE_PATH);
  const corpus = loadVerifiedDocumentCorpus(integrity);
  const officialQuestions = loadVerifiedCompanyXQuestions(integrity);
  const auditPath = resolve(environment.POLICYGRAPH_AUDIT_PATH ?? environment.TRUSTFLOW_AUDIT_PATH ?? ".policygraph/audit.jsonl");
  const mode = environment.POLICYGRAPH_RUNTIME ?? environment.TRUSTFLOW_RUNTIME ?? "offline";
  const auditSigningSecret = environment.POLICYGRAPH_AUDIT_SIGNING_SECRET;
  const auditCheckpointPath = environment.POLICYGRAPH_AUDIT_CHECKPOINT_DIR
    ? resolve(environment.POLICYGRAPH_AUDIT_CHECKPOINT_DIR, `${basename(auditPath)}.head.json`)
    : undefined;
  if (!auditSigningSecret || !auditCheckpointPath) {
    throw new Error("PolicyGraph runtime requires POLICYGRAPH_AUDIT_SIGNING_SECRET and POLICYGRAPH_AUDIT_CHECKPOINT_DIR.");
  }
  const graph = GraphStore.fromIntegrity(integrity);
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
    positiveInteger(environment.OLLAMA_CHAT_TIMEOUT_MS, 600_000),
  );
  let sql: SqlRunner;
  let sqlDatasetStateSha256: string | undefined;
  let vector: DocumentSearch;

  if (mode === "postgres") {
    const connectionString = environment.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required when POLICYGRAPH_RUNTIME=postgres.");
    const database = new PostgresDatabase(connectionString);
    const vectorMode = environment.VECTOR_MODE ?? "pgvector";
    const embedModel = environment.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
    const embedder = vectorMode === "pgvector" ? new OllamaEmbedder(
      environment.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
      embedModel,
    ) : undefined;
    const embeddingAttestation = embedder
      ? await loadEmbeddingAttestation(
        resolve(environment.POLICYGRAPH_EMBEDDING_ATTESTATION_PATH ?? "evaluation/embedding-attestation.json"),
        integrity,
        corpus,
        embedModel,
      )
      : undefined;
    let databaseIntegrity;
    try {
      databaseIntegrity = await database.withReadTransaction((transaction) => verifyPostgresCompanyX(
        transaction,
        integrity,
        corpus,
        vectorMode === "pgvector",
        embeddingAttestation,
      ));
      sqlDatasetStateSha256 = databaseIntegrity.businessTablesSha256;
    } catch (error) {
      await database.close();
      throw error;
    }
    sql = new AttestedPostgresSqlRunner(database, integrity, corpus, databaseIntegrity.businessTablesSha256);
    if (vectorMode === "pgvector") {
      if (!embedder || !embeddingAttestation || !databaseIntegrity.vectorStateSha256) {
        await database.close();
        throw new Error("pgvector runtime attestation is incomplete.");
      }
      const expectedVectorStateSha256 = databaseIntegrity.vectorStateSha256;
      const primaryVector = new PgVectorDocumentSearch(
        database,
        embedder,
        integrity.datasetSha256,
        corpus,
        async (transaction) => {
          const current = await verifyPostgresCompanyX(transaction, integrity, corpus, true, embeddingAttestation);
          if (current.businessTablesSha256 !== databaseIntegrity.businessTablesSha256
            || current.vectorStateSha256 !== expectedVectorStateSha256
            || current.embeddingsSha256 !== embeddingAttestation.embeddingsSha256) {
            throw new Error("PostgreSQL vector or business state changed after runtime attestation.");
          }
        },
      );
      vector = new FailoverDocumentSearch(
        primaryVector,
        LocalVectorSearch.fromVerifiedCorpus(corpus, integrity.datasetSha256),
      );
    } else {
      vector = LocalVectorSearch.fromVerifiedCorpus(corpus, integrity.datasetSha256);
    }
  } else {
    const { SqliteFixture } = await import("./tools/sqlite-fixture.ts");
    sql = SqliteFixture.fromIntegrity(integrity);
    vector = LocalVectorSearch.fromVerifiedCorpus(corpus, integrity.datasetSha256);
  }

  const orchestrator = new TrustFlowOrchestrator(
    new PlanGate(),
    new JsonlAuditLedger(auditPath, auditSigningSecret, auditCheckpointPath),
    [
    new SqlStepExecutor(
      sql,
      mode === "postgres" ? "sql://companyx/postgresql" : "sql://companyx/sqlite-fixture",
      integrity.datasetSha256,
      sqlDatasetStateSha256,
    ),
    new VectorStepExecutor(
      vector,
      mode === "postgres" && (environment.VECTOR_MODE ?? "pgvector") === "pgvector"
        ? "pgvector+nomic-embed-text"
        : "local-vector-baseline",
    ),
    new GraphStepExecutor(graph, "kg://companyx", integrity.datasetSha256),
    ],
    ollama ? (question, evidence) => ollama.composeAnswer(question, evidence) : undefined,
    approvals,
  );

  return {
    actorRole: actorRole(environment.POLICYGRAPH_ACTOR_ROLE ?? environment.TRUSTFLOW_ACTOR_ROLE),
    planner: new CompanyXPlanner(ollama),
    orchestrator,
    approvals,
    officialQuestions,
    async close(): Promise<void> {
      if (sql.close) await sql.close();
    },
  };
}
