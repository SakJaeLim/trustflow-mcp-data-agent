import type { DocumentSearch, DocumentSearchHit } from "../tools/local-vector-search.ts";
import { COMPANYX_DATASET_SHA256 } from "../core/companyx-integrity.ts";
import { sha256Hex } from "../core/companyx-integrity.ts";
import type { VerifiedDocumentCorpus, VerifiedDocumentChunk, VerifiedDocument } from "../core/document-corpus.ts";
import type { Embedder } from "./ollama-embedder.ts";
import { PostgresDatabase, type PostgresReadTransaction } from "./postgres.ts";

interface ChunkRow {
  doc_id: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown> | string;
  score: number | string;
}

const STOP_WORDS = new Set([
  "알려줘", "궁금해", "관련", "내용", "어떻게", "있어", "있었어", "뭐야", "방법", "보여줘", "되어",
]);
const KOREAN_PARTICLES = ["으로부터", "에서부터", "에게서", "으로", "에서", "에게", "까지", "부터", "처럼", "보다", "께서", "와", "과", "의", "에", "은", "는", "이", "가", "을", "를", "도", "만"];
const MAX_QUERY_TERMS = 32;

function normalizeTerm(value: string): string {
  if (!/[가-힣]/u.test(value)) return value;
  for (const particle of KOREAN_PARTICLES) {
    if (value.length > particle.length + 1 && value.endsWith(particle)) {
      return value.slice(0, -particle.length);
    }
  }
  return value;
}

function terms(value: string): string[] {
  const normalized = (value.normalize("NFKC").toLocaleLowerCase("ko-KR").match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [])
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term))
    .map(normalizeTerm)
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
  return [...new Set(normalized)].slice(0, MAX_QUERY_TERMS);
}

interface RankedCandidate {
  id: string;
  type: string;
  title: string;
  content: string;
  vectorScore: number;
  normalizedTitle: string;
  normalizedContent: string;
  normalizedHaystack: string;
}

function lexicalScore(queryTerms: string[], candidate: RankedCandidate, frequencies: Map<string, number>, candidateCount: number): number {
  if (queryTerms.length === 0) return 0;
  let score = 0;
  let maximum = 0;
  for (const term of queryTerms) {
    const inverseDocumentFrequency = Math.log((candidateCount + 1) / ((frequencies.get(term) ?? 0) + 0.5)) + 1;
    maximum += inverseDocumentFrequency * 2;
    if (candidate.normalizedTitle.includes(term)) score += inverseDocumentFrequency * 2;
    else if (candidate.normalizedContent.includes(term)) score += inverseDocumentFrequency * 1.25;
  }
  return maximum === 0 ? 0 : score / maximum;
}

function proximityScore(queryTerms: string[], candidate: RankedCandidate): number {
  if (queryTerms.length < 2) return 0;
  let nearbyPairs = 0;
  for (let index = 0; index < queryTerms.length - 1; index += 1) {
    const left = candidate.normalizedHaystack.indexOf(queryTerms[index] ?? "");
    const right = candidate.normalizedHaystack.indexOf(queryTerms[index + 1] ?? "");
    if (left >= 0 && right >= 0 && Math.abs(left - right) <= 40) nearbyPairs += 1;
  }
  return nearbyPairs / (queryTerms.length - 1);
}

function preferredTypes(query: string): Set<string> {
  const normalized = query.normalize("NFKC").toLocaleLowerCase("ko-KR");
  const preferred = new Set<string>();
  if (/제안서|도입 제안/u.test(normalized)) preferred.add("proposal");
  if (/회의|미팅|논의|안건|일정 지연/u.test(normalized)) preferred.add("meeting_note");
  if (/장애|장애 사례|장애 대응|원인/u.test(normalized)) preferred.add("incident_report");
  if (/설치|튜닝|백업|api|운영 매뉴얼|아키텍처/u.test(normalized)) preferred.add("technical_doc");
  return preferred;
}

function recencyScore(query: string, candidate: RankedCandidate, candidates: RankedCandidate[], types: Set<string>): number {
  if (!/최근|최신/u.test(query)) return 0;
  if (types.size > 0 && !types.has(candidate.type)) return 0;
  const dated = candidates.filter((item) => item.type === candidate.type).map((item) => {
    const match = item.title.match(/\((\d{4}-\d{2}-\d{2})\)/u);
    return { id: item.id, time: match ? Date.parse(`${match[1]}T00:00:00Z`) : Number.NaN };
  }).filter((item) => Number.isFinite(item.time));
  const current = dated.find((item) => item.id === candidate.id);
  if (!current || dated.length < 2) return 0;
  const minimum = Math.min(...dated.map((item) => item.time));
  const maximum = Math.max(...dated.map((item) => item.time));
  return maximum === minimum ? 1 : (current.time - minimum) / (maximum - minimum);
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function parseMetadata(value: Record<string, unknown> | string): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid pgvector metadata object.");
  return parsed as Record<string, unknown>;
}

export class PgVectorDocumentSearch implements DocumentSearch {
  private readonly database: PostgresDatabase;
  private readonly embedder: Embedder;
  private readonly datasetSha256: string;
  private readonly generationSha256: string;
  private readonly documents: Map<string, VerifiedDocument>;
  private readonly chunks: Map<string, VerifiedDocumentChunk>;
  private readonly stateGuard?: (transaction: PostgresReadTransaction) => Promise<void>;

