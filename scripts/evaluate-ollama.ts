import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { OllamaChatClient } from "../src/adapters/ollama-chat.ts";
import type { EvidenceItem, QueryPlan, RunResult, ToolName } from "../src/core/model.ts";
import { CompanyXPlanner } from "../src/planner/companyx-planner.ts";
import { createRuntime } from "../src/runtime.ts";

interface ParaphraseCase {
  id: string;
  canonical: string;
  expectedTool: ToolName;
  requiredKeys?: string[];
  paraphrases: string[];
}

interface ParaphraseFixture {
  cases: ParaphraseCase[];
}

interface RelevanceFixture {
  questions: Array<{ question: string; relevantDocIds: string[] }>;
}

interface PlannedResult {
  id: string;
  variant: number;
  canonical: string;
  question: string;
  expectedTool: ToolName;
  draftTool?: ToolName;
  actualTool?: ToolName;
  normalization?: string;
  canonicalMatch?: string;
  plan?: QueryPlan;
  planValid: boolean;
  toolCorrect: boolean;
  policyDecision?: string;
  status?: string;
  semanticCorrect: boolean;
  latencyMs: number;
  error?: string;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function evidenceOfKind(result: RunResult, kind: EvidenceItem["kind"]): EvidenceItem | undefined {
  return result.evidence.find((item) => item.kind === kind);
}

function normalizeValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return String(round(value, 8));
  return JSON.stringify(value) ?? String(value);
}

function tableSemantics(item: ParaphraseCase, expected: RunResult, actual: RunResult): boolean {
  const expectedPayload = evidenceOfKind(expected, "table")?.payload as { rows?: Record<string, unknown>[] } | undefined;
  const actualPayload = evidenceOfKind(actual, "table")?.payload as { rows?: Record<string, unknown>[] } | undefined;
  const expectedRows = expectedPayload?.rows ?? [];
  const actualRows = actualPayload?.rows ?? [];
  const keys = item.requiredKeys ?? [];
  if (keys.length === 0 || expectedRows.length !== actualRows.length) return false;
  const unmatched = [...actualRows];
  for (const expectedRow of expectedRows) {
    const requiredValues = keys.map((key) => normalizeValue(expectedRow[key]));
    const matchIndex = unmatched.findIndex((actualRow) => {
      const values = Object.values(actualRow).map(normalizeValue);
      return requiredValues.every((value) => values.includes(value));
    });
    if (matchIndex < 0) return false;
    unmatched.splice(matchIndex, 1);
  }
  return true;
}

function graphSemantics(expected: RunResult, actual: RunResult): boolean {
  type GraphPayload = {
    resultNodes?: Array<{ id?: string }>;
    ranking?: Array<{ node?: { id?: string }; count?: number }>;
  };
  const expectedPayload = evidenceOfKind(expected, "graph_path")?.payload as GraphPayload | undefined;
  const actualPayload = evidenceOfKind(actual, "graph_path")?.payload as GraphPayload | undefined;
  if (!expectedPayload || !actualPayload) return false;
  if (expectedPayload.ranking?.length) {
    const expectedTop = expectedPayload.ranking[0];
    const actualTop = actualPayload.ranking?.[0];
    return expectedTop?.node?.id === actualTop?.node?.id && expectedTop?.count === actualTop?.count;
  }
  const expectedIds = [...new Set((expectedPayload.resultNodes ?? []).map((node) => node.id).filter(Boolean))].sort();
  const actualIds = [...new Set((actualPayload.resultNodes ?? []).map((node) => node.id).filter(Boolean))].sort();
  return JSON.stringify(expectedIds) === JSON.stringify(actualIds);
}

function vectorSemantics(canonical: string, actual: RunResult, relevantByQuestion: Map<string, Set<string>>): boolean {
  const relevant = relevantByQuestion.get(canonical);
  if (!relevant) return false;
  return actual.evidence.some((item) => item.kind === "passage" && relevant.has(item.source.split("/").at(-1) ?? ""));
}

function semanticCorrect(
  item: ParaphraseCase,
  expected: RunResult,
  actual: RunResult,
  relevantByQuestion: Map<string, Set<string>>,
): boolean {
  if (actual.status !== "executed") return false;
  if (item.expectedTool === "sql.query") return tableSemantics(item, expected, actual);
  if (item.expectedTool === "graph.traverse") return graphSemantics(expected, actual);
  return vectorSemantics(item.canonical, actual, relevantByQuestion);
}

