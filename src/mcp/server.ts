import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineServer, defineTool, type AirServer } from "@airmcp-dev/core";
import type { Actor, QueryPlan, RunContext, RunResult, ToolName } from "../core/model.ts";
import { createRuntime, type TrustFlowRuntime } from "../runtime.ts";

function actor(runtime: TrustFlowRuntime): Actor {
  return { id: "mcp-user", role: runtime.actorRole };
}

async function naturalLanguagePlan(question: string, runtime: TrustFlowRuntime, expectedTool: ToolName): Promise<QueryPlan> {
  const plan = await runtime.planner.plan(question, actor(runtime));
  if (plan.steps[0]?.tool !== expectedTool) {
    throw new Error(`질문은 ${expectedTool} 도구 유형이 아닙니다.`);
  }
  return plan;
}

async function execute(runtime: TrustFlowRuntime, plan: QueryPlan, context?: RunContext): Promise<RunResult> {
  const result = await runtime.orchestrator.run(plan, context);
  if (result.status === "failed") {
    throw new Error(`PolicyGraph execution failed. Correlation ID: ${result.runId}`);
  }
  return result;
}

interface McpPublicError {
  ok: false;
  error: { code: "POLICYGRAPH_EXECUTION_FAILED"; correlationId: string };
}

async function atMcpBoundary<T>(operation: () => Promise<T>): Promise<T | McpPublicError> {
  try {
    return await operation();
  } catch (error) {
    const correlationId = randomUUID();
    console.error(`[policygraph:mcp:${correlationId}] request failed`, error);
    return { ok: false, error: { code: "POLICYGRAPH_EXECUTION_FAILED", correlationId } };
  }
}

export function createPolicyGraphServer(runtime: TrustFlowRuntime): AirServer {
  return defineServer({
    name: "trustflow-companyx",
    version: "0.3.0",
    description: "TrustFlow MCP data tools for Company-X, gated by the PolicyGraph safety engine",
    transport: { type: "stdio" },
    logging: { level: "info", format: "pretty" },
    tools: [
      defineTool("nl2sql", {
        description: "Convert a Company-X natural-language analytics question to bounded read-only SQL and execute it after PolicyGraph validation.",
        params: {
          question: { type: "string", description: "Natural-language Company-X analytics question" },
          approvalReceipt: { type: "string", description: "Optional short-lived admin-signed approval receipt", optional: true },
        },
        handler: async ({ question, approvalReceipt }) => atMcpBoundary(async () => execute(
            runtime,
            await naturalLanguagePlan(String(question), runtime, "sql.query"),
            { approvalReceipt: typeof approvalReceipt === "string" ? approvalReceipt : undefined },
          )),
      }),
      defineTool("vector_search", {
        description: "Search Company-X documents after enforcing evidence and data-scope budgets.",
        params: {
          question: { type: "string", description: "Natural-language document question" },
          topK: { type: "number", description: "Maximum results", optional: true },
        },
        handler: async ({ question, topK }) => atMcpBoundary(async () => {
          const plan = await naturalLanguagePlan(String(question), runtime, "vector.search");
          const step = plan.steps[0];
          if (step?.tool === "vector.search" && typeof topK === "number") step.input.topK = Math.trunc(topK);
          return execute(runtime, plan);
        }),
      }),
      defineTool("knowledge_graph", {
        description: "Resolve a Company-X relationship question with allow-listed traversals or bounded relation aggregation.",
        params: { question: { type: "string", description: "Natural-language Company-X relationship question" } },
        handler: async ({ question }) => atMcpBoundary(async () => execute(
            runtime,
            await naturalLanguagePlan(String(question), runtime, "graph.traverse"),
          )),
      }),
    ],
  });
}

async function main(): Promise<void> {
  const runtime = await createRuntime();
  const server = createPolicyGraphServer(runtime);
  await server.start();
}

export const createTrustFlowServer = createPolicyGraphServer;

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(currentFile)) {
  await main();
}
