import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { AuditCheckpoint, AuditRecord } from "../src/evidence/ledger.ts";
import { verifyAuditCheckpoint, verifyAuditRecords } from "../src/evidence/ledger.ts";

const path = resolve(process.argv[2] ?? process.env.POLICYGRAPH_AUDIT_PATH ?? ".policygraph/audit.jsonl");
const signingSecret = process.env.POLICYGRAPH_AUDIT_SIGNING_SECRET;
const checkpointDirectory = process.env.POLICYGRAPH_AUDIT_CHECKPOINT_DIR;
if (!signingSecret || !checkpointDirectory) {
  throw new Error("Audit verification requires POLICYGRAPH_AUDIT_SIGNING_SECRET and POLICYGRAPH_AUDIT_CHECKPOINT_DIR.");
}
const records = (await readFile(path, "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as AuditRecord);
const verification = verifyAuditRecords(records, signingSecret);
const checkpointPath = resolve(checkpointDirectory, `${basename(path)}.head.json`);
const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as AuditCheckpoint;
const checkpointVerification = verifyAuditCheckpoint(records, checkpoint, signingSecret);
const valid = verification.valid && checkpointVerification.valid;

console.log(JSON.stringify({ path, checkpointPath, recordCount: records.length, valid, errors: [...verification.errors, ...checkpointVerification.errors] }, null, 2));
if (!valid) process.exitCode = 1;
