import type {
  GraphStep,
  PlanRepair,
  PlanStep,
  PolicyDecision,
  PolicyFinding,
  QueryPlan,
  SqlStep,
  VectorStep,
} from "../core/model.ts";
import { MAX_QUESTION_BYTES, questionWithinLimit } from "../core/input-limits.ts";
import {
  matchedPolicyIds,
  POLICY_GRAPH_ID,
  POLICY_GRAPH_VERSION,
  POLICY_IDS,
} from "./catalog.ts";
import { analyzeSql } from "./sql-analyzer.ts";

const ALLOWED_TABLES = new Set([
  "departments",
  "employees",
  "clients",
  "products",
  "contracts",
  "projects",
  "sales",
  "support_tickets",
]);

const ALLOWED_RELATIONS = new Set([
  "BELONGS_TO",
  "HEAD_IS",
  "USES",
  "MANAGES_ACCOUNT",
  "HAS_PROJECT",
  "LEADS",
  "REPORTED_ISSUE",
]);

const SENSITIVE_COLUMNS = new Set(["salary", "email", "contact_name", "contact_email"]);
const ALLOWED_COLUMNS = new Set([
  "id", "name", "head_id", "created_at", "email", "position", "dept_id", "hire_date", "salary", "is_active",
  "industry", "region", "company_size", "contact_name", "contact_email", "registered_at", "category", "description",
  "price_monthly", "version", "release_date", "status", "client_id", "product_id", "manager_id", "contract_type",
  "amount", "start_date", "end_date", "contract_id", "budget", "sale_date", "quarter", "assignee_id", "title",
  "priority", "resolved_at",
]);
const UNSAFE_QUERY_INTENT = /\b(?:DROP|DELETE|TRUNCATE|ALTER|GRANT|REVOKE|PG_SLEEP|PG_READ_FILE|SHELL\.EXEC)\b|(?:테이블|데이터).*(?:삭제|지워)|(?:삭제|지워).*(?:테이블|데이터)|환경\s*변수.*출력/iu;
const MAX_SQL_BYTES = 16_384;

export function isUnsafeQueryIntent(question: string): boolean {
  return UNSAFE_QUERY_INTENT.test(question);
}

function clonePlan(plan: QueryPlan): QueryPlan {
  return structuredClone(plan);
}

function withoutTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "");
}

export interface PlanGateOptions {
  maxSteps?: number;
  maxRows?: number;
  maxVectorResults?: number;
  maxGraphHops?: number;
  maxGraphNodes?: number;
}

export class PlanGate {
  readonly maxSteps: number;
  readonly maxRows: number;
  readonly maxVectorResults: number;
  readonly maxGraphHops: number;
  readonly maxGraphNodes: number;

  constructor(options: PlanGateOptions = {}) {
    this.maxSteps = options.maxSteps ?? 6;
    this.maxRows = options.maxRows ?? 100;
    this.maxVectorResults = options.maxVectorResults ?? 10;
    this.maxGraphHops = options.maxGraphHops ?? 2;
    this.maxGraphNodes = options.maxGraphNodes ?? 50;
  }

  evaluate(plan: QueryPlan): PolicyDecision {
    const executablePlan = clonePlan(plan);
    const findings: PolicyFinding[] = [];
    const repairs: PlanRepair[] = [];
    const approvalReasons: string[] = [];

    if (!questionWithinLimit(plan.query)) {
      findings.push({
        code: "QUERY_SIZE_EXCEEDED",
        severity: "critical",
        message: `질문은 UTF-8 ${MAX_QUESTION_BYTES}바이트를 초과할 수 없습니다.`,
        repairable: false,
      });
    }

    if (isUnsafeQueryIntent(plan.query)) {
      findings.push({
        code: "QUERY_UNSAFE_INTENT",
        severity: "critical",
        message: "원문 질문에서 파괴·시스템 접근 의도가 감지되었습니다.",
        repairable: false,
      });
    }

    if (plan.steps.length === 0) {
      findings.push({
        code: "PLAN_EMPTY",
        severity: "critical",
        message: "실행 단계가 없습니다.",
        repairable: false,
      });
    }

    if (plan.steps.length > this.maxSteps) {
      findings.push({
        code: "PLAN_STEP_BUDGET_EXCEEDED",
        severity: "critical",
        message: `실행 단계 ${plan.steps.length}개가 허용 한도 ${this.maxSteps}개를 초과했습니다.`,
        repairable: false,
      });
    }

    executablePlan.steps.forEach((step) => {
      if (step.tool === "sql.query") {
        this.inspectSql(step, plan, findings, repairs, approvalReasons);
      } else if (step.tool === "vector.search") {
        this.inspectVector(step, findings, repairs);
      } else if (step.tool === "graph.traverse") {
        this.inspectGraph(step, findings, repairs);
      } else {
        findings.push({
          code: "TOOL_NOT_ALLOWED",
          stepId: (step as PlanStep).id,
          severity: "critical",
          message: `허용되지 않은 도구입니다: ${(step as PlanStep).tool}`,
          repairable: false,
        });
      }
    });

    const unrepairable = findings.some((finding) => !finding.repairable && finding.severity === "critical");
    const decision = unrepairable
      ? "DENY"
      : approvalReasons.length > 0
        ? "APPROVAL_REQUIRED"
        : repairs.length > 0
          ? "REPAIR"
          : "ALLOW";

    const matchedCodes = [
      ...findings.map((finding) => finding.code),
      ...repairs.map((repair) => repair.code),
    ];

    return {
      decision,
      originalPlan: plan,
      executablePlan: decision === "DENY" ? undefined : executablePlan,
      findings,
      repairs,
      approvalReasons,
      policyGraph: {
        id: POLICY_GRAPH_ID,
        version: POLICY_GRAPH_VERSION,
        evaluatedPolicyIds: [...POLICY_IDS],
        matchedPolicyIds: matchedPolicyIds(matchedCodes),
      },
    };
  }

