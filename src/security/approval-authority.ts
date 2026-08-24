import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../core/hash.ts";
import type { QueryPlan } from "../core/model.ts";

interface ApprovalClaims {
  version: "1.0";
  approvalId: string;
  approverId: string;
  approverRole: "admin";
  actorId: string;
  actorRole: QueryPlan["actor"]["role"];
  planHash: string;
  issuedAt: number;
  expiresAt: number;
}

export interface ApprovalVerification {
  valid: boolean;
  reason?: "malformed" | "signature" | "expired" | "actor" | "plan" | "replayed";
  approvalId?: string;
  approverId?: string;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

export class ApprovalAuthority {
  private readonly secret: Buffer;
  private readonly used = new Set<string>();
  private readonly replayDirectory?: string;

  constructor(secret: string, replayDirectory?: string) {
    if (Buffer.byteLength(secret, "utf8") < 32) {
      throw new Error("POLICYGRAPH_APPROVAL_SECRET must be at least 32 bytes.");
    }
    this.secret = Buffer.from(secret, "utf8");
    this.replayDirectory = replayDirectory;
  }

  issue(plan: QueryPlan, approverId: string, ttlSeconds = 300): string {
    const now = Math.floor(Date.now() / 1_000);
    const claims: ApprovalClaims = {
      version: "1.0",
      approvalId: randomUUID(),
      approverId,
      approverRole: "admin",
      actorId: plan.actor.id,
      actorRole: plan.actor.role,
      planHash: sha256(plan),
      issuedAt: now,
      expiresAt: now + Math.min(Math.max(Math.trunc(ttlSeconds), 1), 300),
    };
    const payload = encode(JSON.stringify(claims));
    return `${payload}.${this.sign(payload)}`;
  }

  async consume(token: string, plan: QueryPlan): Promise<ApprovalVerification> {
    const [payload, suppliedSignature, extra] = token.split(".");
    if (!payload || !suppliedSignature || extra !== undefined) return { valid: false, reason: "malformed" };
    const expectedSignature = this.sign(payload);
    const supplied = Buffer.from(suppliedSignature, "base64url");
    const expected = Buffer.from(expectedSignature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return { valid: false, reason: "signature" };

    let claims: ApprovalClaims;
    try {
      claims = JSON.parse(decode(payload)) as ApprovalClaims;
    } catch {
      return { valid: false, reason: "malformed" };
    }
    const now = Math.floor(Date.now() / 1_000);
    if (
      claims.version !== "1.0"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(claims.approvalId)
      || typeof claims.approverId !== "string"
      || !claims.approverId.trim()
      || claims.approverRole !== "admin"
    ) return { valid: false, reason: "malformed" };
    if (claims.expiresAt <= now || claims.issuedAt > now + 30) return { valid: false, reason: "expired" };
    if (claims.actorId !== plan.actor.id || claims.actorRole !== plan.actor.role) return { valid: false, reason: "actor" };
    if (claims.planHash !== sha256(plan)) return { valid: false, reason: "plan" };
    if (!(await this.markUsed(claims.approvalId, claims.expiresAt))) return { valid: false, reason: "replayed" };
    return { valid: true, approvalId: claims.approvalId, approverId: claims.approverId };
  }

  private async markUsed(approvalId: string, expiresAt: number): Promise<boolean> {
    if (!this.replayDirectory) {
      if (this.used.has(approvalId)) return false;
      this.used.add(approvalId);
      return true;
    }
    await mkdir(this.replayDirectory, { recursive: true });
    try {
      const handle = await open(join(this.replayDirectory, `${approvalId}.used`), "wx");
      try {
        await handle.writeFile(JSON.stringify({ approvalId, expiresAt }), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }
}
