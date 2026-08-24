import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SqlQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface SqlRunner {
  query(sql: string, maxRows?: number): Promise<SqlQueryResult>;
  close?(): Promise<void>;
}

function boundedQuery(sql: string, maxRows?: number): string {
  if (maxRows === undefined) return sql;
  const limit = Math.max(1, Math.trunc(maxRows));
  return `SELECT * FROM (${sql.trim().replace(/;+\s*$/, "")}) AS policygraph_bounded LIMIT ${limit}`;
}

function postgresSchemaToSqlite(schema: string): string {
  return schema
    .replace(/CREATE EXTENSION IF NOT EXISTS vector\s*;/gi, "")
    .replace(/ALTER TABLE departments[\s\S]*?;/gi, "")
    .replace(/\bSERIAL\b/gi, "INTEGER")
    .replace(/\bVARCHAR\(\d+\)/gi, "TEXT")
    .replace(/\bTIMESTAMP\b/gi, "TEXT")
    .replace(/\bDATE\b/gi, "TEXT")
    .replace(/\bBOOLEAN\b/gi, "INTEGER")
    .replace(/\bJSONB\b/gi, "TEXT")
    .replace(/\bvector\(768\)/gi, "TEXT")
    .replace(/DEFAULT\s+NOW\(\)/gi, "DEFAULT CURRENT_TIMESTAMP");
}

function postgresDataToSqlite(data: string): string {
  return data.replace(/^SELECT\s+setval\([^;]+;\s*$/gim, "");
}

/** Local-only adapter that executes the official seed SQL without Docker. */
export class SqliteFixture implements SqlRunner {
  private readonly database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.database = database;
  }

  static async fromDataset(sqlDirectory: string): Promise<SqliteFixture> {
    const [schema, data] = await Promise.all([
      readFile(join(sqlDirectory, "01-schema.sql"), "utf8"),
      readFile(join(sqlDirectory, "02-data.sql"), "utf8"),
    ]);
    const database = new DatabaseSync(":memory:");
    database.exec(postgresSchemaToSqlite(schema));
    database.exec(postgresDataToSqlite(data));
    return new SqliteFixture(database);
  }

  async query(sql: string, maxRows?: number): Promise<SqlQueryResult> {
    const rows = this.database.prepare(boundedQuery(sql, maxRows)).all() as Record<string, unknown>[];
    return { rows, rowCount: rows.length };
  }

  async close(): Promise<void> {
    this.database.close();
  }
}
