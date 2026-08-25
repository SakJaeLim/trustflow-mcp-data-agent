import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { unzipSync } from "fflate";
import { canonicalArchivePath } from "./archive-safety.ts";
import { readRegularFileBounded } from "./safe-file.ts";

export const COMPANYX_DATASET_SHA256 = "3008476738d992857d738337b4882772e88288f7b314da235d6a5d120827d772";
export const MAX_COMPANYX_ARCHIVE_BYTES = 16 * 1_048_576;
const MAX_COMPANYX_FILES = 1_000;
const MAX_COMPANYX_FILE_BYTES = 16 * 1_048_576;

export interface CompanyXIntegrity {
  dataDirectory: string;
  archivePath: string;
  datasetSha256: typeof COMPANYX_DATASET_SHA256;
  fileCount: number;
  readFile(relativeName: string): Buffer;
}

export interface CompanyXQuestion {
  q: string;
  tool: "nl2sql" | "vector_search" | "knowledge_graph";
  hint: string;
}

export function loadVerifiedCompanyXQuestions(integrity: CompanyXIntegrity): CompanyXQuestion[] {
  const parsed = JSON.parse(integrity.readFile("questions.json").toString("utf8")) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 30) throw new Error("Verified Company-X questions must contain exactly 30 items.");
  const tools = new Map<CompanyXQuestion["tool"], number>([["nl2sql", 0], ["vector_search", 0], ["knowledge_graph", 0]]);
  const seen = new Set<string>();
  const questions = parsed.map((value, index): CompanyXQuestion => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Company-X question ${index + 1} is invalid.`);
    const item = value as Record<string, unknown>;
    const keys = Object.keys(item).sort();
    if (keys.join(",") !== "hint,q,tool"
      || typeof item.q !== "string"
      || typeof item.hint !== "string"
      || (item.tool !== "nl2sql" && item.tool !== "vector_search" && item.tool !== "knowledge_graph")
      || Buffer.byteLength(item.q, "utf8") === 0
      || Buffer.byteLength(item.q, "utf8") > 4_096
      || Buffer.byteLength(item.hint, "utf8") > 4_096
      || seen.has(item.q)) {
      throw new Error(`Company-X question ${index + 1} failed schema or uniqueness validation.`);
    }
    seen.add(item.q);
    tools.set(item.tool, (tools.get(item.tool) ?? 0) + 1);
    return { q: item.q, tool: item.tool, hint: item.hint };
  });
  if ([...tools.values()].some((count) => count !== 10)) throw new Error("Company-X questions must contain exactly 10 items per tool.");
  return questions;
}

export function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function extractedFiles(root: string, current = "", result = new Map<string, string>()): Promise<Map<string, string>> {
  const directory = resolve(root, current);
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relativeName = current ? `${current}/${item.name}` : item.name;
    const path = join(directory, item.name);
    const details = await lstat(path);
    if (details.isSymbolicLink()) throw new Error(`Company-X dataset contains a symbolic link: ${relativeName}`);
    if (details.isDirectory()) {
      await extractedFiles(root, relativeName, result);
    } else if (details.isFile()) {
      const canonical = canonicalArchivePath(relativeName.replaceAll("\\", "/"));
      const collisionKey = canonical.normalize("NFC").toLocaleLowerCase("en-US");
      if ([...result.keys()].some((name) => name.normalize("NFC").toLocaleLowerCase("en-US") === collisionKey)) {
        throw new Error(`Company-X dataset contains an equivalent duplicate path: ${relativeName}`);
      }
      result.set(canonical, path);
      if (result.size > MAX_COMPANYX_FILES) throw new Error(`Company-X dataset exceeds ${MAX_COMPANYX_FILES} files.`);
    } else {
      throw new Error(`Company-X dataset contains a non-regular entry: ${relativeName}`);
    }
  }
  return result;
}

export async function verifyCompanyXDataDirectory(
  dataDirectoryInput = resolve("data/companyx"),
  archivePathInput?: string,
): Promise<CompanyXIntegrity> {
  const dataDirectory = resolve(dataDirectoryInput);
  const archivePath = resolve(archivePathInput ?? join(dirname(dataDirectory), "raw", "companyx-dataset-v1.0.zip"));
  const archive = (await readRegularFileBounded(archivePath, MAX_COMPANYX_ARCHIVE_BYTES)).bytes;
  const archiveDigest = sha256Hex(archive);
  if (archiveDigest !== COMPANYX_DATASET_SHA256) {
    throw new Error(`Company-X archive checksum mismatch: ${archivePath}`);
  }

  const entries = unzipSync(archive);
  const expected = new Map<string, Uint8Array>();
  const expectedKeys = new Set<string>();
  for (const [rawName, content] of Object.entries(entries)) {
    const name = canonicalArchivePath(rawName.replaceAll("\\", "/"));
    if (name.endsWith("/")) continue;
    const collisionKey = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (expectedKeys.has(collisionKey)) throw new Error(`Company-X archive contains an equivalent duplicate path: ${name}`);
    expectedKeys.add(collisionKey);
    if (content.byteLength > MAX_COMPANYX_FILE_BYTES) throw new Error(`Company-X archive entry is too large: ${name}`);
    expected.set(name, content);
  }
  if (!expected.has("README.md") || !expected.has("questions.json") || expected.size > MAX_COMPANYX_FILES) {
    throw new Error("Company-X archive layout or file count is invalid.");
  }

  const actual = await extractedFiles(dataDirectory);
  if (actual.size !== expected.size || [...expected.keys()].some((name) => !actual.has(name))) {
    throw new Error(`Company-X extracted tree does not match the verified archive: ${dataDirectory}`);
  }
  for (const [name, expectedBytes] of expected) {
    const path = actual.get(name);
    if (!path) throw new Error(`Company-X extracted file is missing: ${name}`);
    const relativePath = relative(dataDirectory, path);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`Company-X file escaped the data directory: ${name}`);
    }
    const actualBytes = (await readRegularFileBounded(path, Math.max(1, expectedBytes.byteLength))).bytes;
    if (actualBytes.byteLength !== expectedBytes.byteLength || sha256Hex(actualBytes) !== sha256Hex(expectedBytes)) {
      throw new Error(`Company-X extracted file drifted from the verified archive: ${name}`);
    }
  }
  const snapshot = new Map([...expected].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  return {
    dataDirectory,
    archivePath,
    datasetSha256: COMPANYX_DATASET_SHA256,
    fileCount: expected.size,
    readFile(relativeName: string): Buffer {
      const name = canonicalArchivePath(relativeName.replaceAll("\\", "/"));
      if (name.endsWith("/")) throw new Error(`Company-X snapshot path is a directory: ${name}`);
      const bytes = snapshot.get(name);
      if (!bytes) throw new Error(`Company-X snapshot file is missing: ${name}`);
      return Buffer.from(bytes);
    },
  };
}
