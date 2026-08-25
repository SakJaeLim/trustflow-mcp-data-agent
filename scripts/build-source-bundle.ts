import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { inspectZipArchive, verifyUnzippedZipEntries } from "../src/core/archive-safety.ts";
import { assertReleaseFilesSafe } from "../src/core/release-secret-scan.ts";
import { SOURCE_EXCLUSIONS, snapshotSourceRelease } from "../src/core/source-release.ts";

const workspace = resolve(".");
const packageDocument = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { version: string };
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(packageDocument.version)) {
  throw new Error("package.json version must be a strict SemVer value.");
}
const bundleRoot = `trustflow-companyx-v${packageDocument.version}`;
const outputDirectory = resolve("artifacts/submission");
const outputPath = resolve(outputDirectory, `${bundleRoot}-source.zip`);
const fixedTimestamp = new Date("2026-08-24T00:00:00Z");
const zipLimits = {
  maxEntries: 5_000,
  maxCompressedBytes: 32 * 1_048_576,
  maxEntryUncompressedBytes: 32 * 1_048_576,
  maxTotalUncompressedBytes: 128 * 1_048_576,
  maxCompressionRatio: 500,
};
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const files = await snapshotSourceRelease(workspace);
assertReleaseFilesSafe(files);

const archive: Zippable = {};
const manifestFiles: Array<{ path: string; bytes: number; sha256: string }> = [];
for (const file of files) {
  archive[`${bundleRoot}/${file.path}`] = [file.bytes, { level: 9, mtime: fixedTimestamp }];
  manifestFiles.push({ path: file.path, bytes: file.bytes.byteLength, sha256: file.sha256 });
}
const manifest = {
  schemaVersion: "1.0",
  release: packageDocument.version,
  generatedAt: fixedTimestamp.toISOString(),
  fileCount: manifestFiles.length,
  excluded: [...SOURCE_EXCLUSIONS],
  files: manifestFiles,
};
const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
archive[`${bundleRoot}/SOURCE_MANIFEST.json`] = [manifestBytes, { level: 9, mtime: fixedTimestamp }];

await mkdir(outputDirectory, { recursive: true });
const zip = zipSync(archive, { level: 9 });
if (zip.byteLength > 32 * 1_048_576) throw new Error("Source bundle exceeds the 32 MiB output limit.");
await writeFile(outputPath, zip);

const metadata = inspectZipArchive(zip, zipLimits);
const unpacked = unzipSync(zip);
verifyUnzippedZipEntries(metadata, unpacked);
for (const item of manifestFiles) {
  const entry = unpacked[`${bundleRoot}/${item.path}`];
  if (!entry || sha256(entry) !== item.sha256) throw new Error(`Source bundle verification failed: ${item.path}`);
}
if (Object.keys(unpacked).length !== manifestFiles.length + 1) {
  throw new Error("Source bundle contains an unexpected entry.");
}
console.log(`Verified source bundle: ${outputPath} (${manifestFiles.length} source files + manifest).`);
