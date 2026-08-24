import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface LockedPackage {
  version?: string;
  license?: string;
  resolved?: string;
  dev?: boolean;
}

const lock = JSON.parse(await readFile(resolve("package-lock.json"), "utf8")) as {
  packages: Record<string, LockedPackage>;
};
const forbidden = /(?:^|\W)(?:AGPL|GPL|LGPL|SSPL|BUSL|Commons Clause|UNLICENSED)(?:$|\W)/iu;
const entries = Object.entries(lock.packages)
  .filter(([path]) => path.startsWith("node_modules/"))
  .map(([path, item]) => ({
    name: path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length),
    version: item.version ?? "unknown",
    license: item.license ?? "UNKNOWN",
    development: item.dev === true,
    source: item.resolved ?? "",
  }))
  .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
const failures = entries.filter((item) => item.license === "UNKNOWN" || forbidden.test(item.license));
const directory = resolve("artifacts/compliance");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "licenses.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), packages: entries, failures }, null, 2)}\n`, "utf8");
const rows = entries.map((item) => `| ${item.name} | ${item.version} | ${item.license} | ${item.development ? "dev" : "runtime"} |`);
await writeFile(
  resolve(directory, "LICENSE_REPORT.md"),
  `# Dependency license report\n\n- Packages: ${entries.length}\n- Missing or blocked licenses: ${failures.length}\n\n| Package | Version | License | Scope |\n|---|---:|---|---|\n${rows.join("\n")}\n`,
  "utf8",
);
if (failures.length > 0) {
  throw new Error(`License check failed: ${failures.map((item) => `${item.name}@${item.version} (${item.license})`).join(", ")}`);
}
console.log(`License check passed for ${entries.length} installed packages.`);