  private inspectSql(
    step: SqlStep,
    plan: QueryPlan,
    findings: PolicyFinding[],
    repairs: PlanRepair[],
    approvalReasons: string[],
  ): void {
    let sql = step.input.sql.trim();

    if (Buffer.byteLength(sql, "utf8") > MAX_SQL_BYTES) {
      findings.push({
        code: "SQL_COMPLEXITY_BUDGET_EXCEEDED",
        stepId: step.id,
        severity: "critical",
        message: `SQL은 UTF-8 ${MAX_SQL_BYTES}바이트를 초과할 수 없습니다.`,
        repairable: false,
      });
      return;
    }

    if (/--|\/\*/.test(sql)) {
      findings.push({
        code: "SQL_COMMENT_BLOCKED",
        stepId: step.id,
        severity: "critical",
        message: "SQL 주석은 정책 우회를 막기 위해 허용하지 않습니다.",
        repairable: false,
      });
    }

    const analysis = analyzeSql(sql);

    if (!analysis.parsed) {
      findings.push({
        code: "SQL_PARSE_ERROR",
        stepId: step.id,
        severity: "critical",
        message: "PostgreSQL 구문 분석에 실패했습니다.",
        repairable: false,
      });
    }

    if (analysis.parsed && analysis.statementCount !== 1) {
      findings.push({
        code: "SQL_MULTIPLE_STATEMENTS",
        stepId: step.id,
        severity: "critical",
        message: "한 번에 하나의 SQL 문만 실행할 수 있습니다.",
        repairable: false,
      });
    }

    if (analysis.parsed && !analysis.readOnlySelect) {
      findings.push({
        code: "SQL_AST_NOT_READ_ONLY",
        stepId: step.id,
        severity: "critical",
        message: "AST 기준 단일 읽기 전용 SELECT만 허용합니다.",
        repairable: false,
      });
    }

    if (analysis.disallowedFunctions.length > 0) {
      findings.push({
        code: "SQL_FUNCTION_NOT_ALLOWED",
        stepId: step.id,
        severity: "critical",
        message: `허용 목록 밖의 SQL 함수입니다: ${analysis.disallowedFunctions.join(", ")}`,
        repairable: false,
      });
    }

    if (analysis.keywords.length > 0) {
      findings.push({
        code: "SQL_KEYWORD_EXPRESSION_NOT_ALLOWED",
        stepId: step.id,
        severity: "critical",
        message: `세션·시스템 SQL 키워드 표현식은 허용하지 않습니다: ${analysis.keywords.join(", ")}`,
        repairable: false,
      });
    }

    const blockedSchemas = analysis.schemas.filter((schema) => schema !== "public");
    if (blockedSchemas.length > 0) {
      findings.push({
        code: "SQL_SCHEMA_NOT_ALLOWED",
        stepId: step.id,
        severity: "critical",
        message: `허용되지 않은 스키마입니다: ${blockedSchemas.join(", ")}`,
        repairable: false,
      });
    }

    if (analysis.rowLock) {
      findings.push({
        code: "SQL_ROW_LOCK_BLOCKED",
        stepId: step.id,
        severity: "critical",
        message: "FOR UPDATE/SHARE 계열 행 잠금은 허용하지 않습니다.",
        repairable: false,
      });
    }

    if (analysis.tableColumnAliasList) {
      findings.push({
        code: "SQL_TABLE_COLUMN_ALIAS_BLOCKED",
        stepId: step.id,
        severity: "critical",
        message: "기본 테이블의 열 별칭 목록은 민감 필드 우회를 막기 위해 허용하지 않습니다.",
        repairable: false,
      });
    }

    if (analysis.joinUsingColumns.length > 0) {
      findings.push({
        code: "SQL_JOIN_USING_BLOCKED",
        stepId: step.id,
        severity: "critical",
        message: `JOIN USING은 열 권한 우회를 막기 위해 허용하지 않습니다: ${analysis.joinUsingColumns.join(", ")}`,
        repairable: false,
      });
    }

    if (
      analysis.crossJoin
      || analysis.relationCount > 3
      || analysis.astNodeCount > 512
      || analysis.maxAstDepth > 32
      || analysis.recursiveCte
    ) {
      findings.push({
        code: "SQL_COMPLEXITY_BUDGET_EXCEEDED",
        stepId: step.id,
        severity: "critical",
        message: "카티션 곱 또는 3개를 초과하는 물리 테이블 참조는 허용하지 않습니다.",
        repairable: false,
      });
    }

    if (analysis.wildcardProjection) {
      findings.push({
        code: "SQL_WILDCARD_PROJECTION",
        stepId: step.id,
        severity: "critical",
        message: "데이터 최소화를 위해 SELECT *를 허용하지 않습니다.",
        repairable: false,
      });
    }

    if (analysis.wholeRowProjection) {
      findings.push({
        code: "SQL_WHOLE_ROW_PROJECTION",
        stepId: step.id,
        severity: "critical",
        message: "복합행 표현을 통한 전체 열 조회·조건 평가는 허용하지 않습니다.",
        repairable: false,
      });
    }

    const unknownTables = analysis.tables.filter((name) => !ALLOWED_TABLES.has(name));
    if (unknownTables.length > 0) {
      findings.push({
        code: "SQL_UNKNOWN_TABLE",
        stepId: step.id,
        severity: "critical",
        message: `허용 목록 밖의 테이블입니다: ${[...new Set(unknownTables)].join(", ")}`,
        repairable: false,
      });
    }

    const allowedAliasReferences = new Set(analysis.allowedAliasReferences);
    const invalidAliasReferences = new Set(analysis.invalidAliasReferences);
    const unknownColumns = analysis.columns.filter((name) =>
      name !== "*"
      && !ALLOWED_COLUMNS.has(name)
      && !(allowedAliasReferences.has(name) && !invalidAliasReferences.has(name))
    );
    if (unknownColumns.length > 0) {
      findings.push({
        code: "SQL_UNKNOWN_COLUMN",
        stepId: step.id,
        severity: "critical",
        message: `허용 목록 밖의 열 또는 시스템 메타데이터입니다: ${[...new Set(unknownColumns)].join(", ")}`,
        repairable: false,
      });
    }

    const accessesSensitiveColumn = analysis.columns.some((column) => SENSITIVE_COLUMNS.has(column));
    if (accessesSensitiveColumn && plan.actor.role === "viewer") {
      findings.push({
        code: "SQL_SENSITIVE_FIELD_DENIED",
        stepId: step.id,
        severity: "critical",
        message: "viewer 역할은 이메일·연봉 등 제한 필드를 조회할 수 없습니다.",
        repairable: false,
      });
    } else if (accessesSensitiveColumn && plan.actor.role === "analyst") {
      const reason = `${step.id}: 이메일·연봉 등 제한 필드 조회에는 승인이 필요합니다.`;
      approvalReasons.push(reason);
      findings.push({
        code: "SQL_SENSITIVE_FIELD_APPROVAL",
        stepId: step.id,
        severity: "warning",
        message: reason,
        repairable: true,
      });
    }

    const limitMatch = sql.match(/\bLIMIT\s+(\d+)\b/i);
    if (!limitMatch) {
      sql = `${withoutTrailingSemicolon(sql)} LIMIT ${this.maxRows}`;
      step.input.sql = sql;
      repairs.push({
        code: "SQL_LIMIT_ADDED",
        stepId: step.id,
        description: `결과 상한 LIMIT ${this.maxRows}을 추가했습니다.`,
      });
    } else {
      const requested = Number(limitMatch[1]);
      if (requested > this.maxRows) {
        step.input.sql = withoutTrailingSemicolon(sql).replace(/\bLIMIT\s+\d+\b/i, `LIMIT ${this.maxRows}`);
        repairs.push({
          code: "SQL_LIMIT_CLAMPED",
          stepId: step.id,
          description: `LIMIT ${requested}을 ${this.maxRows}으로 축소했습니다.`,
        });
      }
    }

    const requestedMaxRows = step.input.maxRows ?? this.maxRows;
    const allowedMaxRows = Number.isFinite(requestedMaxRows)
      ? Math.min(Math.max(Math.trunc(requestedMaxRows), 1), this.maxRows)
      : this.maxRows;
    step.input.maxRows = allowedMaxRows;
    if (requestedMaxRows !== allowedMaxRows) {
      repairs.push({
        code: "SQL_MAX_ROWS_CLAMPED",
        stepId: step.id,
        description: `maxRows를 ${allowedMaxRows}으로 조정했습니다.`,
      });
    }
  }

