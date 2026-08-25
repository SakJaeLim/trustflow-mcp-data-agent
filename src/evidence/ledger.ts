import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { sha256 } from "../core/hash.ts";
import type { PolicyDecision, QueryPlan, RunResult } from "../core/model.ts";

export const MAX_AUDIT_LEDGER_BYTES = 64 * 1_048_576;
export const MAX_AUDIT_RECORDS = 50_000;
export const MAX_AUDIT_RECORD_BYTES = 64 * 1_024;

export function requiredAuditRecordSlots(status: AuditRecordInput["status"]): number {
  return status === "started" ? 2 : 1;
}

interface AuditLifecycle {
  outstanding: Set<string>;
  seen: Set<string>;
  errors: string[];
}

function auditLifecycle(records: readonly Pick<AuditRecordInput, "runId" | "status">[]): AuditLifecycle {
  const outstanding = new Set<string>();
  const seen = new Set<string>();
  const errors: string[] = [];
  records.forEach((record, index) => {
    if (record.status === "started") {
      if (seen.has(record.runId)) errors.push(`record ${index + 1}: duplicate run start`);
      seen.add(record.runId);
      outstanding.add(record.runId);
      return;
    }
    if (outstanding.has(record.runId)) {
      outstanding.delete(record.runId);
    } else if (seen.has(record.runId)) {
      errors.push(`record ${index + 1}: duplicate run terminal`);
    }
    seen.add(record.runId);
  });
  return { outstanding, seen, errors };
}

export function projectedAuditRecordCount(
  records: readonly Pick<AuditRecordInput, "runId" | "status">[],
  next: Pick<AuditRecordInput, "runId" | "status">,
): number {
  const lifecycle = auditLifecycle(records);
  if (lifecycle.errors.length > 0) throw new Error(lifecycle.errors.join(", "));
  if (next.status === "started") {
    if (lifecycle.seen.has(next.runId)) throw new Error("duplicate audit run lifecycle");
    lifecycle.outstanding.add(next.runId);
  } else if (lifecycle.outstanding.has(next.runId)) {
    lifecycle.outstanding.delete(next.runId);
  } else if (lifecycle.seen.has(next.runId)) {
    throw new Error("duplicate audit run lifecycle");
  }
  return records.length + 1 + lifecycle.outstanding.size;
}

export interface AuditRecordInput {
  schemaVersion: "1.0";
  recordedAt: string;
  runId: string;
  queryDigest: string;
  actor: QueryPlan["actor"];
  status: RunResult["status"] | "started";
  decision: RunResult["policy"]["decision"];
  originalPlanHash: string;
  executablePlanHash?: string;
  findingCodes: string[];
  repairCodes: string[];
  approvedBy?: string;
  approvalId?: string;
  evidenceIds: string[];
  toolCalls: Array<{ stepId: string; tool: string; durationMs: number }>;
}

export interface AuditRecord extends AuditRecordInput {
  sequence: number;
  previousRecordHash: string | null;
  recordHash: string;
  recordSignature?: string;
}

export interface AuditCheckpoint {
  schemaVersion: "1.0";
  ledgerId: string;
  sequence: number;
  recordHash: string | null;
  updatedAt: string;
  signature: string;
}

export interface AuditLedger {
  append(record: AuditRecordInput): Promise<void>;
}

export class InMemoryAuditLedger implements AuditLedger {
  readonly records: AuditRecord[] = [];
  private readonly signingSecret?: string;

  constructor(signingSecret?: string) {
    validateSigningSecret(signingSecret);
    this.signingSecret = signingSecret;
  }

  async append(record: AuditRecordInput): Promise<void> {
    const previous = this.records.at(-1);
    this.records.push(finalizeRecord(record, previous, this.signingSecret));
  }
}