function calculateMetrics(results: PlannedResult[]) {
  const count = results.length;
  const rate = (predicate: (item: PlannedResult) => boolean): number => count === 0 ? 0 : results.filter(predicate).length / count;
  const latencies = results.map((item) => item.latencyMs);
  return {
    evaluatedCount: count,
    planSchemaSuccessRate: round(rate((item) => item.planValid)),
    rawToolAccuracy: round(rate((item) => item.draftTool === item.expectedTool)),
    toolAccuracy: round(rate((item) => item.toolCorrect)),
    policyAcceptanceRate: round(rate((item) => item.policyDecision !== "DENY" && item.policyDecision !== undefined)),
    executionSuccessRate: round(rate((item) => item.status === "executed")),
    semanticCorrectRate: round(rate((item) => item.semanticCorrect)),
    meanLatencyMs: round(mean(latencies), 2),
    p50LatencyMs: round(percentile(latencies, 0.5), 2),
    p95LatencyMs: round(percentile(latencies, 0.95), 2),
  };
}

const fixture = JSON.parse(await readFile(resolve("evaluation/paraphrases.json"), "utf8")) as ParaphraseFixture;
const relevanceFixture = JSON.parse(await readFile(resolve("evaluation/vector-relevance.json"), "utf8")) as RelevanceFixture;
const relevantByQuestion = new Map(relevanceFixture.questions.map((item) => [item.question, new Set(item.relevantDocIds)]));
const variantMode = process.env.OLLAMA_EVAL_VARIANTS === "all" ? "all" : "first";
const selected = fixture.cases.flatMap((item) =>
  (variantMode === "all" ? item.paraphrases : item.paraphrases.slice(0, 1)).map((question, index) => ({ item, question, variant: index + 1 }))
);
const outputDirectory = resolve("artifacts/evaluation");
await mkdir(outputDirectory, { recursive: true });
const outputPath = resolve(outputDirectory, variantMode === "all" ? "ollama-planner-results-all.json" : "ollama-planner-results.json");
const runtime = await createRuntime({
  ...process.env,
  POLICYGRAPH_RUNTIME: "postgres",
  POLICYGRAPH_LLM_MODE: "disabled",
  POLICYGRAPH_APPROVAL_SECRET: process.env.POLICYGRAPH_APPROVAL_SECRET ?? "evaluation-only-approval-secret-32-bytes-minimum",
  POLICYGRAPH_AUDIT_PATH: process.env.POLICYGRAPH_AUDIT_PATH ?? resolve(".policygraph/ollama-evaluation-audit.jsonl"),
});
const chat = new OllamaChatClient(
  process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  process.env.OLLAMA_CHAT_MODEL ?? "gemma4:e2b",
  Number(process.env.OLLAMA_CHAT_TIMEOUT_MS ?? 600_000),
);
const llmPlanner = new CompanyXPlanner(chat);
const canonicalResults = new Map<string, RunResult>();
const results: PlannedResult[] = [];
const answerSamples: Array<Record<string, unknown>> = [];

async function checkpoint(): Promise<void> {
  await writeFile(outputPath, `${JSON.stringify({
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    model: chat.model,
    runtime: "postgres+pgvector+ollama-cpu",
    fixtureCaseCount: fixture.cases.length,
    fixtureParaphraseCount: fixture.cases.reduce((sum, item) => sum + item.paraphrases.length, 0),
    variantMode,
    metrics: calculateMetrics(results),
    results,
    answerSamples,
    limitations: "Manually labeled public-fixture paraphrases; not a hidden-test or production benchmark.",
  }, null, 2)}\n`, "utf8");
}

