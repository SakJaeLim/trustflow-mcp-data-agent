import { performance } from "node:perf_hooks";
import { evidenceId } from "../core/hash.ts";
import type {
  EvidenceItem,
  GraphStep,
  PlanStep,
  SqlStep,
  ToolExecution,
  ToolName,
  VectorStep,
} from "../core/model.ts";
import type { DocumentSearch } from "./local-vector-search.ts";
import type { SqlRunner } from "./sqlite-fixture.ts";
import { GraphStore } from "./graph-store.ts";

export interface StepExecutor {
  readonly tool: ToolName;
  execute(step: PlanStep): Promise<EvidenceItem[]>;
}

export class SqlStepExecutor implements StepExecutor {
  readonly tool = "sql.query" as const;
  private readonly runner: SqlRunner;
  private readonly source: string;

  constructor(runner: SqlRunner, source = "companyx.postgresql") {
    this.runner = runner;
    this.source = source;
  }

  async execute(step: PlanStep): Promise<EvidenceItem[]> {
    if (step.tool !== this.tool) throw new Error(`SQL executor received ${step.tool}`);
    const sqlStep = step as SqlStep;
    const result = await this.runner.query(sqlStep.input.sql, sqlStep.input.maxRows ?? 100);
    const payload = { sql: sqlStep.input.sql, maxRows: sqlStep.input.maxRows ?? 100, rowCount: result.rowCount, rows: result.rows };
    return [
      {
        evidenceId: evidenceId(this.tool, this.source, payload),
        stepId: step.id,
        tool: this.tool,
        source: this.source,
        kind: "table",
        payload,
      },
    ];
  }
}

export class VectorStepExecutor implements StepExecutor {
  readonly tool = "vector.search" as const;
  private readonly searcher: DocumentSearch;
  private readonly provider: string;

  constructor(searcher: DocumentSearch, provider = "local-vector-baseline") {
    this.searcher = searcher;
    this.provider = provider;
  }

  async execute(step: PlanStep): Promise<EvidenceItem[]> {
    if (step.tool !== this.tool) throw new Error(`Vector executor received ${step.tool}`);
    const vectorStep = step as VectorStep;
    const hits = await this.searcher.search(
      vectorStep.input.query,
      vectorStep.input.topK ?? 5,
      vectorStep.input.documentType,
    );
    return hits.map((hit) => ({
      evidenceId: evidenceId(this.tool, `doc://companyx/${hit.id}`, hit),
      stepId: step.id,
      tool: this.tool,
      source: `doc://companyx/${hit.id}`,
      kind: "passage",
      score: hit.score,
      payload: { ...hit, provider: this.provider },
    }));
  }
}

export class GraphStepExecutor implements StepExecutor {
  readonly tool = "graph.traverse" as const;
  private readonly graph: GraphStore;
  private readonly source: string;

  constructor(graph: GraphStore, source = "kg://companyx") {
    this.graph = graph;
    this.source = source;
  }

  async execute(step: PlanStep): Promise<EvidenceItem[]> {
    if (step.tool !== this.tool) throw new Error(`Graph executor received ${step.tool}`);
    const graphStep = step as GraphStep;
    const result = this.graph.query(graphStep.input);
    return [
      {
        evidenceId: evidenceId(this.tool, this.source, result),
        stepId: step.id,
        tool: this.tool,
        source: this.source,
        kind: "graph_path",
        payload: result,
      },
    ];
  }
}

export async function timedExecution(executor: StepExecutor, step: PlanStep): Promise<ToolExecution> {
  const started = performance.now();
  const evidence = await executor.execute(step);
  return {
    stepId: step.id,
    tool: step.tool,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
    evidence,
  };
}
