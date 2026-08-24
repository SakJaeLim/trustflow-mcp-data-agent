export interface EvaluationExceptionResult {
  id: string;
  assertion: string;
  passed: false;
  safelyRejected: false;
  errorCode: "EVALUATION_EXCEPTION";
  latencyMs: number;
}

export function evaluationException(
  id: string,
  assertion: string,
  latencyMs: number,
): EvaluationExceptionResult {
  return {
    id,
    assertion,
    passed: false,
    safelyRejected: false,
    errorCode: "EVALUATION_EXCEPTION",
    latencyMs,
  };
}
