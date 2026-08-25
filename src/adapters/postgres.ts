import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { SqlQueryResult, SqlRunner } from "../tools/sqlite-fixture.ts";

export interface PostgresWriteTransaction {
  write(sql: string, values?: unknown[]): Promise<number>;
}

export interface PostgresReadTransaction extends SqlRunner {
  queryRows<T extends QueryResultRow>(sql: string, values?: unknown[]): Promise<T[]>;
}

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
    return this.withReadTransaction((transaction) => transaction.query(sql, maxRows));
  }

  async queryRows<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    return this.withReadTransaction((transaction) => transaction.queryRows<T>(sql, values));
  }

  async withReadTransaction<T>(operation: (transaction: PostgresReadTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query(`SET LOCAL statement_timeout = '${this.statementTimeoutMs}ms'`);
      const transaction: PostgresReadTransaction = {
        async query(sql: string, maxRows?: number): Promise<SqlQueryResult> {
          const boundedSql = maxRows === undefined
            ? sql
            : `SELECT * FROM (${sql.trim().replace(/;+\s*$/, "")}) AS policygraph_bounded LIMIT ${Math.max(1, Math.trunc(maxRows))}`;
          const result = await client.query(boundedSql);
          return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? result.rows.length };
        },
        async queryRows<Row extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<Row[]> {
          return (await client.query<Row>(sql, values)).rows;
        },
      };
      const result = await operation(transaction);
      await client.query("COMMIT");
      return result;
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

  async withWriteTransaction<T>(operation: (transaction: PostgresWriteTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = '${this.statementTimeoutMs}ms'`);
      await client.query("SET LOCAL lock_timeout = '10000ms'");
      const value = await operation({
        async write(sql: string, values: unknown[] = []): Promise<number> {
          const result = await client.query(sql, values);
          return result.rowCount ?? 0;
        },
      });
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await this.rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
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
