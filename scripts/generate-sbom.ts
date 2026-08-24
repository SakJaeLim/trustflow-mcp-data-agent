import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execute = promisify(execFile);
const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : "npm";
const prefix = npmCli ? [npmCli] : [];
const { stdout } = await execute(command, [...prefix,
  "sbom",
  "--sbom-format",
  "cyclonedx",
  "--package-lock-only",
  "--sbom-type",
  "application",
], { cwd: resolve("."), maxBuffer: 16 * 1024 * 1024 });
interface SbomComponent {
  "bom-ref": string;
  type: string;
  name: string;
  version: string;
  licenses: Array<{ license: { id: string } }>;
  purl?: string;
  properties?: Array<{ name: string; value: string }>;
  externalReferences?: Array<{ type: string; url: string }>;
}

interface SbomDocument {
  bomFormat?: string;
  specVersion?: string;
  metadata?: { component?: { "bom-ref"?: string; name?: string; version?: string } };
  components?: SbomComponent[];
  dependencies?: Array<{ ref: string; dependsOn?: string[] }>;
}

const parsed = JSON.parse(stdout) as SbomDocument;
if (parsed.bomFormat !== "CycloneDX" || !parsed.specVersion) {
  throw new Error("npm produced an invalid CycloneDX SBOM.");
}
const packageDocument = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { name: string; version: string };
if (parsed.metadata?.component) {
  parsed.metadata.component.name = packageDocument.name;
  parsed.metadata.component.version = packageDocument.version;
}
const externalComponents: SbomComponent[] = [
  { "bom-ref": "runtime:nodejs@24.14.1", type: "framework", name: "Node.js", version: "24.14.1", licenses: [{ license: { id: "MIT" } }], externalReferences: [{ type: "website", url: "https://nodejs.org/" }] },
  { "bom-ref": "service:postgresql@16.15", type: "database", name: "PostgreSQL", version: "16.15", licenses: [{ license: { id: "PostgreSQL" } }], externalReferences: [{ type: "website", url: "https://www.postgresql.org/" }] },
  { "bom-ref": "library:pgvector@0.8.6", type: "library", name: "pgvector", version: "0.8.6", licenses: [{ license: { id: "PostgreSQL" } }], externalReferences: [{ type: "vcs", url: "https://github.com/pgvector/pgvector" }] },
  { "bom-ref": "runtime:ollama@0.24.0", type: "framework", name: "Ollama", version: "0.24.0", licenses: [{ license: { id: "MIT" } }], externalReferences: [{ type: "vcs", url: "https://github.com/ollama/ollama" }] },
  { "bom-ref": "model:gemma4-e2b@7fbdbf8f5e45", type: "machine-learning-model", name: "gemma4:e2b", version: "7fbdbf8f5e45", licenses: [{ license: { id: "Apache-2.0" } }], externalReferences: [{ type: "distribution", url: "https://ollama.com/library/gemma4:e2b" }] },
  { "bom-ref": "model:nomic-embed-text@0a109f422b47", type: "machine-learning-model", name: "nomic-embed-text", version: "0a109f422b47", licenses: [{ license: { id: "Apache-2.0" } }], externalReferences: [{ type: "distribution", url: "https://ollama.com/library/nomic-embed-text" }] },
  {
    "bom-ref": "container:pgvector-0.8.6-pg16-bookworm",
    type: "container",
    name: "pgvector/pgvector",
    version: "0.8.6-pg16-bookworm",
    licenses: [{ license: { id: "PostgreSQL" } }],
    purl: "pkg:docker/pgvector/pgvector@0.8.6-pg16-bookworm",
    properties: [{ name: "policygraph:imageDigest", value: "sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b" }],
    externalReferences: [{ type: "distribution", url: "https://hub.docker.com/r/pgvector/pgvector" }],
  },
];
parsed.components ??= [];
const existingReferences = new Set(parsed.components.map((component) => component["bom-ref"]));
for (const component of externalComponents) {
  if (!existingReferences.has(component["bom-ref"])) parsed.components.push(component);
}
const rootReference = parsed.metadata?.component?.["bom-ref"];
const rootDependency = rootReference ? parsed.dependencies?.find((dependency) => dependency.ref === rootReference) : undefined;
if (rootDependency) {
  rootDependency.dependsOn = [...new Set([...(rootDependency.dependsOn ?? []), ...externalComponents.map((component) => component["bom-ref"])])].sort();
}
const directory = resolve("artifacts/compliance");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "policygraph-sbom.cdx.json"), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
console.log(`CycloneDX ${parsed.specVersion} SBOM written to artifacts/compliance/policygraph-sbom.cdx.json`);
