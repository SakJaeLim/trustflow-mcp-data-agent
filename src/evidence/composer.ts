import { sha256 } from "../core/hash.ts";
import type { AnswerClaim, AnswerEnvelope, EvidenceItem } from "../core/model.ts";

function compactValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return new Intl.NumberFormat("ko-KR").format(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function tableClaim(evidence: EvidenceItem): string {
  const payload = evidence.payload as { rowCount?: number; rows?: Record<string, unknown>[] };
  const rows = payload.rows ?? [];
  if (rows.length === 0) return "조건에 맞는 결과가 없습니다.";
  return rows.slice(0, 8).map((row) =>
    Object.entries(row).map(([key, value]) => `${key}: ${compactValue(value)}`).join(", ")
  ).join("\n");
}

function passageClaim(evidence: EvidenceItem): string {
  const payload = evidence.payload as { title?: string; snippet?: string };
  const clean = (payload.snippet ?? "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
  const summary = clean.length > 240 ? `${clean.slice(0, 240).trim()}…` : clean;
  return `${payload.title ?? evidence.source}\n${summary}`.trim();
}

function graphClaim(evidence: EvidenceItem): string {
  const payload = evidence.payload as {
    resultNodes?: Array<{ name?: string }>;
    ranking?: Array<{ node?: { name?: string }; count?: number }>;
  };
  if (payload.ranking?.length) {
    return payload.ranking.map((item) => `${item.node?.name ?? "unknown"}: ${item.count ?? 0}건`).join("\n");
  }
  const names = (payload.resultNodes ?? []).map((node) => node.name).filter(Boolean);
  return names.length > 0 ? names.join(", ") : "관계 조건에 맞는 결과가 없습니다.";
}

function claimText(evidence: EvidenceItem): string {
  if (evidence.kind === "table") return tableClaim(evidence);
  if (evidence.kind === "passage") return passageClaim(evidence);
  if (evidence.kind === "graph_path") return graphClaim(evidence);
  return "";
}

export function composeAnswer(question: string, evidence: EvidenceItem[]): AnswerEnvelope {
  const usable = evidence.filter((item) => item.kind !== "policy");
  const answerEvidence = usable[0]?.kind === "passage" ? usable.slice(0, 2) : usable;
  const claims: AnswerClaim[] = answerEvidence.map((item, index) => ({
    claimId: `claim_${sha256({ question, evidenceId: item.evidenceId, index }).slice(0, 12)}`,
    text: claimText(item),
    evidenceIds: [item.evidenceId],
  })).filter((claim) => claim.text.length > 0);
  const knownEvidence = new Set(evidence.map((item) => item.evidenceId));
  const citedEvidence = new Set(claims.flatMap((claim) => claim.evidenceIds));
  const verified = claims.length > 0
    && claims.every((claim) => claim.evidenceIds.length > 0 && claim.evidenceIds.every((id) => knownEvidence.has(id)));

  return {
    text: claims.length > 0 ? claims.map((claim) => claim.text).join("\n\n") : "근거를 찾지 못했습니다.",
    claims,
    citations: usable
      .filter((item) => citedEvidence.has(item.evidenceId))
      .map((item) => ({ evidenceId: item.evidenceId, source: item.source })),
    verified,
    generator: "deterministic",
  };
}
