import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { unzipSync } from "fflate";
import { canonicalArchivePath, inspectZipArchive, verifyUnzippedZipEntries } from "../src/core/archive-safety.ts";
import { assertReleaseFilesSafe } from "../src/core/release-secret-scan.ts";
import { readRegularFileBounded } from "../src/core/safe-file.ts";
import { SOURCE_EXCLUSIONS, snapshotSourceRelease } from "../src/core/source-release.ts";

const directory = resolve("artifacts/submission");
const packageDocument = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { version: string };
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(packageDocument.version)) {
  throw new Error("Submission package version must be a stable SemVer value.");
}
const docx = resolve(directory, "2026 오픈소스 개발자대회 결과보고서_555(corevalue).docx");
const pdf = resolve(directory, "2026 오픈소스 개발자대회 결과보고서_555(corevalue).pdf");
const sbom = resolve(directory, "policygraph-sbom.cdx.json");
const sourceZip = resolve(directory, `trustflow-companyx-v${packageDocument.version}-source.zip`);
const video = resolve(directory, "TrustFlow_MCP_Data_Agent_3min_Demo_corevalue.mp4");
const subtitles = resolve(directory, "TrustFlow_MCP_Data_Agent_3min_Demo_corevalue.srt");
const uploadNotes = resolve(directory, "VIDEO_UPLOAD.md");
const sourceRoot = `trustflow-companyx-v${packageDocument.version}/`;
const zipLimits = {
  maxEntries: 5_000,
  maxCompressedBytes: 32 * 1_048_576,
  maxEntryUncompressedBytes: 32 * 1_048_576,
  maxTotalUncompressedBytes: 128 * 1_048_576,
  maxCompressionRatio: 500,
};
const complianceSbom = (await readRegularFileBounded(
  resolve("artifacts/compliance/policygraph-sbom.cdx.json"),
  16 * 1_048_576,
)).bytes;
await writeFile(sbom, complianceSbom);

const required = [
  docx,
  pdf,
  resolve(directory, "README.md"),
  resolve(directory, "SBOM_CORE.csv"),
  resolve(directory, "SUBMISSION_CHECKLIST.md"),
  sbom,
  sourceZip,
  video,
  subtitles,
  uploadNotes,
];
const limits = new Map<string, number>([
  [docx, 32 * 1_048_576], [pdf, 64 * 1_048_576], [sourceZip, 32 * 1_048_576],
  [video, 256 * 1_048_576], [subtitles, 2 * 1_048_576], [uploadNotes, 2 * 1_048_576],
  [sbom, 16 * 1_048_576], [resolve(directory, "README.md"), 4 * 1_048_576],
  [resolve(directory, "SBOM_CORE.csv"), 4 * 1_048_576],
  [resolve(directory, "SUBMISSION_CHECKLIST.md"), 4 * 1_048_576],
]);
const artifactBytes = new Map<string, Buffer>();
for (const path of required) {
  const bytes = (await readRegularFileBounded(path, limits.get(path) ?? 16 * 1_048_576)).bytes;
  if (bytes.byteLength === 0) throw new Error(`Missing submission artifact: ${path}`);
  artifactBytes.set(path, bytes);
}

const docxBytes = artifactBytes.get(docx)!;
const docxMetadata = inspectZipArchive(docxBytes, zipLimits);
const docxEntries = unzipSync(docxBytes);
verifyUnzippedZipEntries(docxMetadata, docxEntries);
for (const name of ["[Content_Types].xml", "word/document.xml", "word/styles.xml"]) {
  if (!docxEntries[name]) throw new Error(`DOCX is missing ${name}.`);
}
const documentXml = new TextDecoder().decode(docxEntries["word/document.xml"]);
const reportText = documentXml.replace(/<[^>]+>/gu, "").replaceAll("&amp;", "&");
for (const token of ["49/49", "30/30", "HMAC", "pgsql-ast-parser", "약 80%", "중복수혜", "해당 없음", "https://github.com/SakJaeLim/trustflow-mcp-data-agent"]) {
  if (!reportText.includes(token)) throw new Error(`DOCX does not contain current release token: ${token}`);
}
for (const stale of ["24/24", "36/36", "37/37", "43/43", "48/48", "111 components", "12개 정책 노드"]) {
  if (reportText.includes(stale)) throw new Error(`DOCX contains stale release text: ${stale}`);
}

