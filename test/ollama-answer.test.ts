import test from "node:test";
import assert from "node:assert/strict";
import { OllamaChatClient } from "../src/adapters/ollama-chat.ts";
import type { EvidenceItem } from "../src/core/model.ts";
import { composeAnswer } from "../src/evidence/composer.ts";

function evidence(evidenceId: string, count: number): EvidenceItem {
  return {
    evidenceId,
    stepId: "s1",
    tool: "sql.query",
    source: `sql://${evidenceId}`,
    kind: "table",
    payload: { rows: [{ count }] },
  };
}

test("Ollama claims must be supported by the evidence IDs they cite", async () => {
  const client = new OllamaChatClient("http://127.0.0.1:1", "test");
  client.json = async () => ({
    claims: [{ text: "총 42건입니다.", evidenceIds: ["ev_wrong"] }],
  });
  const result = await client.composeAnswer("몇 건이야?", [evidence("ev_right", 42), evidence("ev_wrong", 7)]);
  assert.equal(result.generator, "deterministic");

  client.json = async () => ({ claims: [{ text: "총 42건입니다.", evidenceIds: ["ev_142"] }] });
  const substring = await client.composeAnswer("몇 건이야?", [evidence("ev_142", 142)]);
  assert.equal(substring.generator, "deterministic");

  client.json = async () => ({ claims: [{ text: "Product-A는 42건입니다.", evidenceIds: ["ev_a", "ev_b"] }] });
  const spliced = await client.composeAnswer("제품별 건수는?", [
    { ...evidence("ev_a", 7), payload: { rows: [{ product: "Product-A", count: 7 }] } },
    { ...evidence("ev_b", 42), payload: { rows: [{ product: "Product-B", count: 42 }] } },
  ]);
  assert.equal(spliced.generator, "deterministic");

  client.json = async () => ({ claims: [{ text: "총 42건입니다.", evidenceIds: ["ev_unit"] }] });
  const wrongUnit = await client.composeAnswer("몇 건이야?", [
    { ...evidence("ev_unit", 42), payload: { rows: [{ amount: "42원" }] } },
  ]);
  assert.equal(wrongUnit.generator, "deterministic");

  client.json = async () => ({ claims: [{ text: "총 42원입니다.", evidenceIds: ["ev_bare"] }] });
  assert.equal((await client.composeAnswer("금액은?", [evidence("ev_bare", 42)])).generator, "deterministic");

  const passage: EvidenceItem = {
    evidenceId: "ev_decimal", stepId: "s1", tool: "vector.search", source: "doc://decimal", kind: "passage",
    payload: { title: "가동률", snippet: "현재 가동률은 1.2%입니다." },
  };
  client.json = async () => ({ claims: [{ text: "현재 가동률은 12%입니다.", evidenceIds: ["ev_decimal"] }] });
  assert.equal((await client.composeAnswer("가동률은?", [passage])).generator, "deterministic");
  client.json = async () => ({ claims: [{ text: "현재 가동률은 \u202e1.2%입니다.", evidenceIds: ["ev_decimal"] }] });
  assert.equal((await client.composeAnswer("가동률은?", [passage])).generator, "deterministic");
});

test("Ollama citations contain only evidence actually used by accepted claims", async () => {
  const client = new OllamaChatClient("http://127.0.0.1:1", "test");
  client.json = async () => ({
    claims: [{ text: "총 42건입니다.", evidenceIds: ["ev_right"] }],
  });
  const result = await client.composeAnswer("몇 건이야?", [
    { evidenceId: "ev_right", stepId: "s1", tool: "vector.search", source: "doc://right", kind: "passage", payload: { title: "집계", snippet: "총 42건입니다." } },
    { evidenceId: "ev_unused", stepId: "s1", tool: "vector.search", source: "doc://unused", kind: "passage", payload: { title: "기타", snippet: "총 7건입니다." } },
  ]);
  assert.equal(result.generator, "ollama");
  assert.deepEqual(result.citations.map((item) => item.evidenceId), ["ev_right"]);

  const passages: EvidenceItem[] = Array.from({ length: 4 }, (_, index) => ({
    evidenceId: `passage_${index}`,
    stepId: "s1",
    tool: "vector.search",
    source: `doc://${index}`,
    kind: "passage",
    payload: { title: `문서 ${index}`, snippet: `근거 내용 ${index}` },
  }));
  const deterministic = composeAnswer("근거를 알려줘", passages);
  assert.deepEqual(deterministic.citations.map((item) => item.evidenceId), ["passage_0", "passage_1"]);
});

test("contradictory nonnumeric Ollama prose falls back to deterministic evidence composition", async () => {
  const client = new OllamaChatClient("http://127.0.0.1:1", "test");
  client.json = async () => ({
    claims: [{ text: "회사는 모든 백업을 영구 중단했습니다.", evidenceIds: ["ev_backup"] }],
  });
  const source: EvidenceItem = {
    evidenceId: "ev_backup",
    stepId: "s1",
    tool: "vector.search",
    source: "doc://backup",
    kind: "passage",
    payload: { title: "백업 정책", snippet: "매일 증분 백업을 수행합니다." },
  };
  const result = await client.composeAnswer("백업 정책은 어떻게 되어 있어?", [source]);
  assert.equal(result.generator, "deterministic");
  assert.doesNotMatch(result.text, /영구 중단/u);

  const contaminated = await client.composeAnswer("회사는 모든 백업을 영구 중단했습니다.", [source]);
  assert.equal(contaminated.generator, "deterministic");
  assert.doesNotMatch(contaminated.text, /영구 중단/u);
});

test("Ollama chat admits only one in-flight request and caps its timeout", async () => {
  const originalFetch = globalThis.fetch;
  let release: ((value: Response) => void) | undefined;
  let started: (() => void) | undefined;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  globalThis.fetch = async () => {
    started?.();
    return new Promise<Response>((resolve) => { release = resolve; });
  };
  try {
    const client = new OllamaChatClient("http://127.0.0.1:11434", "test", 9_999_999);
    assert.equal(client.timeoutMs, 600_000);
    const first = client.json("system", "first");
    await didStart;
    await assert.rejects(client.json("system", "second"), /capacity is busy/u);
    release?.(new Response(JSON.stringify({ message: { content: "{}" } }), {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "28" },
    }));
    assert.deepEqual(await first, {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});
