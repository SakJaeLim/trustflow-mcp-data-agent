import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { OllamaEmbedder } from "../src/adapters/ollama-embedder.ts";
import { PgVectorDocumentSearch } from "../src/adapters/pgvector-search.ts";
import { PostgresDatabase } from "../src/adapters/postgres.ts";

interface RelevanceQuestion {
  question: string;
  relevantDocIds: string[];
  rationale: string;
  evidence: string[];
}

interface RelevanceFixture {
  schemaVersion: string;
  labelingMethod: string;
  limitations: string;
  questions: RelevanceQuestion[];
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required. Run npm run setup:local first.");

const fixture = JSON.parse(
  await readFile(resolve("evaluation/vector-relevance.json"), "utf8"),
) as RelevanceFixture;
const outputDirectory = resolve("artifacts/evaluation");
await mkdir(outputDirectory, { recursive: true });

const database = new PostgresDatabase(connectionString, 30_000);
const embedModel = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
const embedder = new OllamaEmbedder(process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434", embedModel);
const search = new PgVectorDocumentSearch(database, embedder);

try {
  const corpusRows = await database.queryRows<{ documents: string; chunks: string; embedded_chunks: string }>(
    `SELECT COUNT(DISTINCT doc_id)::text AS documents,
            COUNT(*)::text AS chunks,
            COUNT(embedding)::text AS embedded_chunks
       FROM document_chunks`,
  );
  const corpus = corpusRows[0] ?? { documents: "0", chunks: "0", embedded_chunks: "0" };
  const warmupStarted = performance.now();
  await embedder.embed(["search_query: retrieval evaluation warmup"]);
  const coldStartWarmupMs = performance.now() - warmupStarted;
  const results = [];
  const latencies: number[] = [];

  for (const item of fixture.questions) {
    const started = performance.now();
    const hits = await search.search(item.question, 10);
    const latencyMs = performance.now() - started;
    latencies.push(latencyMs);
    const ranking = hits.map((hit) => hit.id);
    const relevant = new Set(item.relevantDocIds);
    const firstRelevantIndex = ranking.findIndex((id) => relevant.has(id));
    const recallAt = (cutoff: number): number => {
      const retrievedRelevant = new Set(ranking.slice(0, cutoff).filter((id) => relevant.has(id)));
      return retrievedRelevant.size / relevant.size;
    };
    const hitAt = (cutoff: number): number => ranking.slice(0, cutoff).some((id) => relevant.has(id)) ? 1 : 0;
    results.push({
      question: item.question,
      relevantDocIds: item.relevantDocIds,
      rationale: item.rationale,
      labelEvidence: item.evidence,
      ranking: hits.map((hit, index) => ({ rank: index + 1, docId: hit.id, title: hit.title, score: round(hit.score, 6) })),
      reciprocalRank: firstRelevantIndex < 0 ? 0 : round(1 / (firstRelevantIndex + 1)),
      hitAt1: hitAt(1),
      hitAt3: hitAt(3),
      hitAt5: hitAt(5),
      recallAt1: round(recallAt(1)),
      recallAt3: round(recallAt(3)),
      recallAt5: round(recallAt(5)),
      latencyMs: round(latencyMs, 2),
    });
  }

  const metrics = {
    labeledQuestionCount: results.length,
    hitAt1: round(mean(results.map((item) => item.hitAt1))),
    hitAt3: round(mean(results.map((item) => item.hitAt3))),
    hitAt5: round(mean(results.map((item) => item.hitAt5))),
    meanRecallAt1: round(mean(results.map((item) => item.recallAt1))),
    meanRecallAt3: round(mean(results.map((item) => item.recallAt3))),
    meanRecallAt5: round(mean(results.map((item) => item.recallAt5))),
    mrrAt10: round(mean(results.map((item) => item.reciprocalRank))),
    coldStartWarmupMs: round(coldStartWarmupMs, 2),
    p50LatencyMs: round(percentile(latencies, 0.5), 2),
    p95LatencyMs: round(percentile(latencies, 0.95), 2),
  };
  const report = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    evaluator: "manual-public-fixture-labels",
    limitations: fixture.limitations,
    embedding: { provider: "ollama", model: embedModel },
    corpus: {
      documents: Number(corpus.documents),
      chunks: Number(corpus.chunks),
      embeddedChunks: Number(corpus.embedded_chunks),
    },
    metrics,
    questions: results,
  };
  await writeFile(resolve(outputDirectory, "pgvector-results.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const summary = `# pgvector retrieval evaluation\n\n- Labeled official vector questions: ${metrics.labeledQuestionCount}\n- Corpus: ${report.corpus.documents} documents / ${report.corpus.embeddedChunks} embedded chunks\n- Embedding model: Ollama ${embedModel}\n- Hit@1 / @3 / @5: ${(metrics.hitAt1 * 100).toFixed(1)}% / ${(metrics.hitAt3 * 100).toFixed(1)}% / ${(metrics.hitAt5 * 100).toFixed(1)}%\n- Mean Recall@1 / @3 / @5: ${(metrics.meanRecallAt1 * 100).toFixed(1)}% / ${(metrics.meanRecallAt3 * 100).toFixed(1)}% / ${(metrics.meanRecallAt5 * 100).toFixed(1)}%\n- MRR@10: ${metrics.mrrAt10.toFixed(4)}\n- Cold-start warmup: ${metrics.coldStartWarmupMs.toFixed(2)} ms\n- Warm P50 / P95 query latency: ${metrics.p50LatencyMs.toFixed(2)} ms / ${metrics.p95LatencyMs.toFixed(2)} ms\n\nLabels were manually derived from the 40 official Markdown documents and retain source-line evidence in \`evaluation/vector-relevance.json\`. This is a public-fixture retrieval result, not a hidden-test or production claim.\n`;
  await writeFile(resolve(outputDirectory, "PGVECTOR_SUMMARY.md"), summary, "utf8");
  console.log(JSON.stringify({ corpus: report.corpus, metrics }, null, 2));
} finally {
  await database.close();
}
