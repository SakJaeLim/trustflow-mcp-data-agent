import { randomUUID } from "node:crypto";
import { evidenceId } from "./core/hash.ts";
import type { AnswerEnvelope, EvidenceItem, QueryPlan, RunContext, RunResult } from "./core/model.ts";
import type { AuditLedger } from "./evidence/ledger.ts";
import { toAuditRecord } from "./evidence/ledger.ts";
import { composeAnswer } from "./evidence/composer.ts";
import { PlanGate } from "./policy/plan-gate.ts";
import { ApprovalAuthority } from "./security/approval-authority.ts";
import type { StepExecutor } from "./tools/executors.ts";
import { timedExecution } from "./tools/executors.ts";

export class TrustFlowOrchestrator {
  private readonly gate: PlanGate;
  private readonly ledger: AuditLedger;
  private readonly executors: Map<string, StepExecutor>;
  private readonly answerComposer: (question: string, evidence: EvidenceItem[]) => Promise<AnswerEnvelope>;
  private readonly approvals?: ApprovalAuthority;

  constructor(
    gate: PlanGate,
    ledger: AuditLedger,
    executors: StepExecutor[],
    answerComposer: (question: string, evidence: EvidenceItem[]) => Promise<AnswerEnvelope> = async (question, evidence) => composeAnswer(question, evidence),
    approvals?: ApprovalAuthority,
  ) {
    this.gate = gate;
    this.ledger = ledger;
    this.executors = new Map(executors.map((executor) => [executor.tool, executor]));
    this.answerComposer = answerComposer;
    this.approvals = approvals;
  }

  async run(plan: QueryPlan, context: RunContext = {}): Promise<RunResult> {
    const runId = randomUUID();
    const policy = this.gate.evaluate(plan);
    const policyPayload = {
      decision: policy.decision,
      findings: policy.findings,
      repairs: policy.repairs,
      approvalReasons: policy.approvalReasons,
    };
    const policyEvidence: EvidenceItem = {
      evidenceId: evidenceId("plan-gate", "trustflow.policy", policyPayload),
      stepId: "policy",
      tool: "plan-gate",
      source: "trustflow.policy",
      kind: "policy",
      payload: policyPayload,
    };

    let verifiedApproval: { approverId: string; approvalId: string } | undefined;

    if (policy.decision === "DENY") {
      return this.finish(
        { runId, status: "denied", policy, executions: [], evidence: [policyEvidence] },
      );
    }

    if (policy.decision === "APPROVAL_REQUIRED") {
      const verification = context.approvalReceipt && this.approvals
        ? await this.approvals.consume(context.approvalReceipt, plan)
        : { valid: false };
      if (!verification.valid || !verification.approverId || !verification.approvalId) {
        return this.finish(
          { runId, status: "approval_required", policy, executions: [], evidence: [policyEvidence] },
        );
      }
      verifiedApproval = { approverId: verification.approverId, approvalId: verification.approvalId };
    }

    const executablePlan = policy.executablePlan;
    if (!executablePlan) {
      return this.finish(
        { runId, status: "failed", policy, executions: [], evidence: [policyEvidence] },
        verifiedApproval,
      );
    }

    const executions = [];
    try {
      for (const step of executablePlan.steps) {
        const executor = this.executors.get(step.tool);
        if (!executor) throw new Error(`등록된 실행기가 없습니다: ${step.tool}`);
        executions.push(await timedExecution(executor, step));
      }
      const resultEvidence = [policyEvidence, ...executions.flatMap((execution) => execution.evidence)];
      return this.finish(
        {
          runId,
          status: "executed",
          policy,
          executions,
          evidence: resultEvidence,
          answer: await this.answerComposer(plan.query, resultEvidence),
        },
        verifiedApproval,
      );
    } catch (error) {
      console.error(`[policygraph:${runId}] execution failed`, error);
      const failedEvidence: EvidenceItem = {
        evidenceId: evidenceId("execution", "trustflow.error", { code: "EXECUTION_FAILED", correlationId: runId }),
        stepId: "execution",
        tool: "plan-gate",
        source: "trustflow.error",
        kind: "policy",
        payload: { code: "EXECUTION_FAILED", correlationId: runId },
      };
      return this.finish(
        {
          runId,
          status: "failed",
          policy,
          executions,
          evidence: [policyEvidence, ...executions.flatMap((execution) => execution.evidence), failedEvidence],
        },
        verifiedApproval,
      );
    }
  }

  private async finish(result: RunResult, approval?: { approverId: string; approvalId: string }): Promise<RunResult> {
    await this.ledger.append(toAuditRecord(result, approval));
    return result;
  }
}
