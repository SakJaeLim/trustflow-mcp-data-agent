import type { DocumentSearch, DocumentSearchHit } from "../tools/local-vector-search.ts";
import type { Embedder } from "./ollama-embedder.ts";
import { PostgresDatabase } from "./postgres.ts";

interface ChunkRow {
  doc_id: string;
  content: string;
  metadata: Record<string, unknown> | string;
  score: number | string;
}

const STOP_WORDS = new Set([
  "알려줘", "궁금해", "관련", "내용", "어떻게", "있어", "있었어", "뭐야", "방법", "보여줘", "되어",
]);
const KOREAN_PARTICLES = ["으로부터", "에서부터", "에게서", "으로", "에서", "에게", "까지", "부터", "처럼", "보다", "께서", "와", "과", "의", "에", "은", "는", "이", "가", "을", "를", "도", "만"];

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
  return (value.normalize("NFKC").toLocaleLowerCase("ko-KR").match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [])
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term))
    .map(normalizeTerm)
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
}

interface RankedCandidate {
  id: string;
  type: string;
  title: string;
  content: string;
  vectorScore: number;
}

function lexicalScore(queryTerms: string[], candidate: RankedCandidate, candidates: RankedCandidate[]): number {
  if (queryTerms.length === 0) return 0;
  const title = candidate.title;
  const content = candidate.content;
  const normalizedTitle = title.normalize("NFKC").toLocaleLowerCase("ko-KR");
  const normalizedContent = content.normalize("NFKC").toLocaleLowerCase("ko-KR");
  let score = 0;
  let maximum = 0;
  for (const term of queryTerms) {
    const documentFrequency = candidates.filter((item) =>
      `${item.title}\n${item.content}`.normalize("NFKC").toLocaleLowerCase("ko-KR").includes(term)
    ).length;
    const inverseDocumentFrequency = Math.log((candidates.length + 1) / (documentFrequency + 0.5)) + 1;
    maximum += inverseDocumentFrequency * 2;
    if (normalizedTitle.includes(term)) score += inverseDocumentFrequency * 2;
    else if (normalizedContent.includes(term)) score += inverseDocumentFrequency * 1.25;
  }
  return maximum === 0 ? 0 : score / maximum;
}

function proximityScore(queryTerms: string[], candidate: RankedCandidate): number {
  if (queryTerms.length < 2) return 0;
  const haystack = `${candidate.title}\n${candidate.content}`.normalize("NFKC").toLocaleLowerCase("ko-KR");
  let nearbyPairs = 0;
  for (let index = 0; index < queryTerms.length - 1; index += 1) {
    const left = haystack.indexOf(queryTerms[index] ?? "");
    const right = haystack.indexOf(queryTerms[index + 1] ?? "");
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
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  return value;
}

export class PgVectorDocumentSearch implements DocumentSearch {
  private readonly database: PostgresDatabase;
  private readonly embedder: Embedder;

  constructor(database: PostgresDatabase, embedder: Embedder) {
    this.database = database;
    this.embedder = embedder;
  }

  async search(query: string, topK: number, documentType?: string): Promise<DocumentSearchHit[]> {
    const [embedding] = await this.embedder.embed([`search_query: ${query}`]);
    if (!embedding) return [];
    const rows = await this.database.queryRows<ChunkRow>(
      `SELECT doc_id, content, metadata,
              1 - (embedding <=> $1::vector) AS score
         FROM document_chunks
        WHERE embedding IS NOT NULL
          AND ($3::text IS NULL OR metadata->>'type' = $3)
        ORDER BY embedding <=> $1::vector
        LIMIT $2`,
      [vectorLiteral(embedding), Math.min(Math.max(topK * 8, 40), 200), documentType ?? null],
    );
    const byDocument = new Map<string, RankedCandidate>();
    for (const row of rows) {
      const metadata = parseMetadata(row.metadata);
      const title = String(metadata.title ?? row.doc_id);
      const vectorScore = Number(row.score);
      const existing = byDocument.get(row.doc_id);
      if (!existing) {
        byDocument.set(row.doc_id, { id: row.doc_id, type: String(metadata.type ?? "unknown"), title, content: row.content, vectorScore });
      } else {
        existing.content = `${existing.content}\n${row.content}`;
        existing.vectorScore = Math.max(existing.vectorScore, vectorScore);
      }
    }
    const candidates = [...byDocument.values()];
    const queryTerms = [...new Set(terms(query))];
    const types = preferredTypes(query);
    return candidates.map((candidate) => {
      const lexical = lexicalScore(queryTerms, candidate, candidates);
      const nearby = proximityScore(queryTerms, candidate);
      const typeBoost = types.has(candidate.type) ? 0.1 : 0;
      const recentBoost = recencyScore(query, candidate, candidates, types) * 0.4;
      return {
        id: candidate.id,
        type: candidate.type,
        title: candidate.title,
        score: candidate.vectorScore * 0.6 + lexical * 0.45 + nearby * 0.15 + typeBoost + recentBoost,
        snippet: candidate.content.slice(0, 420),
      };
    }).sort((left, right) => right.score - left.score).slice(0, topK);
  }
}
