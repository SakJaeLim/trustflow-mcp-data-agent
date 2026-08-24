import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(".");
const scanRoots = [
  "src", "scripts", "test", "db", "policy", "docs", "evaluation", "submission", ".github",
  ".env.example", "compose.yaml", "package.json", "README.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md",
];
const textExtensions = new Set([".ts", ".js", ".json", ".md", ".sql", ".ttl", ".yaml", ".yml", ".example", ""]);
const patterns = [
  { id: "private-key", expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { id: "cloud-token", expression: /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{20,})\b/u },
  { id: "legacy-db-password", expression: /policygraph_(?:admin|reader)_dev_only/u },
  { id: "credential-url", expression: /postgres(?:ql)?:\/\/[^:\s/]+:(?!REPLACE_WITH_|\$\{)[^@\s]+@/iu },
];

async function files(path: string): Promise<string[]> {
  let details;
  try {
    details = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (details.isFile()) return [path];
  const children = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(children
    .filter((item) => !item.isSymbolicLink())
    .map((item) => files(join(path, item.name))));
  return nested.flat();
}

const candidates = (await Promise.all(scanRoots.map((path) => files(resolve(path))))).flat()
  .filter((path) => textExtensions.has(extname(path).toLocaleLowerCase("en-US")))
  .filter((path) => !path.endsWith(join("scripts", "check-secrets.ts")));
const findings: Array<{ file: string; line: number; rule: string }> = [];
for (const path of candidates) {
  const content = await readFile(path, "utf8");
  const lines = content.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    for (const pattern of patterns) {
      pattern.expression.lastIndex = 0;
      if (pattern.expression.test(line)) findings.push({
        file: relative(root, path).replaceAll("\\", "/"),
        line: index + 1,
        rule: pattern.id,
      });
    }
  }
}
const directory = resolve("artifacts/compliance");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "secret-scan.json"), `${JSON.stringify({ scannedFiles: candidates.length, findings }, null, 2)}\n`, "utf8");
if (findings.length > 0) {
  throw new Error(`Secret scan failed: ${findings.map((item) => `${item.file}:${item.line} [${item.rule}]`).join(", ")}`);
}
console.log(`Secret scan passed for ${candidates.length} authored files (.env and datasets excluded).`);
