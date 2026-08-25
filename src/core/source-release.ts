import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { readRegularFileBounded } from "./safe-file.ts";

export const SOURCE_ROOTS = [
  ".env.example", ".github", ".gitignore", "CHANGELOG.md", "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md", "LICENSE", "NOTICE", "README.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md",
  "compose.yaml", "db", "docs", "evaluation", "package-lock.json", "package.json", "policy",
  "scripts", "src", "submission", "test", "tsconfig.json",
] as const;
export const SOURCE_EXCLUSIONS = [
  ".env", "artifacts", "data", "node_modules", "output", "sources", ".git", ".policygraph", ".playwright-cli",
] as const;
export const MAX_SOURCE_FILES = 500;
export const MAX_SOURCE_FILE_BYTES = 16 * 1_048_576;
export const MAX_SOURCE_TOTAL_BYTES = 64 * 1_048_576;

export interface SourceFileSnapshot {
  path: string;
  bytes: Buffer;
  sha256: string;
}

function normalized(path: string): string {
  return path.replaceAll("\\", "/");
}

export function forbiddenSourcePath(path: string): boolean {
  const canonical = normalized(path).normalize("NFC").toLocaleLowerCase("en-US");
  return canonical === ".env"
    || /^(?:artifacts|data|node_modules|output|sources|\.git|\.policygraph|\.playwright-cli)(?:\/|$)/u.test(canonical);
}

async function collect(workspace: string, path: string, output: string[]): Promise<void> {
  const absolute = resolve(workspace, path);
  const details = await lstat(absolute);
  if (details.isSymbolicLink()) throw new Error(`Source bundle refuses symbolic link: ${path}`);
  if (details.isFile()) {
    const relativePath = normalized(relative(workspace, absolute));
    if (forbiddenSourcePath(relativePath)) throw new Error(`Forbidden source-bundle path: ${relativePath}`);
    output.push(relativePath);
    if (output.length > MAX_SOURCE_FILES) throw new Error(`Source bundle exceeds ${MAX_SOURCE_FILES} files.`);
    return;
  }
  if (!details.isDirectory()) throw new Error(`Source bundle refuses non-regular path: ${path}`);
  for (const name of (await readdir(absolute)).sort()) await collect(workspace, join(path, name), output);
}

export async function snapshotSourceRelease(workspaceInput = resolve(".")): Promise<SourceFileSnapshot[]> {
  const workspace = resolve(workspaceInput);
  const workspacePhysical = await realpath(workspace);
  const paths: string[] = [];
  for (const root of SOURCE_ROOTS) await collect(workspace, root, paths);
  paths.sort();
  if (!paths.includes("package-lock.json")) throw new Error("Source bundle must include package-lock.json.");
  const collisionKeys = new Set<string>();
  const physicalIdentities = new Set<string>();
  const snapshots: SourceFileSnapshot[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const key = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (collisionKeys.has(key)) throw new Error(`Source bundle contains an equivalent duplicate path: ${path}`);
    collisionKeys.add(key);
    const absolute = resolve(workspace, path);
    const physicalBefore = await realpath(absolute);
    const physicalRelative = relative(workspacePhysical, physicalBefore);
    if (!physicalRelative || physicalRelative.startsWith("..") || resolve(workspacePhysical, physicalRelative) !== resolve(physicalBefore)) {
      throw new Error(`Source bundle path escaped the physical workspace: ${path}`);
    }
    const { bytes, identity } = await readRegularFileBounded(absolute, MAX_SOURCE_FILE_BYTES);
    const physicalAfter = await realpath(absolute);
    if (physicalBefore !== physicalAfter) throw new Error(`Source bundle path changed while reading: ${path}`);
    if (identity.nlink !== 1) throw new Error(`Source bundle refuses multi-link file: ${path}`);
    const physicalIdentity = `${identity.dev}:${identity.ino}`;
    if (physicalIdentities.has(physicalIdentity)) throw new Error(`Source bundle contains duplicate file identity: ${path}`);
    physicalIdentities.add(physicalIdentity);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_SOURCE_TOTAL_BYTES) throw new Error(`Source bundle exceeds ${MAX_SOURCE_TOTAL_BYTES} input bytes.`);
    snapshots.push({ path, bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return snapshots;
}
