import { localHttpBaseUrl, readJsonResponseBounded } from "./bounded-http-json.ts";

export interface Embedder {
  embed(input: string[]): Promise<number[][]>;
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
}

export class OllamaEmbedder implements Embedder {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly dimensions: number;
  private active = false;

  constructor(baseUrl: string, model: string, dimensions = 768) {
    this.baseUrl = localHttpBaseUrl(baseUrl);
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(input: string[]): Promise<number[][]> {
    if (this.active) throw new Error("Ollama embedding capacity is busy.");
    this.active = true;
    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input }),
        signal: AbortSignal.timeout(60_000),
        redirect: "error",
      });
      if (!response.ok) {
        throw new Error(`Ollama embed failed: ${response.status} ${response.statusText}`);
      }
      const payload = await readJsonResponseBounded(response, 8 * 1_048_576) as OllamaEmbedResponse;
      const embeddings = payload.embeddings;
      if (!embeddings || embeddings.length !== input.length) {
        throw new Error("Ollama returned an unexpected number of embeddings.");
      }
      for (const embedding of embeddings) {
        if (!Array.isArray(embedding) || embedding.length !== this.dimensions) {
          throw new Error(`Expected ${this.dimensions} dimensions but received ${embedding.length}.`);
        }
        if (embedding.some((value) => typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000)) {
          throw new Error("Ollama returned an invalid embedding scalar.");
        }
      }
      return embeddings;
    } finally {
      this.active = false;
    }
  }
}
