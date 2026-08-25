import { parse, type Statement } from "pgsql-ast-parser";

const ALLOWED_FUNCTIONS = new Set([
  "abs",
  "avg",
  "coalesce",
  "count",
  "date_part",
  "date_trunc",
  "greatest",
  "least",
  "lower",
  "max",
  "min",
  "nullif",
  "round",
  "sum",
  "upper",
]);

interface AstNode {
  type?: string;
  name?: unknown;
  schema?: unknown;
  function?: unknown;
  columns?: unknown;
  columnNames?: unknown;
  alias?: unknown;
  value?: unknown;
  keyword?: unknown;
  on?: unknown;
  for?: unknown;
  from?: unknown;
  join?: unknown;
  bind?: unknown;
  in?: unknown;
  left?: unknown;
  right?: unknown;
  op?: unknown;
  where?: unknown;
  having?: unknown;
  groupBy?: unknown;
  orderBy?: unknown;
  by?: unknown;
  statement?: unknown;
  [key: string]: unknown;
}

export interface SqlAnalysis {
  parsed: boolean;
  parseError?: string;
  statementCount: number;
  readOnlySelect: boolean;
  tables: string[];
  columns: string[];
  projectionColumns: string[];
  functions: string[];
  selectAliases: string[];
  allowedAliasReferences: string[];
  invalidAliasReferences: string[];
  keywords: string[];
  schemas: string[];
  wildcardProjection: boolean;
  wholeRowProjection: boolean;
  rowLock: boolean;
  tableColumnAliasList: boolean;
  joinUsingColumns: string[];
  relationCount: number;
  astNodeCount: number;
  maxAstDepth: number;
  recursiveCte: boolean;
  crossJoin: boolean;
  disallowedFunctions: string[];
}

function collectRefNames(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectRefNames(item, names));
    return;
  }
  const node = object(value);
  if (!node) return;
  if (node.type === "ref" && typeof node.name === "string") names.add(node.name);
  Object.values(node).forEach((item) => collectRefNames(item, names));
}

function collectQualifiedRefTables(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectQualifiedRefTables(item, names));
    return;
  }
  const node = object(value);
  if (!node) return;
  if (node.type === "ref") {
    const table = qName(node.table).name;
    if (table) names.add(table);
  }
  Object.values(node).forEach((item) => collectQualifiedRefTables(item, names));
}

function containsDisjunction(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsDisjunction);
  const node = object(value);
  if (!node) return false;
  if (node.type === "binary" && typeof node.op === "string" && node.op.toUpperCase() === "OR") return true;
  return Object.values(node).some(containsDisjunction);
}

function containsCrossRelationEquality(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCrossRelationEquality);
  const node = object(value);
  if (!node) return false;
  if (node.type === "binary" && node.op === "=") {
    const leftRelations = new Set<string>();
    const rightRelations = new Set<string>();
    collectQualifiedRefTables(node.left, leftRelations);
    collectQualifiedRefTables(node.right, rightRelations);
    if ([...leftRelations].some((left) => [...rightRelations].some((right) => left !== right))) return true;
  }
  return Object.values(node).some(containsCrossRelationEquality);
}

function containsUnsafeWildcard(value: unknown, countArgument = false): boolean {
  if (Array.isArray(value)) return value.some((item) => containsUnsafeWildcard(item, countArgument));
  const node = object(value);
  if (!node) return false;
  if (node.type === "ref" && node.name === "*") {
    return !countArgument || Boolean(qName(node.table).name);
  }
  if (node.type === "call" && qName(node.function).name === "count") {
    return Object.entries(node).some(([key, item]) => containsUnsafeWildcard(item, key === "args"));
  }
  return Object.values(node).some((item) => containsUnsafeWildcard(item, false));
}

interface AstMetrics {
  count: number;
  depth: number;
  recursive: boolean;
}

function astMetrics(value: unknown, depth = 0): AstMetrics {
  if (Array.isArray(value)) {
    return value.reduce<AstMetrics>((current, item) => {
      const next = astMetrics(item, depth);
      return {
        count: current.count + next.count,
        depth: Math.max(current.depth, next.depth),
        recursive: current.recursive || next.recursive,
      };
    }, { count: 0, depth, recursive: false });
  }
  const node = object(value);
  if (!node) return { count: 0, depth, recursive: false };
  const nested = Object.values(node).reduce<AstMetrics>((current, item) => {
    const next = astMetrics(item, depth + 1);
    return {
      count: current.count + next.count,
      depth: Math.max(current.depth, next.depth),
      recursive: current.recursive || next.recursive,
    };
  }, { count: 0, depth, recursive: false });
  return {
    count: nested.count + 1,
    depth: Math.max(depth, nested.depth),
    recursive: node.type === "with recursive" || nested.recursive,
  };
}

function object(value: unknown): AstNode | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as AstNode : undefined;
}

