export interface PolicyNode {
  id: string;
  title: string;
  target: "plan" | "tool" | "sql" | "vector" | "graph" | "audit" | "network";
  effect: "allow" | "repair" | "deny" | "approval";
  description: string;
}

export const POLICY_GRAPH_ID = "policygraph:companyx" as const;
export const POLICY_GRAPH_VERSION = "1.0" as const;

export const POLICY_NODES: readonly PolicyNode[] = [
  { id: "POL-PLAN-001", title: "Bounded plan", target: "plan", effect: "deny", description: "Plans must contain one to six registered steps." },
  { id: "POL-PLAN-002", title: "Unsafe intent rejection", target: "plan", effect: "deny", description: "High-confidence destructive and system-access intent is rejected even if a model rewrites the tool step." },
  { id: "POL-TOOL-001", title: "Registered tools only", target: "tool", effect: "deny", description: "Only SQL, vector, and graph executors are callable." },
  { id: "POL-SQL-001", title: "AST-verified SELECT only", target: "sql", effect: "deny", description: "Only one AST-verified read-only SELECT statement with allow-listed functions is allowed." },
  { id: "POL-SQL-002", title: "Known schema", target: "sql", effect: "deny", description: "Tables must belong to the Company-X allow-list." },
  { id: "POL-SQL-003", title: "Data minimization", target: "sql", effect: "deny", description: "Wildcard projections are blocked." },
  { id: "POL-SQL-004", title: "Row budget", target: "sql", effect: "repair", description: "Result rows are capped at 100." },
  { id: "POL-SQL-005", title: "Sensitive fields", target: "sql", effect: "approval", description: "Salary and contact data require an authorized role or approval." },
  { id: "POL-VEC-001", title: "Evidence budget", target: "vector", effect: "repair", description: "Vector results are bounded to ten passages." },
  { id: "POL-GRAPH-001", title: "Known relations", target: "graph", effect: "deny", description: "Only declared Company-X relations may be traversed." },
  { id: "POL-GRAPH-002", title: "Traversal budget", target: "graph", effect: "repair", description: "Graph depth and result nodes are bounded." },
  { id: "POL-AUDIT-001", title: "Evidence ledger", target: "audit", effect: "deny", description: "Every decision and tool call must be appended to the hash-chained ledger." },
  { id: "POL-NET-001", title: "Local execution", target: "network", effect: "deny", description: "Runtime tool execution must not call external networks." },
] as const;

export const POLICY_IDS = POLICY_NODES.map((policy) => policy.id);

const FINDING_TO_POLICY: Record<string, string> = {
  PLAN_EMPTY: "POL-PLAN-001",
  PLAN_STEP_BUDGET_EXCEEDED: "POL-PLAN-001",
  QUERY_UNSAFE_INTENT: "POL-PLAN-002",
  QUERY_SIZE_EXCEEDED: "POL-PLAN-001",
  TOOL_NOT_ALLOWED: "POL-TOOL-001",
  SQL_COMMENT_BLOCKED: "POL-SQL-001",
  SQL_MULTIPLE_STATEMENTS: "POL-SQL-001",
  SQL_SELECT_ONLY: "POL-SQL-001",
  SQL_FORBIDDEN_OPERATION: "POL-SQL-001",
  SQL_PARSE_ERROR: "POL-SQL-001",
  SQL_AST_NOT_READ_ONLY: "POL-SQL-001",
  SQL_FUNCTION_NOT_ALLOWED: "POL-SQL-001",
  SQL_KEYWORD_EXPRESSION_NOT_ALLOWED: "POL-SQL-001",
  SQL_SCHEMA_NOT_ALLOWED: "POL-SQL-001",
  SQL_ROW_LOCK_BLOCKED: "POL-SQL-001",
  SQL_TABLE_COLUMN_ALIAS_BLOCKED: "POL-SQL-001",
  SQL_JOIN_USING_BLOCKED: "POL-SQL-001",
  SQL_COMPLEXITY_BUDGET_EXCEEDED: "POL-SQL-001",
  SQL_UNKNOWN_TABLE: "POL-SQL-002",
  SQL_UNKNOWN_COLUMN: "POL-SQL-002",
  SQL_WILDCARD_PROJECTION: "POL-SQL-003",
  SQL_WHOLE_ROW_PROJECTION: "POL-SQL-003",
  SQL_LIMIT_ADDED: "POL-SQL-004",
  SQL_LIMIT_CLAMPED: "POL-SQL-004",
  SQL_MAX_ROWS_CLAMPED: "POL-SQL-004",
  SQL_SENSITIVE_FIELD_APPROVAL: "POL-SQL-005",
  SQL_SENSITIVE_FIELD_DENIED: "POL-SQL-005",
  VECTOR_TOP_K_CLAMPED: "POL-VEC-001",
  VECTOR_QUERY_SIZE_EXCEEDED: "POL-VEC-001",
  GRAPH_RELATION_NOT_ALLOWED: "POL-GRAPH-001",
  GRAPH_HOPS_CLAMPED: "POL-GRAPH-002",
  GRAPH_NODE_BUDGET_CLAMPED: "POL-GRAPH-002",
};

export function matchedPolicyIds(codes: string[]): string[] {
  return [...new Set(codes.map((code) => FINDING_TO_POLICY[code]).filter((id): id is string => Boolean(id)))];
}
