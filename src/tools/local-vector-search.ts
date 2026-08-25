import {
  loadDocumentIndex,
  MAX_CORPUS_BYTES,
  readDocumentMarkdown,
  type DocumentIndexItem,
  type VerifiedDocumentCorpus,
} from "../core/document-corpus.ts";

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
  datasetSha256?: string;
  provider?: string;
}

export class FailoverDocumentSearch implements DocumentSearch {
  private readonly primary: DocumentSearch;
  private readonly fallback: DocumentSearch;

  constructor(
    primary: DocumentSearch,
    fallback: DocumentSearch,
  ) {
    this.primary = primary;
    this.fallback = fallback;
  }

  async search(query: string, topK: number, documentType?: string): Promise<DocumentSearchHit[]> {
    try {
      return await this.primary.search(query, topK, documentType);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      console.error(`[policygraph:vector] primary search unavailable; using authenticated local fallback: ${detail}`);
      return (await this.fallback.search(query, topK, documentType))
        .map((hit) => ({ ...hit, provider: "local-vector-fallback" }));
    }
  }
}

export interface DocumentSearch {
  search(query: string, topK: number, documentType?: string): Promise<DocumentSearchHit[]>;
}

const DIMENSIONS = 768;
const MAX_FEATURES = 4_096;
const MAX_FEATURE_TEXT_CHARS = 32_768;
const MAX_SNIPPET_TERMS = 128;

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function features(text: string, limit = MAX_FEATURES): string[] {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("ko-KR").slice(0, MAX_FEATURE_TEXT_CHARS);
  const words = normalized.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
  const compact = normalized.replace(/[^\p{L}\p{N}]/gu, "");
  const output = new Set<string>();
  for (const word of words) {
    output.add(word);
    if (output.size >= limit) return [...output];
  }
  for (const size of [2, 3]) {
    for (let index = 0; index <= compact.length - size; index += 1) {
      output.add(compact.slice(index, index + size));
      if (output.size >= limit) return [...output];
    }
  }
  return [...output];
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

function snippet(content: string, queryTerms: string[]): string {
  const terms = queryTerms.slice(0, MAX_SNIPPET_TERMS);
  const normalized = content.normalize("NFKC").toLocaleLowerCase("ko-KR");
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
  private readonly datasetSha256?: string;

  private constructor(documents: IndexedDocument[], datasetSha256?: string) {
    this.documents = documents;
    this.datasetSha256 = datasetSha256;
  }

  static async fromDirectory(documentsDirectory: string, datasetSha256?: string): Promise<LocalVectorSearch> {
    const index = await loadDocumentIndex(documentsDirectory);
    const documents: IndexedDocument[] = [];
    let corpusBytes = 0;
    for (const item of index) {
      const { content, bytes } = await readDocumentMarkdown(documentsDirectory, item.filename);
      corpusBytes += bytes;
      if (corpusBytes > MAX_CORPUS_BYTES) throw new Error(`Document corpus exceeds ${MAX_CORPUS_BYTES} bytes.`);
      const weightedText = `${item.title}\n${item.title}\n${item.title}\n${content}`;
      documents.push({ ...item, content, vector: localEmbedding(weightedText) });
    }
    return new LocalVectorSearch(documents, datasetSha256);
  }

  static fromVerifiedCorpus(corpus: VerifiedDocumentCorpus, datasetSha256?: string): LocalVectorSearch {
    return new LocalVectorSearch(corpus.documents.map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      filename: item.filename,
      content: item.content,
      vector: localEmbedding(`${item.title}\n${item.title}\n${item.title}\n${item.content}`),
    })), datasetSha256);
  }

  async search(query: string, topK: number, documentType?: string): Promise<DocumentSearchHit[]> {
    const queryVector = localEmbedding(query);
    const queryTerms = features(query, MAX_SNIPPET_TERMS).filter((item) => item.length >= 2);
    return this.documents
      .filter((document) => !documentType || document.type === documentType)
      .map((document) => ({
        document,
        score: cosine(queryVector, document.vector),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, topK)
      .map(({ document, score }) => ({
        id: document.id,
        type: document.type,
        title: document.title,
        score,
        snippet: snippet(document.content, queryTerms),
        datasetSha256: this.datasetSha256,
      }));
  }
}