  private inspectVector(step: VectorStep, findings: PolicyFinding[], repairs: PlanRepair[]): void {
    if (!step.input.query.trim()) {
      findings.push({
        code: "VECTOR_QUERY_EMPTY",
        stepId: step.id,
        severity: "critical",
        message: "검색어가 비어 있습니다.",
        repairable: false,
      });
    }

    if (!questionWithinLimit(step.input.query)) {
      findings.push({
        code: "VECTOR_QUERY_SIZE_EXCEEDED",
        stepId: step.id,
        severity: "critical",
        message: `벡터 검색어는 UTF-8 ${MAX_QUESTION_BYTES}바이트를 초과할 수 없습니다.`,
        repairable: false,
      });
    }

    const requested = step.input.topK ?? 5;
    const repaired = Math.min(Math.max(requested, 1), this.maxVectorResults);
    if (requested !== repaired) {
      step.input.topK = repaired;
      repairs.push({
        code: "VECTOR_TOP_K_CLAMPED",
        stepId: step.id,
        description: `topK ${requested}을 ${repaired}로 조정했습니다.`,
      });
    } else if (step.input.topK === undefined) {
      step.input.topK = repaired;
    }
  }

  private inspectGraph(step: GraphStep, findings: PolicyFinding[], repairs: PlanRepair[]): void {
    const startName = step.input.startName?.trim();
    const startType = step.input.startType?.trim();
    if (!startName && !startType) {
      findings.push({
        code: "GRAPH_START_EMPTY",
        stepId: step.id,
        severity: "critical",
        message: "그래프 시작 개체가 비어 있습니다.",
        repairable: false,
      });
    }

    if (step.input.mode === "rank" && !startType) {
      findings.push({
        code: "GRAPH_RANK_TYPE_REQUIRED",
        stepId: step.id,
        severity: "critical",
        message: "관계 집계에는 집계 대상 노드 유형이 필요합니다.",
        repairable: false,
      });
    }

    const unknownRelations = step.input.path
      .map((hop) => hop.relation)
      .filter((relation) => !ALLOWED_RELATIONS.has(relation));
    if (unknownRelations.length > 0) {
      findings.push({
        code: "GRAPH_RELATION_NOT_ALLOWED",
        stepId: step.id,
        severity: "critical",
        message: `허용 목록 밖의 관계입니다: ${[...new Set(unknownRelations)].join(", ")}`,
        repairable: false,
      });
    }

    const requestedHops = step.input.maxHops ?? step.input.path.length;
    const allowedHops = Math.min(requestedHops, this.maxGraphHops);
    if (requestedHops !== allowedHops || step.input.path.length > this.maxGraphHops) {
      step.input.maxHops = allowedHops;
      step.input.path = step.input.path.slice(0, allowedHops);
      repairs.push({
        code: "GRAPH_HOPS_CLAMPED",
        stepId: step.id,
        description: `그래프 탐색 깊이를 ${allowedHops}홉으로 제한했습니다.`,
      });
    } else if (step.input.maxHops === undefined) {
      step.input.maxHops = allowedHops;
    }

    const requestedNodes = step.input.maxNodes ?? 20;
    const allowedNodes = Math.min(Math.max(requestedNodes, 1), this.maxGraphNodes);
    if (requestedNodes !== allowedNodes) {
      step.input.maxNodes = allowedNodes;
      repairs.push({
        code: "GRAPH_NODE_BUDGET_CLAMPED",
        stepId: step.id,
        description: `그래프 결과 노드 상한을 ${allowedNodes}개로 조정했습니다.`,
      });
    } else if (step.input.maxNodes === undefined) {
      step.input.maxNodes = allowedNodes;
    }
  }
}
