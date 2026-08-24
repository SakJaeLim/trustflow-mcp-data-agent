import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { sha256 } from "../core/hash.ts";
import type { QueryPlan, RunResult } from "../core/model.ts";

export interface AuditRecordInput {
  schemaVersion: "1.0";
  recordedAt: string;
  runId: string;
  queryDigest: string;
  actor: QueryPlan["actor"];
  status: RunResult["status"];
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
        const handle = await open(this.path, "a");
        try {
          await handle.writeFile(`${JSON.stringify(finalized)}\n`, "utf8");
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
      return (await readFile(this.path, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AuditRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
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
    const deadline = Date.now() + 10_000;
    while (true) {
      let lock;
      try {
        lock = await open(lockPath, "wx");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "EPERM") throw error;
        try {
          const lockStat = await stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > 30_000) await unlink(lockPath);
        } catch (statError) {
          const statCode = (statError as NodeJS.ErrnoException).code;
          if (statCode !== "ENOENT" && statCode !== "EPERM" && statCode !== "EBUSY") throw statError;
        }
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
