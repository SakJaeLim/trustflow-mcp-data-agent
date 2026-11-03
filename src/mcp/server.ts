import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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

// Bound user-controlled strings before they reach planning or approval parsing.
const questionSchema = z.string().trim().min(1).max(8_192);
const approvalSchema = z.string().max(16_384).optional();

export function createPolicyGraphServer(runtime: TrustFlowRuntime): McpServer {
  const server = new McpServer({ name: "trustflow-companyx", version: "0.3.0" });
  const response = async (operation: () => Promise<RunResult>) => {
    const result = await atMcpBoundary(operation);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      ...("ok" in result && result.ok === false ? { isError: true } : {}),
    };
  };
  server.registerTool("nl2sql", {
    description: "Convert a Company-X question to bounded read-only SQL after PolicyGraph validation.",
    inputSchema: z.strictObject({ question: questionSchema, approvalReceipt: approvalSchema }),
  }, async ({ question, approvalReceipt }) => response(async () => execute(
    runtime, await naturalLanguagePlan(question, runtime, "sql.query"), { approvalReceipt },
  )));
  server.registerTool("vector_search", {
    description: "Search Company-X documents after enforcing evidence and data-scope budgets.",
    inputSchema: z.strictObject({ question: questionSchema, topK: z.number().int().positive().max(100).optional() }),
  }, async ({ question, topK }) => response(async () => {
    const plan = await naturalLanguagePlan(question, runtime, "vector.search");
    const step = plan.steps[0];
    if (step?.tool === "vector.search" && topK !== undefined) step.input.topK = topK;
    return execute(runtime, plan);
  }));
  server.registerTool("knowledge_graph", {
    description: "Resolve Company-X relationships through allow-listed, bounded traversals.",
    inputSchema: z.strictObject({ question: questionSchema }),
  }, async ({ question }) => response(async () => execute(
    runtime, await naturalLanguagePlan(question, runtime, "graph.traverse"),
  )));
  return server;
}

async function main(): Promise<void> {
  const runtime = await createRuntime();
  const server = createPolicyGraphServer(runtime);
  const transport = new StdioServerTransport();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
    await runtime.close();
  };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  server.server.onclose = () => { void close(); };
  await server.connect(transport);
}

export const createTrustFlowServer = createPolicyGraphServer;

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(currentFile)) {
  await main();
}
