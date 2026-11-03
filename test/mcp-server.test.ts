import test from "node:test";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createTrustFlowServer } from "../src/mcp/server.ts";
import { createRuntime } from "../src/runtime.ts";
import type { TrustFlowRuntime } from "../src/runtime.ts";

async function connect(runtime: TrustFlowRuntime) {
  const server = createTrustFlowServer(runtime);
  const client = new Client({ name: "trustflow-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client, close: async () => { await client.close(); await server.close(); } };
}
function textResult(raw: unknown): string {
  return (raw as { content: Array<{ text: string }> }).content[0].text;
}

test("MCP protocol exposes exactly the three required Company-X tools", async () => {
  const runtime = await createRuntime({
    ...process.env,
    POLICYGRAPH_RUNTIME: "offline",
    POLICYGRAPH_AUDIT_PATH: resolve(".policygraph", `test-mcp-${randomUUID()}.jsonl`),
    POLICYGRAPH_AUDIT_SIGNING_SECRET: "test-only-mcp-audit-signing-secret-at-least-32-bytes",
    POLICYGRAPH_AUDIT_CHECKPOINT_DIR: resolve(".policygraph", `test-mcp-checkpoints-${randomUUID()}`),
  });
  try {
    const connection = await connect(runtime);
    try {
      const names = (await connection.client.listTools()).tools.map((tool) => tool.name);
      assert.deepEqual(names, ["nl2sql", "vector_search", "knowledge_graph"]);

      const raw = await connection.client.callTool({ name: "knowledge_graph", arguments: {
        question: "Client-A가 사용 중인 제품 목록은?",
      } });
      const result = JSON.parse(textResult(raw)) as { status: string; policy: { decision: string } };
      assert.equal(result.status, "executed");
      assert.equal(result.policy.decision, "ALLOW");
    } finally { await connection.close(); }
  } finally {
    await runtime.close();
  }
});

test("MCP boundary returns only a generic error and correlation ID", async () => {
  const internalDetail = "C:\\private\\audit-ledger.jsonl";
  const runtime = {
    actorRole: "analyst",
    planner: { plan: async () => { throw new Error(internalDetail); } },
  } as unknown as TrustFlowRuntime;
  const connection = await connect(runtime);
  try {
  const raw = await connection.client.callTool({ name: "nl2sql", arguments: { question: "고객 수는?" } });
  assert.doesNotMatch(textResult(raw), /private|audit-ledger/u);
  const result = JSON.parse(textResult(raw)) as { ok: boolean; error: { code: string; correlationId: string } };
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "POLICYGRAPH_EXECUTION_FAILED");
  assert.match(result.error.correlationId, /^[0-9a-f-]{36}$/u);
  } finally { await connection.close(); }
});


test("MCP rejects malformed and oversized input before planning", async () => {
  let plannerCalls = 0;
  const runtime = {
    actorRole: "analyst",
    planner: { plan: async () => { plannerCalls++; throw new Error("must not execute"); } },
  } as unknown as TrustFlowRuntime;
  const connection = await connect(runtime);
  try {
    const invalid = [
      { name: "nl2sql", arguments: { question: "" } },
      { name: "nl2sql", arguments: { question: " " } },
      { name: "nl2sql", arguments: { question: "x".repeat(8193) } },
      { name: "nl2sql", arguments: { question: ["invalid"] } },
      { name: "nl2sql", arguments: { question: "q", approvalReceipt: "x".repeat(16385) } },
      { name: "nl2sql", arguments: { question: "q", actorRole: "admin" } },
      { name: "vector_search", arguments: { question: "q", topK: -1 } },
      { name: "vector_search", arguments: { question: "q", topK: 1.5 } },
      { name: "vector_search", arguments: { question: "q", topK: 101 } },
      { name: "knowledge_graph", arguments: {} },
    ];
    for (const request of invalid) {
      const result = await connection.client.callTool(request);
      assert.equal(result.isError, true, JSON.stringify(request).slice(0, 100));
    }
    assert.equal(plannerCalls, 0);
  } finally { await connection.close(); }
});


test("stdio entry point completes MCP initialization and lists tools", async () => {
  const client = new Client({ name: "trustflow-stdio-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("src/mcp/server.ts")],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
      POLICYGRAPH_RUNTIME: "offline",
      POLICYGRAPH_AUDIT_PATH: resolve(".policygraph", `stdio-${randomUUID()}.jsonl`),
      POLICYGRAPH_AUDIT_SIGNING_SECRET: "test-only-stdio-secret-at-least-thirty-two-bytes",
      POLICYGRAPH_AUDIT_CHECKPOINT_DIR: resolve(".policygraph", `stdio-checkpoints-${randomUUID()}`),
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["nl2sql", "vector_search", "knowledge_graph"]);
    const result = await client.callTool({ name: "nl2sql", arguments: { question: [] } });
    assert.equal(result.isError, true);
  } finally {
    await client.close();
    await transport.close();
  }
});
