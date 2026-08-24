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

  constructor(baseUrl: string, model: string, dimensions = 768) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(input: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Ollama embed failed: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as OllamaEmbedResponse;
    const embeddings = payload.embeddings;
    if (!embeddings || embeddings.length !== input.length) {
      throw new Error("Ollama returned an unexpected number of embeddings.");
    }
    for (const embedding of embeddings) {
      if (embedding.length !== this.dimensions) {
        throw new Error(`Expected ${this.dimensions} dimensions but received ${embedding.length}.`);
      }
    }
    return embeddings;
  }
}
