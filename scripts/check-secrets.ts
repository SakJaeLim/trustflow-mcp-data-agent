import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scanReleaseFiles } from "../src/core/release-secret-scan.ts";
import { snapshotSourceRelease } from "../src/core/source-release.ts";

const snapshots = await snapshotSourceRelease(resolve("."));
const findings = scanReleaseFiles(snapshots);
const directory = resolve("artifacts/compliance");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "secret-scan.json"), `${JSON.stringify({ scannedFiles: snapshots.length, findings }, null, 2)}\n`, "utf8");
if (findings.length > 0) {
  throw new Error(`Secret scan failed: ${findings.map((item) => `${item.file}:${item.line} [${item.rule}]`).join(", ")}`);
}
console.log(`Secret scan passed for all ${snapshots.length} source-release files (.env and data roots excluded).`);