try {
  for (const item of fixture.cases) {
    const canonicalPlan = runtime.planner.buildPlan(item.canonical);
    canonicalResults.set(item.id, await runtime.orchestrator.run(canonicalPlan, {
      approvalReceipt: runtime.approvals?.issue(canonicalPlan, "ollama-evaluation"),
    }));
  }

  for (let index = 0; index < selected.length; index += 1) {
    const selectedCase = selected[index];
    if (!selectedCase) continue;
    const { item, question, variant } = selectedCase;
    const started = performance.now();
    try {
      const trace = await llmPlanner.planWithTrace(question, { id: "ollama-evaluation", role: "analyst" });
      const plan = trace.plan;
      const latencyMs = performance.now() - started;
      const draftTool = trace.draft?.steps[0]?.tool;
      const actualTool = plan.steps[0]?.tool;
      const run = await runtime.orchestrator.run(plan, {
        approvalReceipt: runtime.approvals?.issue(plan, "ollama-evaluation"),
      });
      const expected = canonicalResults.get(item.id);
      results.push({
        id: item.id,
        variant,
        canonical: item.canonical,
        question,
        expectedTool: item.expectedTool,
        draftTool,
        actualTool,
        normalization: trace.source,
        canonicalMatch: trace.canonicalQuestion,
        plan,
        planValid: true,
        toolCorrect: actualTool === item.expectedTool,
        policyDecision: run.policy.decision,
        status: run.status,
        semanticCorrect: expected ? semanticCorrect(item, expected, run, relevantByQuestion) : false,
        latencyMs: round(latencyMs, 2),
      });
    } catch (error) {
      results.push({
        id: item.id,
        variant,
        canonical: item.canonical,
        question,
        expectedTool: item.expectedTool,
        planValid: false,
        toolCorrect: false,
        semanticCorrect: false,
        latencyMs: round(performance.now() - started, 2),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await checkpoint();
    console.error(`[ollama-eval] ${index + 1}/${selected.length} ${item.id}: tool=${results.at(-1)?.actualTool ?? "error"} semantic=${results.at(-1)?.semanticCorrect}`);
  }

  for (const sampleId of ["sql-02", "vector-02", "graph-01"]) {
    const sample = fixture.cases.find((item) => item.id === sampleId);
    const run = canonicalResults.get(sampleId);
    if (!sample || !run) continue;
    const started = performance.now();
    const answer = await chat.composeAnswer(sample.canonical, run.evidence);
    const knownEvidenceIds = new Set(run.evidence.map((item) => item.evidenceId));
    answerSamples.push({
      id: sampleId,
      question: sample.canonical,
      generator: answer.generator,
      verified: answer.verified,
      citationIntegrity: answer.claims.every((claim) => claim.evidenceIds.every((id) => knownEvidenceIds.has(id))),
      latencyMs: round(performance.now() - started, 2),
      text: answer.text,
      claims: answer.claims,
    });
    await checkpoint();
    console.error(`[ollama-answer] ${sampleId}: generator=${answer.generator} verified=${answer.verified}`);
  }

  const finalMetrics = calculateMetrics(results);
  const modelAnswerCount = answerSamples.filter((item) => item.generator === "ollama").length;
  const summary = `# Ollama Gemma 4 evaluation\n\n- Model: ${chat.model}\n- Evaluated paraphrases: ${finalMetrics.evaluatedCount} / ${fixture.cases.reduce((sum, item) => sum + item.paraphrases.length, 0)}\n- Plan schema success: ${(finalMetrics.planSchemaSuccessRate * 100).toFixed(1)}%\n- Raw LLM tool accuracy: ${(finalMetrics.rawToolAccuracy * 100).toFixed(1)}%\n- PolicyGraph-normalized tool accuracy: ${(finalMetrics.toolAccuracy * 100).toFixed(1)}%\n- Policy acceptance: ${(finalMetrics.policyAcceptanceRate * 100).toFixed(1)}%\n- Execution success: ${(finalMetrics.executionSuccessRate * 100).toFixed(1)}%\n- Semantic correctness: ${(finalMetrics.semanticCorrectRate * 100).toFixed(1)}%\n- P50 / P95 plan latency: ${finalMetrics.p50LatencyMs.toFixed(0)} ms / ${finalMetrics.p95LatencyMs.toFixed(0)} ms\n- Evidence-answer samples: ${answerSamples.length}; model accepted ${modelAnswerCount}; safe fallback ${answerSamples.length - modelAnswerCount}; citation integrity ${(answerSamples.every((item) => item.citationIntegrity) ? "PASS" : "FAIL")}\n\nThe full 90-paraphrase fixture is versioned in \`evaluation/paraphrases.json\`. The default live run evaluates one representative paraphrase for each official question because the installed 7.2 GB model runs on CPU; set \`OLLAMA_EVAL_VARIANTS=all\` for all 90. The raw, pre-normalization baseline is preserved in \`artifacts/evaluation/ollama-planner-results-raw.json\`. An answer that does not satisfy claim-level evidence validation is counted as a safe deterministic fallback rather than a model answer. Results are public-fixture measurements, not hidden-test claims.\n`;
  await writeFile(resolve(outputDirectory, "OLLAMA_SUMMARY.md"), summary, "utf8");
  await checkpoint();
  console.log(JSON.stringify({ metrics: finalMetrics, answerSamples: answerSamples.map((item) => ({ id: item.id, generator: item.generator, verified: item.verified, citationIntegrity: item.citationIntegrity })) }, null, 2));
} finally {
  await runtime.close();
}
