import { loadDocumentIndex, readDocumentMarkdown, type DocumentIndexItem } from "../core/document-corpus.ts";

interface IndexedDocument extends DocumentIndexItem {
  content: string;
  vector: Float64Array;
}

export interface DocumentSearchHit {
  id: string;
  type: string;
  title: string;
  score: number;
  snippet: string;
}

export interface DocumentSearch {
  search(query: string, topK: number, documentType?: string): Promise<DocumentSearchHit[]>;
}

const DIMENSIONS = 768;

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function features(text: string): string[] {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("ko-KR");
  const words = normalized.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
  const compact = normalized.replace(/[^\p{L}\p{N}]/gu, "");
  const grams: string[] = [];
  for (const size of [2, 3]) {
    for (let index = 0; index <= compact.length - size; index += 1) {
      grams.push(compact.slice(index, index + size));
    }
  }
  return [...words, ...grams];
}

export function localEmbedding(text: string): Float64Array {
  const vector = new Float64Array(DIMENSIONS);
  for (const feature of features(text)) {
    const hash = fnv1a(feature);
    const index = hash % DIMENSIONS;
    const sign = hash & 0x80000000 ? -1 : 1;
    vector[index] += sign;
  }

  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  }
  return vector;
}

function cosine(left: Float64Array, right: Float64Array): number {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

function snippet(content: string, query: string): string {
  const terms = features(query).filter((item) => item.length >= 2);
  const normalized = content.toLocaleLowerCase("ko-KR");
  const positions = terms.map((term) => normalized.indexOf(term)).filter((position) => position >= 0);
  const center = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, center - 120);
  const end = Math.min(content.length, start + 420);
  return `${start > 0 ? "…" : ""}${content.slice(start, end).trim()}${end < content.length ? "…" : ""}`;
}

/**
 * Dependency-free 768-dimensional vector baseline.
 * Production uses Ollama embeddings + pgvector; this baseline keeps tests and demos reproducible offline.
 */
export class LocalVectorSearch implements DocumentSearch {
  private readonly documents: IndexedDocument[];

  private constructor(documents: IndexedDocument[]) {
    this.documents = documents;
  }

  static async fromDirectory(documentsDirectory: string): Promise<LocalVectorSearch> {
    const index = await loadDocumentIndex(documentsDirectory);
    const documents = await Promise.all(
      index.map(async (item) => {
        const { content } = await readDocumentMarkdown(documentsDirectory, item.filename);
        const weightedText = `${item.title}\n${item.title}\n${item.title}\n${content}`;
        return { ...item, content, vector: localEmbedding(weightedText) };
      }),
    );
    return new LocalVectorSearch(documents);
  }

  async search(query: string, topK: number, documentType?: string): Promise<DocumentSearchHit[]> {
    const queryVector = localEmbedding(query);
    return this.documents
      .filter((document) => !documentType || document.type === documentType)
      .map((document) => ({
        id: document.id,
        type: document.type,
        title: document.title,
        score: cosine(queryVector, document.vector),
        snippet: snippet(document.content, query),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);
  }
}
