import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AuditRecordInput } from "../src/evidence/ledger.ts";
import type { AuditCheckpoint, AuditRecord } from "../src/evidence/ledger.ts";
import { auditQueryDigest, InMemoryAuditLedger, JsonlAuditLedger, projectedAuditRecordCount, requiredAuditRecordSlots, verifyAuditCheckpoint, verifyAuditRecords } from "../src/evidence/ledger.ts";

function record(runId: string, query: string): AuditRecordInput {
  return {
    schemaVersion: "1.0",
    recordedAt: "2026-08-24T00:00:00.000Z",
    runId,
    queryDigest: auditQueryDigest(query),
    actor: { id: "tester", role: "analyst" },
    status: "executed",
    decision: "ALLOW",
    originalPlanHash: "a".repeat(64),
    findingCodes: [],
    repairCodes: [],
    evidenceIds: [],
    toolCalls: [],
  };
}

test("audit verification detects record tampering", async () => {
  const ledger = new InMemoryAuditLedger();
  await ledger.append(record("run-1", "first"));
  await ledger.append(record("run-2", "second"));

  assert.equal(ledger.records[0]?.sequence, 1);
  assert.equal(ledger.records[0]?.previousRecordHash, null);
  assert.equal(ledger.records[1]?.previousRecordHash, ledger.records[0]?.recordHash);
  assert.equal(verifyAuditRecords(ledger.records).valid, true);

  const tampered = structuredClone(ledger.records);
  if (tampered[0]) tampered[0].queryDigest = "sha256:tampered";
  const verification = verifyAuditRecords(tampered);
  assert.equal(verification.valid, false);
  assert.match(verification.errors.join(" "), /invalid record hash/);
});

test("signed JSONL ledger remains valid across concurrent ledger instances", async () => {
  const path = resolve(tmpdir(), `policygraph-audit-${randomUUID()}.jsonl`);
  const checkpointPath = `${path}.checkpoint`;
  const secret = "test-only-audit-signing-secret-at-least-32-bytes";
  const ledgers = Array.from({ length: 5 }, () => new JsonlAuditLedger(path, secret, checkpointPath));
  try {
    await Promise.all(Array.from({ length: 30 }, (_, index) =>
      ledgers[index % ledgers.length]!.append(record(`concurrent-${index}`, `query-${index}`))
    ));
    const records = (await readFile(path, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as AuditRecord);
    assert.equal(records.length, 30);
    assert.deepEqual(records.map((item) => item.sequence), Array.from({ length: 30 }, (_, index) => index + 1));
    assert.deepEqual(verifyAuditRecords(records, secret), { valid: true, errors: [] });

    const forgedSignature = structuredClone(records);
    if (forgedSignature[0]) forgedSignature[0].recordSignature = "invalid";
    assert.match(verifyAuditRecords(forgedSignature, secret).errors.join(" "), /invalid record signature/);

    const staleCheckpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as AuditCheckpoint;
    await ledgers[0]!.append(record("after-stale-checkpoint", "query-30"));
    const recordsWithTail = (await readFile(path, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as AuditRecord);
    assert.match(verifyAuditCheckpoint(recordsWithTail, staleCheckpoint, secret).errors.join(" "), /behind/);
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as AuditCheckpoint;
    assert.deepEqual(verifyAuditCheckpoint(recordsWithTail, checkpoint, secret), { valid: true, errors: [] });
    assert.match(verifyAuditCheckpoint(recordsWithTail.slice(0, -1), checkpoint, secret).errors.join(" "), /shorter/);
    await rm(path, { force: true });
    await assert.rejects(
      new JsonlAuditLedger(path, secret, checkpointPath).append(record("after-delete", "query")),
      /롤백|체크포인트/u,
    );
  } finally {
    await rm(path, { force: true });
    await rm(`${path}.lock`, { force: true });
    await rm(checkpointPath, { force: true });
  }
});

test("signed verification rejects unsigned or mixed records", async () => {
  const secret = "test-only-audit-signing-secret-at-least-32-bytes";
  const ledger = new InMemoryAuditLedger(secret);
  await ledger.append(record("signed-1", "first"));
  await ledger.append(record("signed-2", "second"));
  const mixed = structuredClone(ledger.records);
  if (mixed[1]) delete mixed[1].recordSignature;
  assert.match(verifyAuditRecords(mixed, secret).errors.join(" "), /invalid record signature/);
});

test("audit records retain only a domain-separated query digest", () => {
  const sensitive = "홍길동 salary=123456 contact=user@example.com token=super-secret-value";
  const digest = auditQueryDigest(sensitive);
  assert.match(digest, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(digest, /홍길동|123456|user@example\.com|super-secret-value/u);
  assert.equal(digest, auditQueryDigest(sensitive));
  assert.notEqual(digest, auditQueryDigest(`${sensitive}!`));
});

test("write-ahead audit intent reserves a terminal record slot", () => {
  assert.equal(requiredAuditRecordSlots("started"), 2);
  assert.equal(requiredAuditRecordSlots("executed"), 1);
  assert.equal(requiredAuditRecordSlots("failed"), 1);
});

test("every concurrent audit intent retains its own terminal reservation", () => {
  const first = { ...record("run-1", "first"), status: "started" as const };
  const second = { ...record("run-2", "second"), status: "started" as const };
  assert.equal(projectedAuditRecordCount([], first), 2);
  assert.equal(projectedAuditRecordCount([first], second), 4);
  assert.equal(projectedAuditRecordCount([first, second], record("run-1", "first")), 4);
  assert.throws(() => projectedAuditRecordCount([first], first), /duplicate audit run lifecycle/u);
  assert.throws(
    () => projectedAuditRecordCount([first, record("run-1", "first")], record("run-1", "again")),
    /duplicate audit run lifecycle/u,
  );
});