export class JsonlAuditLedger implements AuditLedger {
  private readonly path: string;
  private readonly signingSecret?: string;
  private readonly checkpointPath?: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(path: string, signingSecret?: string, checkpointPath?: string) {
    validateSigningSecret(signingSecret);
    if (checkpointPath && !signingSecret) {
      throw new Error("An audit checkpoint requires POLICYGRAPH_AUDIT_SIGNING_SECRET.");
    }
    this.path = path;
    this.signingSecret = signingSecret;
    this.checkpointPath = checkpointPath;
  }

  async append(record: AuditRecordInput): Promise<void> {
    const operation = this.pending.then(() => this.withCrossProcessLock(async () => {
        const records = await this.readAll();
        const verification = verifyAuditRecords(records, this.signingSecret);
        if (!verification.valid) {
          throw new Error(`기존 감사 원장의 해시 체인이 손상되었습니다: ${verification.errors.join(", ")}`);
        }
        const lifecycle = auditLifecycle(records);
        if (lifecycle.errors.length > 0) {
          throw new Error(`기존 감사 원장의 실행 수명주기가 손상되었습니다: ${lifecycle.errors.join(", ")}`);
        }
        const checkpoint = await this.readCheckpoint();
        if (this.checkpointPath) {
          if (!this.signingSecret) throw new Error("Audit checkpoint signing is not configured.");
          if (!checkpoint && records.length > 0) {
            throw new Error("기존 감사 원장에 보호된 체크포인트가 없습니다.");
          }
          if (checkpoint) {
            const checkpointVerification = verifyAuditCheckpoint(records, checkpoint, this.signingSecret);
            if (!checkpointVerification.valid) {
              throw new Error(`감사 원장 롤백 또는 체크포인트 손상이 감지되었습니다: ${checkpointVerification.errors.join(", ")}`);
            }
          }
        }
        const previous = records.at(-1);
        const finalized = finalizeRecord(record, previous, this.signingSecret);
        const serialized = `${JSON.stringify(finalized)}\n`;
        const serializedBytes = Buffer.byteLength(serialized, "utf8");
        if (serializedBytes > MAX_AUDIT_RECORD_BYTES) {
          throw new Error(`감사 레코드가 ${MAX_AUDIT_RECORD_BYTES}바이트를 초과했습니다.`);
        }
        const projectedRecords = projectedAuditRecordCount(records, record);
        if (projectedRecords > MAX_AUDIT_RECORDS) {
          throw new Error(`감사 원장이 ${MAX_AUDIT_RECORDS}개 레코드 상한에 도달했습니다.`);
        }
        const currentBytes = await this.currentLedgerBytes();
        const outstandingAfterAppend = projectedRecords - (records.length + 1);
        const requiredBytes = serializedBytes + outstandingAfterAppend * MAX_AUDIT_RECORD_BYTES;
        if (currentBytes + requiredBytes > MAX_AUDIT_LEDGER_BYTES) {
          throw new Error(`감사 원장이 ${MAX_AUDIT_LEDGER_BYTES}바이트 상한에 도달했습니다.`);
        }
        const handle = await open(this.path, "a");
        try {
          await handle.writeFile(serialized, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (this.checkpointPath && this.signingSecret) {
          await this.writeCheckpoint({
            schemaVersion: "1.0",
            ledgerId: checkpoint?.ledgerId ?? randomUUID(),
            sequence: finalized.sequence,
            recordHash: finalized.recordHash,
            updatedAt: new Date().toISOString(),
            signature: "",
          });
        }
      }));
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async readAll(): Promise<AuditRecord[]> {
    try {
      const details = await stat(this.path);
      if (!details.isFile() || details.size > MAX_AUDIT_LEDGER_BYTES) {
        throw new Error(`감사 원장이 ${MAX_AUDIT_LEDGER_BYTES}바이트 안전 상한을 초과했습니다.`);
      }
      const lines = (await readFile(this.path, "utf8")).split(/\r?\n/).filter(Boolean);
      if (lines.length > MAX_AUDIT_RECORDS) throw new Error(`감사 원장이 ${MAX_AUDIT_RECORDS}개 레코드 상한을 초과했습니다.`);
      return lines.map((line, index) => {
        if (Buffer.byteLength(line, "utf8") > MAX_AUDIT_RECORD_BYTES) {
          throw new Error(`감사 레코드 ${index + 1}이 ${MAX_AUDIT_RECORD_BYTES}바이트를 초과했습니다.`);
        }
        return JSON.parse(line) as AuditRecord;
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async currentLedgerBytes(): Promise<number> {
    try {
      return (await stat(this.path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  private async readCheckpoint(): Promise<AuditCheckpoint | undefined> {
    if (!this.checkpointPath) return undefined;
    try {
      return JSON.parse(await readFile(this.checkpointPath, "utf8")) as AuditCheckpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeCheckpoint(input: AuditCheckpoint): Promise<void> {
    if (!this.checkpointPath || !this.signingSecret) return;
    await mkdir(dirname(this.checkpointPath), { recursive: true });
    const unsigned = {
      schemaVersion: input.schemaVersion,
      ledgerId: input.ledgerId,
      sequence: input.sequence,
      recordHash: input.recordHash,
      updatedAt: input.updatedAt,
    };
    const checkpoint = {
      ...unsigned,
      signature: checkpointSignature(this.signingSecret, unsigned),
    };
    const temporaryPath = `${this.checkpointPath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(checkpoint)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, this.checkpointPath);
    } finally {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private async withCrossProcessLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const owner = `${process.pid}:${randomUUID()}`;
    const deadline = Date.now() + 30_000;
    while (true) {
      let lock;
      try {
        lock = await open(lockPath, "wx");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "EPERM") throw error;
        if (Date.now() >= deadline) throw new Error("감사 원장 잠금 획득 시간이 초과되었습니다.");
        await new Promise((resolveWait) => setTimeout(resolveWait, 20 + Math.floor(Math.random() * 30)));
        continue;
      }

      try {
        await lock.writeFile(owner, "utf8");
        await lock.sync();
        return await operation();
      } finally {
        await lock.close();
        const releaseDeadline = Date.now() + 2_000;
        while (true) {
          try {
            if ((await readFile(lockPath, "utf8")) !== owner) break;
            await unlink(lockPath);
            break;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") break;
            if ((code !== "EPERM" && code !== "EBUSY") || Date.now() >= releaseDeadline) throw error;
            await new Promise((resolveWait) => setTimeout(resolveWait, 20 + Math.floor(Math.random() * 30)));
          }
        }
      }
    }
  }
}

export function toAuditRecord(result: RunResult, approval?: { approverId: string; approvalId: string }): AuditRecordInput {
  const plan = result.policy.originalPlan;
  return {
    schemaVersion: "1.0",
    recordedAt: new Date().toISOString(),
    runId: result.runId,
    queryDigest: auditQueryDigest(plan.query),
    actor: plan.actor,
    status: result.status,
    decision: result.policy.decision,
    originalPlanHash: sha256(plan),
    executablePlanHash: result.policy.executablePlan ? sha256(result.policy.executablePlan) : undefined,
    findingCodes: result.policy.findings.map((finding) => finding.code),
    repairCodes: result.policy.repairs.map((repair) => repair.code),
    approvedBy: approval?.approverId,
    approvalId: approval?.approvalId,
    evidenceIds: result.evidence.map((item) => item.evidenceId),
    toolCalls: result.executions.map((execution) => ({
      stepId: execution.stepId,
      tool: execution.tool,
      durationMs: execution.durationMs,
    })),
  };
}

export function toAuditIntent(
  runId: string,
  policy: PolicyDecision,
  approval?: { approverId: string; approvalId: string },
): AuditRecordInput {
  const plan = policy.originalPlan;
  return {
    schemaVersion: "1.0",
    recordedAt: new Date().toISOString(),
    runId,
    queryDigest: auditQueryDigest(plan.query),
    actor: plan.actor,
    status: "started",
    decision: policy.decision,
    originalPlanHash: sha256(plan),
    executablePlanHash: policy.executablePlan ? sha256(policy.executablePlan) : undefined,
    findingCodes: policy.findings.map((finding) => finding.code),
    repairCodes: policy.repairs.map((repair) => repair.code),
    approvedBy: approval?.approverId,
    approvalId: approval?.approvalId,
    evidenceIds: [],
    toolCalls: [],
  };
}

export function auditQueryDigest(query: string): string {
  return `sha256:${sha256({ domain: "policygraph.audit.query", query })}`;
}

function validateSigningSecret(secret?: string): void {
  if (secret && Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("POLICYGRAPH_AUDIT_SIGNING_SECRET must be at least 32 bytes.");
  }
}

function recordSignature(secret: string, recordHash: string): string {
  return createHmac("sha256", secret).update(recordHash).digest("base64url");
}

function checkpointSignature(
  secret: string,
  checkpoint: Omit<AuditCheckpoint, "signature">,
): string {
  return createHmac("sha256", secret).update(sha256(checkpoint)).digest("base64url");
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "base64url");
  const rightBuffer = Buffer.from(right, "base64url");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function finalizeRecord(input: AuditRecordInput, previous?: AuditRecord, signingSecret?: string): AuditRecord {
  const unsigned = {
    ...structuredClone(input),
    sequence: (previous?.sequence ?? 0) + 1,
    previousRecordHash: previous?.recordHash ?? null,
  };
  const recordHash = sha256(unsigned);
  return {
    ...unsigned,
    recordHash,
    recordSignature: signingSecret ? recordSignature(signingSecret, recordHash) : undefined,
  };
}

export function verifyAuditRecords(records: AuditRecord[], signingSecret?: string): { valid: boolean; errors: string[] } {
  validateSigningSecret(signingSecret);
  const errors: string[] = [];
  records.forEach((record, index) => {
    const { recordHash, recordSignature: suppliedSignature, ...unsigned } = record;
    if (record.sequence !== index + 1) errors.push(`record ${index + 1}: invalid sequence`);
    const expectedPrevious = index === 0 ? null : records[index - 1]?.recordHash ?? null;
    if (record.previousRecordHash !== expectedPrevious) errors.push(`record ${index + 1}: broken previous hash`);
    if (recordHash !== sha256(unsigned)) errors.push(`record ${index + 1}: invalid record hash`);
    if (signingSecret && (!suppliedSignature || !secureEqual(suppliedSignature, recordSignature(signingSecret, recordHash)))) {
      errors.push(`record ${index + 1}: invalid record signature`);
    }
  });
  return { valid: errors.length === 0, errors };
}

export function verifyAuditCheckpoint(
  records: AuditRecord[],
  checkpoint: AuditCheckpoint,
  signingSecret: string,
): { valid: boolean; errors: string[] } {
  validateSigningSecret(signingSecret);
  const errors: string[] = [];
  const { signature, ...unsigned } = checkpoint;
  if (
    checkpoint.schemaVersion !== "1.0"
    || !checkpoint.ledgerId
    || checkpoint.sequence < 0
    || !Number.isInteger(checkpoint.sequence)
  ) errors.push("invalid checkpoint fields");
  if (!signature || !secureEqual(signature, checkpointSignature(signingSecret, unsigned))) {
    errors.push("invalid checkpoint signature");
  }
  if (records.length < checkpoint.sequence) {
    errors.push("ledger is shorter than protected checkpoint");
  } else if (records.length > checkpoint.sequence) {
    errors.push("checkpoint is behind the ledger head");
  } else if (checkpoint.sequence === 0) {
    if (checkpoint.recordHash !== null) errors.push("empty checkpoint has a record hash");
  } else if (records[checkpoint.sequence - 1]?.recordHash !== checkpoint.recordHash) {
    errors.push("protected checkpoint hash does not match ledger");
  }
  return { valid: errors.length === 0, errors };
}
