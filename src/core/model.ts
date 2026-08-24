export const TOOL_NAMES = ["sql.query", "vector.search", "graph.traverse"] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
export type ActorRole = "viewer" | "analyst" | "hr_analyst" | "admin";
export type DecisionKind = "ALLOW" | "REPAIR" | "DENY" | "APPROVAL_REQUIRED";
export type Direction = "out" | "in";
export type GraphMode = "traverse" | "rank";

export interface Actor {
  id: string;
  role: ActorRole;
}

export interface SqlStep {
  id: string;
  tool: "sql.query";
  rationale: string;
  input: {
    sql: string;
    maxRows?: number;
  };
}

export interface VectorStep {
  id: string;
  tool: "vector.search";
  rationale: string;
  input: {
    query: string;
    topK?: number;
    documentType?: string;
  };
}

export interface GraphHop {
  relation: string;
  direction: Direction;
}

export interface GraphStep {
  id: string;
  tool: "graph.traverse";
  rationale: string;
  input: {
    mode?: GraphMode;
    startName?: string;
    startType?: string;
    startWhere?: Record<string, string | number | boolean>;
    path: GraphHop[];
    maxHops?: number;
    maxNodes?: number;
  };
}

export type PlanStep = SqlStep | VectorStep | GraphStep;

export interface QueryPlan {
  planVersion: "1.0";
  query: string;
  actor: Actor;
  steps: PlanStep[];
}

export interface PolicyFinding {
  code: string;
  stepId?: string;
  severity: "info" | "warning" | "critical";
  message: string;
  repairable: boolean;
}

export interface PlanRepair {
  code: string;
  stepId: string;
  description: string;
}

export interface PolicyDecision {
  decision: DecisionKind;
  originalPlan: QueryPlan;
  executablePlan?: QueryPlan;
  findings: PolicyFinding[];
  repairs: PlanRepair[];
  approvalReasons: string[];
  policyGraph: {
    id: "policygraph:companyx";
    version: "1.0";
    evaluatedPolicyIds: string[];
    matchedPolicyIds: string[];
  };
}

export interface EvidenceItem {
  evidenceId: string;
  stepId: string;
  tool: ToolName | "plan-gate";
  source: string;
  kind: "table" | "passage" | "graph_path" | "policy";
  score?: number;
  payload: unknown;
}

export interface ToolExecution {
  stepId: string;
  tool: ToolName;
  durationMs: number;
  evidence: EvidenceItem[];
}

export interface AnswerClaim {
  claimId: string;
  text: string;
  evidenceIds: string[];
}

export interface AnswerEnvelope {
  text: string;
  claims: AnswerClaim[];
  citations: Array<{ evidenceId: string; source: string }>;
  verified: boolean;
  generator: "deterministic" | "ollama";
}

export interface RunResult {
  runId: string;
  status: "executed" | "denied" | "approval_required" | "failed";
  policy: PolicyDecision;
  executions: ToolExecution[];
  evidence: EvidenceItem[];
  answer?: AnswerEnvelope;
}

export interface RunContext {
  approvalReceipt?: string;
}