  constructor(
    database: PostgresDatabase,
    embedder: Embedder,
    datasetSha256: string,
    corpus: VerifiedDocumentCorpus,
    stateGuard?: (transaction: PostgresReadTransaction) => Promise<void>,
  ) {
    this.database = database;
    this.embedder = embedder;
    this.datasetSha256 = datasetSha256;
    this.generationSha256 = corpus.generationSha256;
    this.documents = new Map(corpus.documents.map((document) => [document.id, document]));
    this.chunks = new Map(corpus.chunks.map((chunk) => [`${chunk.docId}:${chunk.chunkIndex}`, chunk]));
    this.stateGuard = stateGuard;
  }

  async search(query: string, topK: number, documentType?: string): Promise<DocumentSearchHit[]> {
    const [embedding] = await this.embedder.embed([`search_query: ${query}`]);
    if (!embedding) return [];
    const rows = await this.database.withReadTransaction(async (transaction) => {
      await this.stateGuard?.(transaction);
      return transaction.queryRows<ChunkRow>(
        `SELECT doc_id, chunk_index, content, metadata,
                1 - (embedding <=> $1::vector) AS score
           FROM document_chunks
          WHERE embedding IS NOT NULL
            AND octet_length(content) <= 1048576
            AND octet_length(metadata::text) <= 16384
            AND ($3::text IS NULL OR metadata->>'type' = $3)
            AND metadata->>'datasetSha256' = $4
            AND metadata->>'generationSha256' = $5
          ORDER BY embedding <=> $1::vector
          LIMIT $2`,
        [vectorLiteral(embedding), Math.min(Math.max(topK * 8, 40), 200), documentType ?? null, this.datasetSha256, this.generationSha256],
      );
    });
    const byDocument = new Map<string, RankedCandidate>();
    for (const row of rows) {
      const metadata = parseMetadata(row.metadata);
      const expectedChunk = this.chunks.get(`${row.doc_id}:${row.chunk_index}`);
      const expectedDocument = this.documents.get(row.doc_id);
      const vectorScore = Number(row.score);
      if (!expectedChunk
        || !expectedDocument
        || typeof row.content !== "string"
        || Buffer.byteLength(row.content, "utf8") > 1_048_576
        || row.content !== expectedChunk.content
        || sha256Hex(Buffer.from(row.content, "utf8")) !== expectedChunk.chunkSha256
        || metadata.datasetSha256 !== this.datasetSha256
        || metadata.generationSha256 !== this.generationSha256
        || metadata.chunkSha256 !== expectedChunk.chunkSha256
        || metadata.sourceSha256 !== expectedChunk.sourceSha256
        || metadata.filename !== expectedDocument.filename
        || metadata.title !== expectedDocument.title
        || metadata.type !== expectedDocument.type
        || !Number.isFinite(vectorScore)) {
        throw new Error(`pgvector candidate failed provenance validation: ${row.doc_id}:${row.chunk_index}`);
      }
      const title = expectedDocument.title;
      const existing = byDocument.get(row.doc_id);
      if (!existing) {
        const normalizedTitle = title.normalize("NFKC").toLocaleLowerCase("ko-KR");
        const normalizedContent = row.content.normalize("NFKC").toLocaleLowerCase("ko-KR");
        byDocument.set(row.doc_id, {
          id: row.doc_id,
          type: expectedDocument.type,
          title,
          content: row.content,
          vectorScore,
          normalizedTitle,
          normalizedContent,
          normalizedHaystack: `${normalizedTitle}\n${normalizedContent}`,
        });
      } else {
        existing.content = `${existing.content}\n${row.content}`;
        existing.vectorScore = Math.max(existing.vectorScore, vectorScore);
        existing.normalizedContent = existing.content.normalize("NFKC").toLocaleLowerCase("ko-KR");
        existing.normalizedHaystack = `${existing.normalizedTitle}\n${existing.normalizedContent}`;
      }
    }
    const candidates = [...byDocument.values()];
    const queryTerms = terms(query);
    const frequencies = new Map(queryTerms.map((term) => [
      term,
      candidates.reduce((count, candidate) => count + (candidate.normalizedHaystack.includes(term) ? 1 : 0), 0),
    ]));
    const types = preferredTypes(query);
    return candidates.map((candidate) => {
      const lexical = lexicalScore(queryTerms, candidate, frequencies, candidates.length);
      const nearby = proximityScore(queryTerms, candidate);
      const typeBoost = types.has(candidate.type) ? 0.1 : 0;
      const recentBoost = recencyScore(query, candidate, candidates, types) * 0.4;
      return {
        id: candidate.id,
        type: candidate.type,
        title: candidate.title,
        score: candidate.vectorScore * 0.6 + lexical * 0.45 + nearby * 0.15 + typeBoost + recentBoost,
        snippet: candidate.content.slice(0, 420),
        datasetSha256: this.datasetSha256,
        provider: "pgvector+nomic-embed-text",
      };
    }).sort((left, right) => right.score - left.score).slice(0, topK);
  }
}
