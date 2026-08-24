import { createRuntime } from "../src/runtime.ts";

const runtime = await createRuntime({
  ...process.env,
  POLICYGRAPH_RUNTIME: "offline",
  POLICYGRAPH_LLM_MODE: "disabled",
});

try {
  const question = "Client-A가 사용 중인 제품 목록은?";
  const result = await runtime.orchestrator.run(runtime.planner.buildPlan(question));
  if (result.status !== "executed" || !result.answer?.verified) {
    throw new Error(`Audit smoke failed with status ${result.status}.`);
  }
  console.log(`Signed audit smoke passed. Run ID: ${result.runId}`);
} finally {
  await runtime.close();
}
