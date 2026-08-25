import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { QueryPlan, RunResult } from "../core/model.ts";
import { questionWithinLimit } from "../core/input-limits.ts";
import { createRuntime, type TrustFlowRuntime } from "../runtime.ts";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const publicDirectory = resolve(currentDirectory, "public");
const MAX_REQUEST_BODY_BYTES = 64 * 1_024;

const staticFiles: Record<string, { path: string; type: string }> = {
  "/": { path: resolve(publicDirectory, "index.html"), type: "text/html; charset=utf-8" },
  "/styles.css": { path: resolve(publicDirectory, "styles.css"), type: "text/css; charset=utf-8" },
  "/app.js": { path: resolve(publicDirectory, "app.js"), type: "text/javascript; charset=utf-8" },
  "/favicon.svg": { path: resolve(publicDirectory, "favicon.svg"), type: "image/svg+xml" },
};

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function body(request: IncomingMessage, timeoutMs: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    request.destroy(new Error("request_body_timeout"));
  }, timeoutMs);
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > MAX_REQUEST_BODY_BYTES) throw new HttpError(413, "request_too_large");
      chunks.push(buffer);
    }
  } catch (error) {
    if (timedOut) throw new HttpError(408, "request_body_timeout");
    throw error;
  } finally {
    clearTimeout(timer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

export interface WebServerOptions {
  maxConcurrentRequests?: number;
  maxRequestsPerMinute?: number;
  bodyTimeoutMs?: number;
}

function loopbackHost(request: IncomingMessage): boolean {
  const host = request.headers.host;
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.toLocaleLowerCase("en-US");
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  return origin === `http://${request.headers.host}`;
}

function responseStatus(result: RunResult): number {
  return result.status === "failed" ? 500 : 200;
}

function scenario(id: string): QueryPlan {
  if (id === "write-attack") {
    return { planVersion: "1.0", query: "고객 데이터를 모두 삭제해", actor: { id: "scenario-user", role: "analyst" }, steps: [{ id: "s1", tool: "sql.query", rationale: "공격 시나리오", input: { sql: "DELETE FROM clients" } }] };
  }
  if (id === "viewer-salary") {
    return { planVersion: "1.0", query: "직원 연봉을 보여줘", actor: { id: "scenario-user", role: "viewer" }, steps: [{ id: "s1", tool: "sql.query", rationale: "권한 시나리오", input: { sql: "SELECT name, salary FROM employees LIMIT 10" } }] };
  }
  if (id === "budget-repair") {
    return { planVersion: "1.0", query: "장애 문서를 999개 찾아줘", actor: { id: "scenario-user", role: "analyst" }, steps: [{ id: "s1", tool: "vector.search", rationale: "예산 시나리오", input: { query: "장애", topK: 999 } }] };
  }
  throw new Error("Unknown scenario.");
}

export function createPolicyGraphWebServer(runtime: TrustFlowRuntime, options: WebServerOptions = {}): Server {
  const maxConcurrentRequests = options.maxConcurrentRequests ?? 4;
  const maxRequestsPerMinute = options.maxRequestsPerMinute ?? 60;
  const bodyTimeoutMs = Math.min(Math.max(options.bodyTimeoutMs ?? 10_000, 1_000), 30_000);
  const requestWindows = new Map<string, { startedAt: number; count: number }>();
  let activeRequests = 0;

  const withinRateLimit = (request: IncomingMessage): boolean => {
    const key = request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const current = requestWindows.get(key);
    if (!current || now - current.startedAt >= 60_000) {
      requestWindows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= maxRequestsPerMinute;
  };

  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && staticFiles[url.pathname]) {
        const file = staticFiles[url.pathname]!;
        response.writeHead(200, { ...SECURITY_HEADERS, "content-type": file.type, "cache-control": "no-cache" });
        response.end(await readFile(file.path));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        json(response, 200, {
          status: "ok",
          product: "TrustFlow",
          actorRole: runtime.actorRole,
          mcpTools: ["nl2sql", "vector_search", "knowledge_graph"],
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/examples") {
        json(response, 200, runtime.officialQuestions);
        return;
      }
      if (request.method === "POST" && (url.pathname === "/api/ask" || url.pathname === "/api/scenario")) {
        if (!loopbackHost(request) || !sameOrigin(request)) return json(response, 403, { error: "origin_forbidden" });
        if (!String(request.headers["content-type"] ?? "").toLocaleLowerCase("en-US").startsWith("application/json")) {
          return json(response, 415, { error: "application_json_required" });
        }
        const declaredLength = Number(request.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
          return json(response, 413, { error: "request_too_large" });
        }
        if (!withinRateLimit(request) || activeRequests >= maxConcurrentRequests) {
          response.setHeader("retry-after", "1");
          return json(response, 429, { error: "request_limit_exceeded" });
        }
        activeRequests += 1;
        try {
          const input = await body(request, bodyTimeoutMs);
          if (url.pathname === "/api/ask") {
            const question = typeof input.question === "string" ? input.question.trim() : "";
            if (!question) return json(response, 400, { error: "question_required" });
            if (!questionWithinLimit(question)) return json(response, 413, { error: "question_too_large" });
            const actor = { id: "web-demo", role: runtime.actorRole };
            const plan = await runtime.planner.plan(question, actor);
            const result = await runtime.orchestrator.run(plan, {
              approvalReceipt: typeof input.approvalReceipt === "string" ? input.approvalReceipt : undefined,
            });
            json(response, responseStatus(result), result);
            return;
          }
          const result = await runtime.orchestrator.run(scenario(String(input.id ?? "")));
          json(response, responseStatus(result), result);
          return;
        } finally {
          activeRequests -= 1;
        }
      }
      json(response, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof HttpError) {
        json(response, error.status, { error: error.code });
        return;
      }
      console.error(`[policygraph-web:${requestId}] request failed`, error);
      json(response, 500, { error: "internal_error", requestId });
    }
  });
  server.requestTimeout = bodyTimeoutMs;
  server.headersTimeout = Math.min(bodyTimeoutMs, 5_000);
  server.keepAliveTimeout = 5_000;
  return server;
}

async function main(): Promise<void> {
  const runtime = await createRuntime();
  const server = createPolicyGraphWebServer(runtime);
  const port = Number(process.env.PORT ?? 4173);
  server.listen(port, "127.0.0.1", () => console.log(`TrustFlow demo: http://127.0.0.1:${port}`));
  const close = (): void => {
    server.close(() => void runtime.close().finally(() => process.exit(0)));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
