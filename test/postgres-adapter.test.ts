import test from "node:test";
import assert from "node:assert/strict";
import type { EventEmitter } from "node:events";
import { PostgresDatabase } from "../src/adapters/postgres.ts";

test("PostgreSQL pool handles idle-client errors without terminating the process", async () => {
  const database = new PostgresDatabase("postgresql://127.0.0.1:1/unused");
  const pool = (database as unknown as { pool: EventEmitter }).pool;

  assert.ok(pool.listenerCount("error") >= 1);
  assert.doesNotThrow(() => pool.emit("error", new Error("simulated idle disconnect")));

  await database.close();
});
