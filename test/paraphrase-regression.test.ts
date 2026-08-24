import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolName } from "../src/core/model.ts";
import { CompanyXPlanner } from "../src/planner/companyx-planner.ts";

interface Fixture {
  cases: Array<{
    id: string;
    expectedTool: ToolName;
    paraphrases: string[];
  }>;
}

test("intent normalizer routes all 90 reviewed paraphrases without a network model", async () => {
  const fixture = JSON.parse(await readFile(resolve("evaluation/paraphrases.json"), "utf8")) as Fixture;
  const planner = new CompanyXPlanner();
  const failures = [];
  for (const item of fixture.cases) {
    for (const [index, question] of item.paraphrases.entries()) {
      try {
        const trace = await planner.planWithTrace(question);
        const actualTool = trace.plan.steps[0]?.tool;
        if (trace.source !== "intent-repair" || actualTool !== item.expectedTool) {
          failures.push({ id: item.id, variant: index + 1, source: trace.source, expected: item.expectedTool, actual: actualTool });
        }
      } catch (error) {
        failures.push({ id: item.id, variant: index + 1, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  assert.deepEqual(failures, []);
});
