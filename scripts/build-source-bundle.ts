import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { unzipSync, zipSync, type Zippable } from "fflate";

const workspace = resolve(".");
const packageDocument = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { version: string };
const bundleRoot = `trustflow-companyx-v${packageDocument.version}`;
const outputDirectory = resolve("artifacts/submission");
const outputPath = resolve(outputDirectory, `${bundleRoot}-source.zip`);
const fixedTimestamp = new Date("2026-08-24T00:00:00Z");
const roots = [
  ".env.example", ".github", ".gitignore", "CHANGELOG.md", "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md", "LICENSE", "NOTICE", "README.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md",
  "compose.yaml", "db", "docs", "evaluation", "package-lock.json", "package.json", "policy",
  "scripts", "src", "submission", "test", "tsconfig.json",
];

function normalized(path: string): string {
  return path.replaceAll("\\", "/");
}

function forbidden(path: string): boolean {
  return path === ".env"
    || /^(?:artifacts|data|node_modules|output|sources|\.git|\.policygraph|\.playwright-cli)(?:\/|$)/u.test(path);
}

async function collect(path: string): Promise<string[]> {
  const absolute = resolve(workspace, path);
  const details = await lstat(absolute);
  if (details.isSymbolicLink()) throw new Error(`Source bundle refuses symbolic link: ${path}`);
  if (details.isFile()) return [normalized(relative(workspace, absolute))];
  const children = await readdir(absolute);
  const nested = await Promise.all(children.map((name) => collect(join(path, name))));
  return nested.flat();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const files = (await Promise.all(roots.map(collect))).flat().sort();
const blocked = files.filter(forbidden);
if (blocked.length > 0) throw new Error(`Forbidden source-bundle paths: ${blocked.join(", ")}`);
if (!files.includes("package-lock.json")) throw new Error("Source bundle must include package-lock.json.");

const archive: Zippable = {};
const manifestFiles: Array<{ path: string; bytes: number; sha256: string }> = [];
for (const path of files) {
  const bytes = await readFile(resolve(workspace, path));
  archive[`${bundleRoot}/${path}`] = [bytes, { level: 9, mtime: fixedTimestamp }];
  manifestFiles.push({ path, bytes: bytes.byteLength, sha256: sha256(bytes) });
}
const manifest = {
  schemaVersion: "1.0",
  release: packageDocument.version,
  generatedAt: fixedTimestamp.toISOString(),
  fileCount: manifestFiles.length,
  excluded: [".env", "artifacts", "data", "node_modules", "output", "sources", ".git", ".policygraph", ".playwright-cli"],
  files: manifestFiles,
};
const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
archive[`${bundleRoot}/SOURCE_MANIFEST.json`] = [manifestBytes, { level: 9, mtime: fixedTimestamp }];

await mkdir(outputDirectory, { recursive: true });
const zip = zipSync(archive, { level: 9 });
await writeFile(outputPath, zip);

const unpacked = unzipSync(zip);
for (const item of manifestFiles) {
  const entry = unpacked[`${bundleRoot}/${item.path}`];
  if (!entry || sha256(entry) !== item.sha256) throw new Error(`Source bundle verification failed: ${item.path}`);
}
if (Object.keys(unpacked).length !== manifestFiles.length + 1) {
  throw new Error("Source bundle contains an unexpected entry.");
}
console.log(`Verified source bundle: ${outputPath} (${manifestFiles.length} source files + manifest).`);
