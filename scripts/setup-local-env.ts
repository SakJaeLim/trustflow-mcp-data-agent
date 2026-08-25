import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function secret(): string {
  return randomBytes(36).toString("base64url");
}

const path = resolve(".env");
const adminPassword = secret();
const readerPassword = secret();
const approvalSecret = secret();
const auditSecret = secret();
const lines = [
  `POSTGRES_ADMIN_PASSWORD=${adminPassword}`,
  `POLICYGRAPH_READER_PASSWORD=${readerPassword}`,
  "POSTGRES_PORT=54330",
  `DATABASE_URL=postgresql://policygraph_reader:${readerPassword}@127.0.0.1:54330/companyx`,
  `DATABASE_ADMIN_URL=postgresql://policygraph_admin:${adminPassword}@127.0.0.1:54330/companyx`,
  "COMPANYX_DATA_DIR=./data/companyx",
  "POLICYGRAPH_AUDIT_PATH=./.policygraph/audit.jsonl",
  `POLICYGRAPH_AUDIT_SIGNING_SECRET=${auditSecret}`,
  "POLICYGRAPH_AUDIT_CHECKPOINT_DIR=./.policygraph/checkpoints",
  "POLICYGRAPH_RUNTIME=offline",
  "POLICYGRAPH_ACTOR_ROLE=analyst",
  `POLICYGRAPH_APPROVAL_SECRET=${approvalSecret}`,
  "POLICYGRAPH_APPROVAL_REPLAY_DIR=./.policygraph/approval-replays",
  "POLICYGRAPH_LLM_MODE=disabled",
  "OLLAMA_BASE_URL=http://127.0.0.1:11434",
  "OLLAMA_CHAT_MODEL=gemma4:e2b",
  "OLLAMA_CHAT_TIMEOUT_MS=600000",
  "OLLAMA_EMBED_MODEL=nomic-embed-text",
  "VECTOR_MODE=pgvector",
  "",
];

try {
  await writeFile(path, lines.join("\n"), { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log("Created .env with independent random local secrets. The file is ignored by Git.");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EEXIST") {
    if (process.argv.includes("--upgrade")) {
      const existing = await readFile(path, "utf8");
      if (!/^POLICYGRAPH_AUDIT_CHECKPOINT_DIR=/mu.test(existing)) {
        const upgraded = existing
          .replace(/^POLICYGRAPH_AUDIT_CHECKPOINT_PATH=.*\r?\n?/mu, "")
          .trimEnd();
        await writeFile(path, `${upgraded}\nPOLICYGRAPH_AUDIT_CHECKPOINT_DIR=./.policygraph/checkpoints\n`, { encoding: "utf8", mode: 0o600 });
        console.log("Added the non-secret audit checkpoint directory to the existing .env.");
      } else {
        console.log("Existing .env already contains the audit checkpoint directory.");
      }
      process.exit(0);
    }
    throw new Error(".env already exists. It was preserved; move it manually before generating a replacement.");
  }
  throw error;
}