const pdfBytes = artifactBytes.get(pdf)!;
if (!pdfBytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Result report is not a PDF.");
const videoBytes = artifactBytes.get(video)!;
if (videoBytes.length < 12 || videoBytes.subarray(4, 8).toString("ascii") !== "ftyp") {
  throw new Error("Demo video is not an MP4 container.");
}
const subtitleText = artifactBytes.get(subtitles)!.toString("utf8");
if (!subtitleText.includes("00:00:04,000 -->") || !subtitleText.includes("TrustFlow")) {
  throw new Error("Demo subtitles are missing the expected timeline or title.");
}
const sbomDocument = JSON.parse(artifactBytes.get(sbom)!.toString("utf8")) as {
  bomFormat?: string;
  specVersion?: string;
  metadata?: {
    component?: { name?: string; version?: string };
    properties?: Array<{ name?: string; value?: string }>;
  };
  components?: unknown[];
};
if (sbomDocument.bomFormat !== "CycloneDX"
  || sbomDocument.specVersion !== "1.5"
  || sbomDocument.metadata?.component?.name !== "trustflow-mcp-data-agent"
  || sbomDocument.metadata?.component?.version !== packageDocument.version
  || sbomDocument.components?.length !== 127) {
  throw new Error("Submission SBOM metadata or component inventory is inconsistent.");
}
const sbomProperties = new Map((sbomDocument.metadata?.properties ?? []).map((item) => [item.name, item.value]));
const currentPackageLockSha256 = createHash("sha256").update(await readFile(resolve("package-lock.json"))).digest("hex");
const currentComposeSha256 = createHash("sha256").update(await readFile(resolve("compose.yaml"))).digest("hex");
if (sbomProperties.get("policygraph:packageLockSha256") !== currentPackageLockSha256
  || sbomProperties.get("policygraph:composeSha256") !== currentComposeSha256) {
  throw new Error("Submission SBOM is stale relative to package-lock.json or compose.yaml.");
}

const sourceBytes = artifactBytes.get(sourceZip)!;
const sourceMetadata = inspectZipArchive(sourceBytes, zipLimits);
if (sourceMetadata.some((entry) => !entry.name.startsWith(sourceRoot))) {
  throw new Error("Source ZIP must contain exactly one canonical release root.");
}
const sourceEntries = unzipSync(sourceBytes);
verifyUnzippedZipEntries(sourceMetadata, sourceEntries);
const sourceNames = Object.keys(sourceEntries);
const manifestName = `${sourceRoot}SOURCE_MANIFEST.json`;
const manifestBytes = sourceEntries[manifestName];
if (!manifestBytes) throw new Error("Source ZIP is missing SOURCE_MANIFEST.json.");
const sourceManifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
  schemaVersion?: unknown;
  release?: unknown;
  generatedAt?: unknown;
  excluded?: unknown;
  fileCount?: number;
  files?: Array<{ path?: unknown; bytes?: unknown; sha256?: unknown }>;
};
const authorizedFiles = await snapshotSourceRelease(resolve("."));
const authorizedByPath = new Map(authorizedFiles.map((item) => [item.path, item]));
if (sourceManifest.schemaVersion !== "1.0"
  || sourceManifest.release !== packageDocument.version
  || sourceManifest.generatedAt !== "2026-08-24T00:00:00.000Z"
  || JSON.stringify(sourceManifest.excluded) !== JSON.stringify([...SOURCE_EXCLUSIONS])
  || !Array.isArray(sourceManifest.files)
  || sourceManifest.fileCount !== sourceManifest.files.length
  || sourceManifest.files.length !== authorizedFiles.length) {
  throw new Error("Source ZIP manifest file count is invalid.");
}
const expectedSourceNames = new Set<string>([manifestName]);
const manifestPaths = new Set<string>();
for (const item of sourceManifest.files) {
  if (typeof item.path !== "string" || typeof item.bytes !== "number" || typeof item.sha256 !== "string") {
    throw new Error("Source ZIP manifest contains an invalid file entry.");
  }
  const relativeName = canonicalArchivePath(item.path);
  if (manifestPaths.has(relativeName)) throw new Error(`Source ZIP manifest contains a duplicate path: ${relativeName}`);
  manifestPaths.add(relativeName);
  if (relativeName.endsWith("/") || /^(?:\.env|data|sources|node_modules|\.policygraph|output|artifacts)(?:\/|$)/iu.test(relativeName)) {
    throw new Error(`Source ZIP manifest contains a forbidden path: ${relativeName}`);
  }
  const name = `${sourceRoot}${relativeName}`;
  const bytes = sourceEntries[name];
  const authorized = authorizedByPath.get(relativeName);
  if (!authorized
    || item.bytes !== authorized.bytes.byteLength
    || item.sha256 !== authorized.sha256
    || !bytes
    || bytes.byteLength !== item.bytes
    || createHash("sha256").update(bytes).digest("hex") !== item.sha256) {
    throw new Error(`Source ZIP manifest verification failed: ${relativeName}`);
  }
  expectedSourceNames.add(name);
}
if (manifestPaths.size !== authorizedByPath.size || [...authorizedByPath.keys()].some((path) => !manifestPaths.has(path))) {
  throw new Error("Source ZIP manifest path set differs from the authorized source snapshot.");
}
if (sourceNames.length !== expectedSourceNames.size || sourceNames.some((name) => !expectedSourceNames.has(name))
  || !expectedSourceNames.has(`${sourceRoot}package-lock.json`)) {
  throw new Error("Source ZIP manifest, lockfile, or exclusion boundary is invalid.");
}
assertReleaseFilesSafe([
  { path: "SOURCE_MANIFEST.json", bytes: manifestBytes },
  ...[...manifestPaths].map((path) => ({ path, bytes: sourceEntries[`${sourceRoot}${path}`]! })),
]);

assertReleaseFilesSafe([
  ...[docx, pdf, video, subtitles, uploadNotes, sbom,
    resolve(directory, "README.md"), resolve(directory, "SBOM_CORE.csv"), resolve(directory, "SUBMISSION_CHECKLIST.md")]
    .filter((path) => path !== docx)
    .map((path) => ({ path: basename(path), bytes: artifactBytes.get(path)! })),
  ...Object.entries(docxEntries)
    .filter(([name]) => !name.endsWith("/"))
    .map(([name, bytes]) => ({ path: `${basename(docx)}!/${name}`, bytes })),
]);

const lines: string[] = [];
for (const path of [...required].sort((left, right) => basename(left).localeCompare(basename(right)))) {
  const bytes = artifactBytes.get(path)!;
  const hash = createHash("sha256").update(bytes).digest("hex");
  lines.push(`${hash} *${basename(path)}`);
}
await writeFile(resolve(directory, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
console.log(`Submission package passed structural checks; wrote ${lines.length} SHA-256 entries.`);
