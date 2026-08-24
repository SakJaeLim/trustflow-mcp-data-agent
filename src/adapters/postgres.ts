import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { SqlQueryResult, SqlRunner } from "../tools/sqlite-fixture.ts";

export class PostgresDatabase implements SqlRunner {
  private readonly pool: Pool;
  private readonly statementTimeoutMs: number;

  constructor(connectionString: string, statementTimeoutMs = 5_000) {
    this.pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    this.pool.on("error", () => {
      // pg discards a failed idle client; the next operation obtains a fresh connection.
    });
    this.statementTimeoutMs = statementTimeoutMs;
  }

  async query(sql: string, maxRows?: number): Promise<SqlQueryResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query(`SET LOCAL statement_timeout = '${this.statementTimeoutMs}ms'`);
      const boundedSql = maxRows === undefined
        ? sql
        : `SELECT * FROM (${sql.trim().replace(/;+\s*$/, "")}) AS policygraph_bounded LIMIT ${Math.max(1, Math.trunc(maxRows))}`;
      const result = await client.query(boundedSql);
      await client.query("COMMIT");
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? result.rows.length };
    } catch (error) {
      await this.rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async queryRows<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query(`SET LOCAL statement_timeout = '${this.statementTimeoutMs}ms'`);
      const result = await client.query<T>(sql, values);
      await client.query("COMMIT");
      return result.rows;
    } catch (error) {
      await this.rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async write(sql: string, values: unknown[] = []): Promise<number> {
    const result = await this.pool.query(sql, values);
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async rollbackQuietly(client: PoolClient): Promise<void> {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
  }
}
