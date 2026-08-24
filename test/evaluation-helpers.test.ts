import test from "node:test";
import assert from "node:assert/strict";
import { evaluationException } from "../scripts/evaluation-helpers.ts";

test("security evaluation exceptions fail closed", () => {
  const result = evaluationException("ollama-timeout", "no-execution", 30_000);
  assert.equal(result.passed, false);
  assert.equal(result.safelyRejected, false);
  assert.equal(result.errorCode, "EVALUATION_EXCEPTION");
});
