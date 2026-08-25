import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { canonicalArchivePath, inspectZipArchive, verifyUnzippedZipEntries } from "../src/core/archive-safety.ts";
import {
  COMPANYX_DATASET_SHA256,
  MAX_COMPANYX_ARCHIVE_BYTES,
  sha256Hex,
  verifyCompanyXDataDirectory,
} from "../src/core/companyx-integrity.ts";
import { readRegularFileBounded } from "../src/core/safe-file.ts";

const DATASET_URL = "https://liwonace.co.kr/downloads/companyx-dataset-v1.0.zip";
const DOWNLOAD_TIMEOUT_MS = 30_000;
const ZIP_LIMITS = {
  maxEntries: 1_000,
  maxCompressedBytes: MAX_COMPANYX_ARCHIVE_BYTES,
  maxEntryUncompressedBytes: 16 * 1_048_576,
  maxTotalUncompressedBytes: 64 * 1_048_576,
  maxCompressionRatio: 500,
};

export { sha256Hex } from "../src/core/companyx-integrity.ts";

export function safeArchivePath(name: string): string {
  return canonicalArchivePath(name.replaceAll("\\", "/")).replace(/\/$/u, "");
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
    const bytes = (await readRegularFileBounded(archivePath, MAX_COMPANYX_ARCHIVE_BYTES)).bytes;
    if (sha256Hex(bytes) !== COMPANYX_DATASET_SHA256) {
      throw new Error(`Existing archive checksum mismatch. Preserve it for inspection: ${archivePath}`);
    }
    inspectZipArchive(bytes, ZIP_LIMITS);
    return bytes;
  }

  const response = await fetch(DATASET_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Dataset download failed: HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_COMPANYX_ARCHIVE_BYTES) {
    throw new Error(`Dataset response exceeds the ${MAX_COMPANYX_ARCHIVE_BYTES}-byte safety limit.`);
  }
  if (!response.body) throw new Error("Dataset response has no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_COMPANYX_ARCHIVE_BYTES) {
      await reader.cancel("dataset response too large");
      throw new Error(`Dataset response exceeds the ${MAX_COMPANYX_ARCHIVE_BYTES}-byte safety limit.`);
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length);
  const actual = sha256Hex(bytes);
  if (actual !== COMPANYX_DATASET_SHA256) {
    throw new Error(`Downloaded archive checksum mismatch. Expected ${COMPANYX_DATASET_SHA256}, received ${actual}.`);
  }
  inspectZipArchive(bytes, ZIP_LIMITS);
  const temporary = `${archivePath}.${randomUUID()}.download`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, archivePath);
  } finally {
    await rm(temporary, { force: true });
  }
  return bytes;
}

export async function installCompanyX(dataRoot = resolve("data")): Promise<void> {
  const root = resolve(dataRoot);
  const archiveDirectory = resolve(root, "raw");
  const archivePath = resolve(archiveDirectory, "companyx-dataset-v1.0.zip");
  const extractPath = resolve(root, "companyx");
  await mkdir(archiveDirectory, { recursive: true });
  const archive = await verifiedArchive(archivePath);
  const metadata = inspectZipArchive(archive, ZIP_LIMITS);
  const entries = unzipSync(archive);
  verifyUnzippedZipEntries(metadata, entries);
  if (!entries["README.md"] || !entries["questions.json"]) {
    throw new Error("Archive does not contain the expected Company-X layout.");
  }

  if (await exists(resolve(extractPath, "README.md")) && await exists(resolve(extractPath, "questions.json"))) {
    await verifyCompanyXDataDirectory(extractPath, archivePath);
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
    await verifyCompanyXDataDirectory(temporary, archivePath);
    await rename(temporary, extractPath);
    try {
      await verifyCompanyXDataDirectory(extractPath, archivePath);
    } catch (error) {
      await rm(extractPath, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  console.log(`Company-X dataset installed: ${extractPath}`);
  console.log(`SHA-256: ${COMPANYX_DATASET_SHA256}`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(currentFile)) {
  await installCompanyX(process.argv[2]);
}
