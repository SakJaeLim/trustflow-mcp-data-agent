import test from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/runtime.ts";

test("every runtime fails closed without signed audit checkpoint configuration", async () => {
  for (const mode of ["offline", "postgres"]) {
    const environment: NodeJS.ProcessEnv = { ...process.env, POLICYGRAPH_RUNTIME: mode };
    delete environment.POLICYGRAPH_AUDIT_SIGNING_SECRET;
    delete environment.POLICYGRAPH_AUDIT_CHECKPOINT_DIR;
    await assert.rejects(createRuntime(environment), /requires POLICYGRAPH_AUDIT_SIGNING_SECRET/u);
  }
});
