import { performance } from "node:perf_hooks";
import { OllamaChatClient } from "../src/adapters/ollama-chat.ts";

const client = new OllamaChatClient(
  process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  process.env.OLLAMA_CHAT_MODEL ?? "gemma4:e2b",
  Number(process.env.OLLAMA_CHAT_TIMEOUT_MS ?? 300_000),
);

const questions = [
  "2025-Q3에 발생한 전체 매출 합계를 계산해 줘.",
  "Product-C1을 설치하려면 어떤 절차를 따라야 하나요?",
  "Client-A와 사용 제품 사이의 관계를 찾아줘.",
];

const results = [];
for (const question of questions) {
  const started = performance.now();
  const plan = await client.draftPlan(question, { id: "ollama-smoke", role: "analyst" });
  results.push({ question, tool: plan.steps[0]?.tool, input: plan.steps[0]?.input, latencyMs: Math.round(performance.now() - started) });
}
console.log(JSON.stringify({ model: client.model, results }, null, 2));
