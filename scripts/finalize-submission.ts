import { createHash } from "node:crypto";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { unzipSync } from "fflate";
import { canonicalArchivePath, inspectZipArchive } from "../src/core/archive-safety.ts";

const directory = resolve("artifacts/submission");
const docx = resolve(directory, "2026 오픈소스 개발자대회 결과보고서_555(corevalue).docx");
const pdf = resolve(directory, "2026 오픈소스 개발자대회 결과보고서_555(corevalue).pdf");
const sbom = resolve(directory, "policygraph-sbom.cdx.json");
const sourceZip = resolve(directory, "trustflow-companyx-v0.3.0-source.zip");
const video = resolve(directory, "TrustFlow_MCP_Data_Agent_3min_Demo_corevalue.mp4");
const subtitles = resolve(directory, "TrustFlow_MCP_Data_Agent_3min_Demo_corevalue.srt");
const uploadNotes = resolve(directory, "VIDEO_UPLOAD.md");
const sourceRoot = "trustflow-companyx-v0.3.0/";
const zipLimits = {
  maxEntries: 5_000,
  maxCompressedBytes: 32 * 1_048_576,
  maxEntryUncompressedBytes: 32 * 1_048_576,
  maxTotalUncompressedBytes: 128 * 1_048_576,
  maxCompressionRatio: 500,
};
await copyFile(resolve("artifacts/compliance/policygraph-sbom.cdx.json"), sbom);

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
for (const path of required) {
  const details = await stat(path);
  if (!details.isFile() || details.size === 0) throw new Error(`Missing submission artifact: ${path}`);
}

const docxBytes = await readFile(docx);
inspectZipArchive(docxBytes, zipLimits);
const docxEntries = unzipSync(docxBytes);
for (const name of ["[Content_Types].xml", "word/document.xml", "word/styles.xml"]) {
  if (!docxEntries[name]) throw new Error(`DOCX is missing ${name}.`);
}
const documentXml = new TextDecoder().decode(docxEntries["word/document.xml"]);
const reportText = documentXml.replace(/<[^>]+>/gu, "").replaceAll("&amp;", "&");
for (const token of ["37/37", "30/30", "HMAC", "pgsql-ast-parser", "약 80%", "중복수혜", "해당 없음", "https://github.com/SakJaeLim/trustflow-mcp-data-agent"]) {
  if (!reportText.includes(token)) throw new Error(`DOCX does not contain current release token: ${token}`);
}
for (const stale of ["24/24", "36/36", "111 components", "12개 정책 노드"]) {
  if (reportText.includes(stale)) throw new Error(`DOCX contains stale release text: ${stale}`);
}

const pdfBytes = await readFile(pdf);
if (!pdfBytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Result report is not a PDF.");
const videoBytes = await readFile(video);
if (videoBytes.length < 12 || videoBytes.subarray(4, 8).toString("ascii") !== "ftyp") {
  throw new Error("Demo video is not an MP4 container.");
}
const subtitleText = await readFile(subtitles, "utf8");
if (!subtitleText.includes("00:00:04,000 -->") || !subtitleText.includes("TrustFlow")) {
  throw new Error("Demo subtitles are missing the expected timeline or title.");
}
const sbomDocument = JSON.parse(await readFile(sbom, "utf8")) as {
  bomFormat?: string;
  specVersion?: string;
  metadata?: { component?: { name?: string; version?: string } };
  components?: unknown[];
};
if (sbomDocument.bomFormat !== "CycloneDX"
  || sbomDocument.specVersion !== "1.5"
  || sbomDocument.metadata?.component?.name !== "trustflow-mcp-data-agent"
  || sbomDocument.metadata?.component?.version !== "0.3.0"
  || sbomDocument.components?.length !== 127) {
  throw new Error("Submission SBOM metadata or component inventory is inconsistent.");
}

const sourceBytes = await readFile(sourceZip);
const sourceMetadata = inspectZipArchive(sourceBytes, zipLimits);
if (sourceMetadata.some((entry) => !entry.name.startsWith(sourceRoot))) {
  throw new Error("Source ZIP must contain exactly one canonical release root.");
}
const sourceEntries = unzipSync(sourceBytes);
const sourceNames = Object.keys(sourceEntries);
const manifestName = `${sourceRoot}SOURCE_MANIFEST.json`;
const manifestBytes = sourceEntries[manifestName];
if (!manifestBytes) throw new Error("Source ZIP is missing SOURCE_MANIFEST.json.");
const sourceManifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
  fileCount?: number;
  files?: Array<{ path?: unknown; bytes?: unknown; sha256?: unknown }>;
};
if (!Array.isArray(sourceManifest.files) || sourceManifest.fileCount !== sourceManifest.files.length) {
  throw new Error("Source ZIP manifest file count is invalid.");
}
const expectedSourceNames = new Set<string>([manifestName]);
for (const item of sourceManifest.files) {
  if (typeof item.path !== "string" || typeof item.bytes !== "number" || typeof item.sha256 !== "string") {
    throw new Error("Source ZIP manifest contains an invalid file entry.");
  }
  const relativeName = canonicalArchivePath(item.path);
  if (relativeName.endsWith("/") || /^(?:\.env|data|sources|node_modules|\.policygraph|output|artifacts)(?:\/|$)/u.test(relativeName)) {
    throw new Error(`Source ZIP manifest contains a forbidden path: ${relativeName}`);
  }
  const name = `${sourceRoot}${relativeName}`;
  const bytes = sourceEntries[name];
  if (!bytes || bytes.byteLength !== item.bytes || createHash("sha256").update(bytes).digest("hex") !== item.sha256) {
    throw new Error(`Source ZIP manifest verification failed: ${relativeName}`);
  }
  expectedSourceNames.add(name);
}
if (sourceNames.length !== expectedSourceNames.size || sourceNames.some((name) => !expectedSourceNames.has(name))
  || !expectedSourceNames.has(`${sourceRoot}package-lock.json`)) {
  throw new Error("Source ZIP manifest, lockfile, or exclusion boundary is invalid.");
}

const lines: string[] = [];
for (const path of [...required].sort((left, right) => basename(left).localeCompare(basename(right)))) {
  const bytes = await readFile(path);
  const hash = createHash("sha256").update(bytes).digest("hex");
  lines.push(`${hash} *${basename(path)}`);
}
await writeFile(resolve(directory, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
console.log(`Submission package passed structural checks; wrote ${lines.length} SHA-256 entries.`);
