import test from "node:test";
import assert from "node:assert/strict";
import { localHttpBaseUrl, readJsonResponseBounded } from "../src/adapters/bounded-http-json.ts";
import { OllamaEmbedder } from "../src/adapters/ollama-embedder.ts";

test("Ollama endpoint accepts only an uncredentialed loopback HTTP origin", () => {
  assert.equal(localHttpBaseUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(localHttpBaseUrl("http://localhost:11434/"), "http://localhost:11434");
  assert.equal(localHttpBaseUrl("http://[::1]:11434"), "http://[::1]:11434");
  for (const value of [
    "https://127.0.0.1:11434",
    "http://127.0.0.1.example:11434",
    "http://user:password@127.0.0.1:11434",
    "http://127.0.0.1:11434/api",
  ]) assert.throws(() => localHttpBaseUrl(value), /loopback HTTP origin/u);
});

test("Ollama HTTP adapters enforce response and concurrency budgets", async () => {
  await assert.rejects(
    readJsonResponseBounded(new Response("{}", { headers: { "content-length": "100" } }), 10),
    /exceeds 10 bytes/u,
  );
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"value":"'));
      controller.enqueue(new TextEncoder().encode("too large"));
      controller.enqueue(new TextEncoder().encode('"}'));
      controller.close();
    },
  }));
  await assert.rejects(readJsonResponseBounded(response, 12), /exceeds 12 bytes/u);
  assert.deepEqual(await readJsonResponseBounded(new Response('{"ok":true}'), 32), { ok: true });

  const originalFetch = globalThis.fetch;
  let releaseFetch!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    await gate;
    return new Response(JSON.stringify({ embeddings: [Array<number>(768).fill(0)] }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const embedder = new OllamaEmbedder("http://127.0.0.1:11434", "test-model");
    const first = embedder.embed(["first"]);
    await assert.rejects(embedder.embed(["second"]), /embedding capacity is busy/u);
    assert.equal(fetchCalls, 1);
    releaseFetch();
    assert.equal((await first).length, 1);
    assert.equal((await embedder.embed(["third"])).length, 1);
    assert.equal(fetchCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
