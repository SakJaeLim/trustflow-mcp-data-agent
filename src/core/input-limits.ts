export const MAX_QUESTION_BYTES = 4_096;

export function questionWithinLimit(question: string): boolean {
  return Buffer.byteLength(question, "utf8") <= MAX_QUESTION_BYTES;
}

export function assertQuestionWithinLimit(question: string): void {
  if (!questionWithinLimit(question)) {
    throw new Error(`Question exceeds the ${MAX_QUESTION_BYTES}-byte input limit.`);
  }
}
