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
  for?: unknown;
  from?: unknown;
  join?: unknown;
  bind?: unknown;
  in?: unknown;
  left?: unknown;
  right?: unknown;
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
  functions: string[];
  schemas: string[];
  wildcardProjection: boolean;
  wholeRowProjection: boolean;
  rowLock: boolean;
  tableColumnAliasList: boolean;
  joinUsingColumns: string[];
  relationCount: number;
  crossJoin: boolean;
  disallowedFunctions: string[];
}

function object(value: unknown): AstNode | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as AstNode : undefined;
}

function qName(value: unknown): { name?: string; schema?: string } {
  const node = object(value);
  return {
    name: typeof node?.name === "string" ? node.name.toLocaleLowerCase("en-US") : undefined,
    schema: typeof node?.schema === "string" ? node.schema.toLocaleLowerCase("en-US") : undefined,
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
    if (typeof table?.name === "string") names.add(table.name.toLocaleLowerCase("en-US"));
    if (typeof table?.alias === "string") names.add(table.alias.toLocaleLowerCase("en-US"));
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
    && relationNames.has(node.name.toLocaleLowerCase("en-US"))
  ) return true;
  return Object.values(node).some((item) => containsWholeRowReference(item, relationNames));
}

function inspect(
  value: unknown,
  result: {
    tables: Set<string>;
    columns: Set<string>;
    functions: Set<string>;
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
    if (name.name && !cteNames.has(name.name)) {
      result.tables.add(name.name);
      result.relationCount += 1;
    }
    if (name.schema) result.schemas.add(name.schema);
    if (Array.isArray(object(node.name)?.columnNames) && (object(node.name)?.columnNames as unknown[]).length > 0) {
      result.tableColumnAliasList = true;
    }
  }
  if (node.type === "ref") {
    if (typeof node.name === "string") result.columns.add(node.name.toLocaleLowerCase("en-US"));
    const table = qName(node.table);
    if (table.schema) result.schemas.add(table.schema);
  }
  if (node.type === "call") {
    const name = qName(node.function);
    if (name.name) result.functions.add(name.name);
    if (name.schema) result.schemas.add(name.schema);
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
  }
  if (node.type === "select") {
    if (node.for) result.rowLock = true;
    const columns = Array.isArray(node.columns) ? node.columns : [];
    if (columns.some((column) => {
      const expression = object(object(column)?.expr);
      return expression?.type === "ref" && expression.name === "*";
    })) result.wildcardProjection = true;
    if (columns.some((column) => containsWholeRowReference(object(column)?.expr, relationNames))) {
      result.wholeRowProjection = true;
    }
    const from = Array.isArray(node.from) ? node.from : [];
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
      functions: [],
      schemas: [],
      wildcardProjection: false,
      wholeRowProjection: false,
      rowLock: false,
      tableColumnAliasList: false,
      joinUsingColumns: [],
      relationCount: 0,
      crossJoin: false,
      disallowedFunctions: [],
    };
  }

  const collected = {
    tables: new Set<string>(),
    columns: new Set<string>(),
    functions: new Set<string>(),
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
  const functions = [...collected.functions].sort();
  return {
    parsed: true,
    statementCount: statements.length,
    readOnlySelect: statements.length === 1 && isReadOnlySelect(statements[0]),
    tables: [...collected.tables].sort(),
    columns: [...collected.columns].sort(),
    functions,
    schemas: [...collected.schemas].sort(),
    wildcardProjection: collected.wildcardProjection,
    wholeRowProjection: collected.wholeRowProjection,
    rowLock: collected.rowLock,
    tableColumnAliasList: collected.tableColumnAliasList,
    joinUsingColumns: [...collected.joinUsingColumns].sort(),
    relationCount: collected.relationCount,
    crossJoin: collected.crossJoin,
    disallowedFunctions: functions.filter((name) => !ALLOWED_FUNCTIONS.has(name)),
  };
}