function qName(value: unknown): { name?: string; schema?: string } {
  const node = object(value);
  return {
    // pgsql-ast-parser already folds unquoted PostgreSQL identifiers to lower case
    // and preserves quoted identifiers. Folding again would conflate distinct names.
    name: typeof node?.name === "string" ? node.name : undefined,
    schema: typeof node?.schema === "string" ? node.schema : undefined,
  };
}

function isReadOnlySelect(statement: unknown): boolean {
  const node = object(statement);
  if (!node?.type) return false;
  if (node.type === "select") return true;
  if (node.type === "union" || node.type === "union all") {
    return isReadOnlySelect(node.left) && isReadOnlySelect(node.right);
  }
  if (node.type === "with") {
    const bindings = Array.isArray(node.bind) ? node.bind : [];
    return bindings.every((binding) => isReadOnlySelect(object(binding)?.statement)) && isReadOnlySelect(node.in);
  }
  if (node.type === "with recursive") return false;
  return false;
}

function collectCteNames(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectCteNames(item, names));
    return;
  }
  const node = object(value);
  if (!node) return;
  if (node.type === "with" && Array.isArray(node.bind)) {
    for (const binding of node.bind) {
      const alias = qName(object(binding)?.alias).name;
      if (alias) names.add(alias);
    }
  } else if (node.type === "with recursive") {
    const alias = qName(node.alias).name;
    if (alias) names.add(alias);
  }
  Object.values(node).forEach((item) => collectCteNames(item, names));
}

function collectRelationNames(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectRelationNames(item, names));
    return;
  }
  const node = object(value);
  if (!node) return;
  if (node.type === "table") {
    const table = object(node.name);
    if (typeof table?.name === "string") names.add(table.name);
    if (typeof table?.alias === "string") names.add(table.alias);
  }
  Object.values(node).forEach((item) => collectRelationNames(item, names));
}

function containsWholeRowReference(value: unknown, relationNames: Set<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => containsWholeRowReference(item, relationNames));
  const node = object(value);
  if (!node) return false;
  if (
    node.type === "ref"
    && typeof node.name === "string"
    && node.name !== "*"
    && relationNames.has(node.name)
  ) return true;
  return Object.values(node).some((item) => containsWholeRowReference(item, relationNames));
}

function inspect(
  value: unknown,
  result: {
    tables: Set<string>;
    columns: Set<string>;
    projectionColumns: Set<string>;
    functions: Set<string>;
    selectAliases: Set<string>;
    allowedAliasReferences: Set<string>;
    invalidAliasReferences: Set<string>;
    keywords: Set<string>;
    schemas: Set<string>;
    wildcardProjection: boolean;
    wholeRowProjection: boolean;
    rowLock: boolean;
    tableColumnAliasList: boolean;
    joinUsingColumns: Set<string>;
    relationCount: number;
    crossJoin: boolean;
  },
  cteNames: Set<string>,
  relationNames: Set<string>,
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => inspect(item, result, cteNames, relationNames));
    return;
  }
  const node = object(value);
  if (!node) return;

  if (node.type === "with" && Array.isArray(node.bind)) {
    const visibleCtes = new Set(cteNames);
    for (const binding of node.bind) {
      inspect(object(binding)?.statement, result, visibleCtes, relationNames);
      const alias = qName(object(binding)?.alias).name;
      if (alias) visibleCtes.add(alias);
    }
    inspect(node.in, result, visibleCtes, relationNames);
    return;
  }

  if (node.type === "table") {
    const name = qName(node.name);
    if (name.name && (name.schema || !cteNames.has(name.name))) {
      result.tables.add(name.name);
    }
    if (name.schema) result.schemas.add(name.schema);
    if (Array.isArray(object(node.name)?.columnNames) && (object(node.name)?.columnNames as unknown[]).length > 0) {
      result.tableColumnAliasList = true;
    }
  }
  if (node.type === "ref") {
    if (typeof node.name === "string") result.columns.add(node.name);
    const table = qName(node.table);
    if (table.schema) result.schemas.add(table.schema);
  }
  if (node.type === "call") {
    const name = qName(node.function);
    if (name.name) result.functions.add(name.name);
    if (name.schema) result.schemas.add(name.schema);
  }
  if (node.type === "keyword" && typeof node.keyword === "string") {
    result.keywords.add(node.keyword.toLocaleLowerCase("en-US"));
  }
  const join = object(node.join);
  if (join) {
    if (typeof join.type === "string" && join.type.toLocaleLowerCase("en-US").includes("cross")) {
      result.crossJoin = true;
    }
    if (Array.isArray(join.using)) {
      for (const value of join.using) {
        const name = qName(value).name;
        if (name) result.joinUsingColumns.add(name);
      }
    }
    const predicate = object(join.on);
    if (predicate?.type === "boolean" && predicate.value === true) result.crossJoin = true;
    if (predicate) {
      const referencedRelations = new Set<string>();
      collectQualifiedRefTables(predicate, referencedRelations);
      if (referencedRelations.size < 2 || containsDisjunction(predicate) || !containsCrossRelationEquality(predicate)) {
        result.crossJoin = true;
      }
    }
  }
  if (node.type === "select") {
    if (node.for) result.rowLock = true;
    const columns = Array.isArray(node.columns) ? node.columns : [];
    for (const column of columns) {
      const alias = qName(object(column)?.alias).name;
      if (alias) result.selectAliases.add(alias);
      collectRefNames(object(column)?.expr, result.projectionColumns);
    }
    const localAliases = new Set<string>();
    for (const column of columns) {
      const alias = qName(object(column)?.alias).name;
      if (alias) localAliases.add(alias);
    }
    const allowedAliasRefs = new Set<string>();
    const invalidAliasRefs = new Set<string>();
    collectRefNames(node.orderBy, allowedAliasRefs);
    collectRefNames(node.groupBy, allowedAliasRefs);
    collectRefNames(node.where, invalidAliasRefs);
    collectRefNames(node.having, invalidAliasRefs);
    collectRefNames(node.from, invalidAliasRefs);
    for (const alias of localAliases) {
      if (allowedAliasRefs.has(alias)) result.allowedAliasReferences.add(alias);
      if (invalidAliasRefs.has(alias)) result.invalidAliasReferences.add(alias);
    }
    if (columns.some((column) => {
      const expression = object(object(column)?.expr);
      return expression?.type === "ref" && expression.name === "*";
    })) result.wildcardProjection = true;
    const from = Array.isArray(node.from) ? node.from : [];
    result.relationCount += from.length;
    if (from.length > 1 && from.slice(1).some((item) => !object(item)?.join)) result.crossJoin = true;
  }
  Object.values(node).forEach((item) => inspect(item, result, cteNames, relationNames));
}

