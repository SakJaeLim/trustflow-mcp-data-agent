import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

const execute = promisify(execFile);
const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : "npm";
const prefix = npmCli ? [npmCli] : [];
const cacheDirectory = await mkdtemp(join(tmpdir(), "policygraph-npm-cache-"));
let stdout: string;
try {
  ({ stdout } = await execute(command, [...prefix, "pack", "--dry-run", "--json", "--cache", cacheDirectory], {
    cwd: resolve("."),
    maxBuffer: 16 * 1024 * 1024,
  }));
} finally {
  await rm(cacheDirectory, { recursive: true, force: true });
}
const packs = JSON.parse(stdout) as Array<{ files?: Array<{ path: string }> }>;
const names = new Set((packs[0]?.files ?? []).map((item) => item.path.replaceAll("\\", "/")));
const forbidden = [...names].filter((name) =>
  name === ".env"
  || name.startsWith("data/")
  || name.startsWith("sources/")
  || name.startsWith("node_modules/")
  || name.startsWith(".policygraph/")
  || name.startsWith("output/")
);
const required = ["package.json", "README.md", "LICENSE", "src/mcp/server.ts", "SECURITY.md"];
const missing = required.filter((name) => !names.has(name));
if (forbidden.length > 0 || missing.length > 0) {
  throw new Error(`Package verification failed. Forbidden: ${forbidden.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`);
}
console.log(`Package dry-run passed: ${names.size} files, no dataset, local secret, or runtime state.`);
