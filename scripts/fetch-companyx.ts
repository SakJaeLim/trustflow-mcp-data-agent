import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const DATASET_URL = "https://liwonace.co.kr/downloads/companyx-dataset-v1.0.zip";
const EXPECTED_SHA256 = "3008476738d992857d738337b4882772e88288f7b314da235d6a5d120827d772";
const MAX_ARCHIVE_BYTES = 16 * 1_048_576;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export function safeArchivePath(name: string): string {
  const normalized = name.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (
    !normalized
    || normalized.includes("\0")
    || normalized.startsWith("/")
    || /^[a-z]:/iu.test(normalized)
    || segments.some((segment) => segment === "..")
  ) throw new Error(`Unsafe ZIP entry path: ${JSON.stringify(name)}`);
  return segments.join("/");
}

export function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function verifiedArchive(archivePath: string): Promise<Uint8Array> {
  if (await exists(archivePath)) {
    const details = await stat(archivePath);
    if (!details.isFile() || details.size > MAX_ARCHIVE_BYTES) {
      throw new Error(`Existing archive exceeds the ${MAX_ARCHIVE_BYTES}-byte safety limit: ${archivePath}`);
    }
    const bytes = await readFile(archivePath);
    if (sha256Hex(bytes) !== EXPECTED_SHA256) {
      throw new Error(`Existing archive checksum mismatch. Preserve it for inspection: ${archivePath}`);
    }
    return bytes;
  }

  const response = await fetch(DATASET_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Dataset download failed: HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`Dataset response exceeds the ${MAX_ARCHIVE_BYTES}-byte safety limit.`);
  }
  if (!response.body) throw new Error("Dataset response has no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_ARCHIVE_BYTES) {
      await reader.cancel("dataset response too large");
      throw new Error(`Dataset response exceeds the ${MAX_ARCHIVE_BYTES}-byte safety limit.`);
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length);
  const actual = sha256Hex(bytes);
  if (actual !== EXPECTED_SHA256) {
    throw new Error(`Downloaded archive checksum mismatch. Expected ${EXPECTED_SHA256}, received ${actual}.`);
  }
  const temporary = `${archivePath}.${randomUUID()}.download`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, archivePath);
  } finally {
    await rm(temporary, { force: true });
  }
  return bytes;
}

async function extractedFiles(root: string, current = ""): Promise<Map<string, string>> {
  const directory = resolve(root, current);
  const items = await readdir(directory, { withFileTypes: true });
  const result = new Map<string, string>();
  for (const item of items) {
    const relativeName = current ? `${current}/${item.name}` : item.name;
    const path = join(directory, item.name);
    const details = await lstat(path);
    if (details.isSymbolicLink()) throw new Error(`Extracted dataset contains a symbolic link: ${relativeName}`);
    if (details.isDirectory()) {
      for (const [name, childPath] of await extractedFiles(root, relativeName)) result.set(name, childPath);
    } else if (details.isFile()) {
      result.set(relativeName.replaceAll("\\", "/"), path);
    } else {
      throw new Error(`Extracted dataset contains a non-regular entry: ${relativeName}`);
    }
  }
  return result;
}

async function verifyExtractedTree(extractPath: string, entries: Record<string, Uint8Array>): Promise<void> {
  const expected = new Map<string, Uint8Array>();
  for (const [rawName, content] of Object.entries(entries)) {
    const name = safeArchivePath(rawName);
    if (!rawName.endsWith("/") && !rawName.endsWith("\\")) expected.set(name, content);
  }
  const actual = await extractedFiles(extractPath);
  if (actual.size !== expected.size || [...expected.keys()].some((name) => !actual.has(name))) {
    throw new Error(`Existing extracted dataset does not match the verified archive: ${extractPath}`);
  }
  for (const [name, expectedBytes] of expected) {
    const path = actual.get(name);
    if (!path || sha256Hex(await readFile(path)) !== sha256Hex(expectedBytes)) {
      throw new Error(`Existing extracted dataset file drifted from the verified archive: ${name}`);
    }
  }
}

export async function installCompanyX(dataRoot = resolve("data")): Promise<void> {
  const root = resolve(dataRoot);
  const archiveDirectory = resolve(root, "raw");
  const archivePath = resolve(archiveDirectory, "companyx-dataset-v1.0.zip");
  const extractPath = resolve(root, "companyx");
  await mkdir(archiveDirectory, { recursive: true });
  const archive = await verifiedArchive(archivePath);
  const entries = unzipSync(archive);
  if (!entries["README.md"] || !entries["questions.json"]) {
    throw new Error("Archive does not contain the expected Company-X layout.");
  }

  if (await exists(resolve(extractPath, "README.md")) && await exists(resolve(extractPath, "questions.json"))) {
    await verifyExtractedTree(extractPath, entries);
    console.log(`Company-X dataset is already installed and fully verified: ${extractPath}`);
    return;
  }
  if (await exists(extractPath)) {
    throw new Error(`Extraction target exists but is incomplete. Preserve it for inspection: ${extractPath}`);
  }

  const temporary = resolve(root, `companyx-${randomUUID()}.extracting`);
  try {
    await mkdir(temporary, { recursive: false });
    for (const [rawName, content] of Object.entries(entries)) {
      const name = safeArchivePath(rawName);
      const target = resolve(temporary, name);
      const relativeTarget = relative(temporary, target);
      if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
        throw new Error(`ZIP entry escaped extraction root: ${rawName}`);
      }
      if (rawName.endsWith("/") || rawName.endsWith("\\")) {
        await mkdir(target, { recursive: true });
      } else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, { flag: "wx" });
      }
    }
    await verifyExtractedTree(temporary, entries);
    await rename(temporary, extractPath);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  console.log(`Company-X dataset installed: ${extractPath}`);
  console.log(`SHA-256: ${EXPECTED_SHA256}`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(currentFile)) {
  await installCompanyX(process.argv[2]);
}