export function analyzeSql(sql: string): SqlAnalysis {
  let statements: Statement[];
  try {
    statements = parse(sql);
  } catch (error) {
    return {
      parsed: false,
      parseError: error instanceof Error ? error.message : String(error),
      statementCount: 0,
      readOnlySelect: false,
      tables: [],
      columns: [],
      projectionColumns: [],
      functions: [],
      selectAliases: [],
      allowedAliasReferences: [],
      invalidAliasReferences: [],
      keywords: [],
      schemas: [],
      wildcardProjection: false,
      wholeRowProjection: false,
      rowLock: false,
      tableColumnAliasList: false,
      joinUsingColumns: [],
      relationCount: 0,
      astNodeCount: 0,
      maxAstDepth: 0,
      recursiveCte: false,
      crossJoin: false,
      disallowedFunctions: [],
    };
  }

  const collected = {
    tables: new Set<string>(),
    columns: new Set<string>(),
    projectionColumns: new Set<string>(),
    functions: new Set<string>(),
    selectAliases: new Set<string>(),
    allowedAliasReferences: new Set<string>(),
    invalidAliasReferences: new Set<string>(),
    keywords: new Set<string>(),
    schemas: new Set<string>(),
    wildcardProjection: false,
    wholeRowProjection: false,
    rowLock: false,
    tableColumnAliasList: false,
    joinUsingColumns: new Set<string>(),
    relationCount: 0,
    crossJoin: false,
  };
  const cteAliases = new Set<string>();
  const relationNames = new Set<string>();
  collectCteNames(statements, cteAliases);
  collectRelationNames(statements, relationNames);
  cteAliases.forEach((name) => relationNames.add(name));
  inspect(statements, collected, new Set(), relationNames);
  collected.wholeRowProjection = containsWholeRowReference(statements, relationNames);
  collected.wildcardProjection = containsUnsafeWildcard(statements);
  const metrics = astMetrics(statements);
  const functions = [...collected.functions].sort();
  return {
    parsed: true,
    statementCount: statements.length,
    readOnlySelect: statements.length === 1 && isReadOnlySelect(statements[0]) && !metrics.recursive,
    tables: [...collected.tables].sort(),
    columns: [...collected.columns].sort(),
    projectionColumns: [...collected.projectionColumns].sort(),
    functions,
    selectAliases: [...collected.selectAliases].sort(),
    allowedAliasReferences: [...collected.allowedAliasReferences].sort(),
    invalidAliasReferences: [...collected.invalidAliasReferences].sort(),
    keywords: [...collected.keywords].sort(),
    schemas: [...collected.schemas].sort(),
    wildcardProjection: collected.wildcardProjection,
    wholeRowProjection: collected.wholeRowProjection,
    rowLock: collected.rowLock,
    tableColumnAliasList: collected.tableColumnAliasList,
    joinUsingColumns: [...collected.joinUsingColumns].sort(),
    relationCount: collected.relationCount,
    astNodeCount: metrics.count,
    maxAstDepth: metrics.depth,
    recursiveCte: metrics.recursive,
    crossJoin: collected.crossJoin,
    disallowedFunctions: functions.filter((name) => !ALLOWED_FUNCTIONS.has(name)),
  };
}
