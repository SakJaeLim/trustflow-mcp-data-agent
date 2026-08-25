import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { splitMarkdown } from "../src/core/document-corpus.ts";
import { GraphStore } from "../src/tools/graph-store.ts";
import { LocalVectorSearch } from "../src/tools/local-vector-search.ts";
import { SqliteFixture } from "../src/tools/sqlite-fixture.ts";
import { loadVerifiedCompanyXQuestions, verifyCompanyXDataDirectory } from "../src/core/companyx-integrity.ts";
import { loadVerifiedDocumentCorpus } from "../src/core/document-corpus.ts";
import { embeddingSha256, loadEmbeddingAttestation } from "../src/core/postgres-integrity.ts";

test("official graph has the published size and traverses Client-A products", async () => {
  const graph = await GraphStore.fromDirectory(resolve("data/companyx/graph"));
  assert.equal(graph.nodeCount, 133);
  assert.equal(graph.edgeCount, 354);
  const result = graph.traverse("Client-A", [{ relation: "USES", direction: "out" }], 20);
  assert.ok(result.resultNodes.length > 0);
  assert.ok(result.resultNodes.every((node) => node.type === "product"));
  const ranked = graph.query({ mode: "rank", startType: "employee", path: [{ relation: "MANAGES_ACCOUNT", direction: "out" }], maxNodes: 1 });
  assert.equal(ranked.starts.length, 1);
  assert.equal(ranked.ranking?.length, 1);
});

test("local vector baseline finds the Product-C1 install guide", async () => {
  const search = await LocalVectorSearch.fromDirectory(resolve("data/companyx/documents"));
  const hits = await search.search("Product-C1 설치 방법", 5, "technical_doc");
  assert.equal(hits[0]?.id, "DOC-011");
  assert.ok((hits[0]?.score ?? 0) > 0);

  const root = await mkdtemp(join(tmpdir(), "policygraph-corpus-"));
  try {
    const documents = join(root, "documents");
    await mkdir(documents);
    await writeFile(join(root, "outside.md"), "secret", "utf8");
    await writeFile(join(documents, "index.json"), JSON.stringify([
      { id: "DOC-X", type: "technical_doc", title: "unsafe", filename: "../outside.md" },
    ]), "utf8");
    await assert.rejects(LocalVectorSearch.fromDirectory(documents), /Unsafe document filename/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const chunks = splitMarkdown("x".repeat(5_000));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1_200));
});

test("SQLite fixture executes queries over the official PostgreSQL seed", async () => {
  const database = await SqliteFixture.fromDataset(resolve("data/companyx/sql"));
  try {
    const employees = await database.query("SELECT COUNT(*) AS count FROM employees LIMIT 100");
    const sales = await database.query(
      "SELECT SUM(amount) AS total_sales FROM sales WHERE quarter = '2025-Q3' LIMIT 100",
    );
    assert.equal(Number(employees.rows[0]?.count), 45);
    assert.ok(Number(sales.rows[0]?.total_sales) > 0);
    const bounded = await database.query(
      "SELECT e.id FROM employees e CROSS JOIN products p CROSS JOIN (SELECT id FROM clients LIMIT 1) c",
      100,
    );
    assert.equal(bounded.rowCount, 100);
  } finally {
    await database.close();
  }
});

test("official questions and embedding attestation are schema- and hash-bound", async () => {
  const integrity = await verifyCompanyXDataDirectory();
  const questions = loadVerifiedCompanyXQuestions(integrity);
  assert.equal(questions.length, 30);
  assert.deepEqual(
    Object.fromEntries(["nl2sql", "vector_search", "knowledge_graph"].map((tool) => [tool, questions.filter((item) => item.tool === tool).length])),
    { nl2sql: 10, vector_search: 10, knowledge_graph: 10 },
  );
  const corpus = loadVerifiedDocumentCorpus(integrity);
  const manifestPath = resolve("evaluation/embedding-attestation.json");
  const attestation = await loadEmbeddingAttestation(manifestPath, integrity, corpus, "nomic-embed-text");
  assert.equal(attestation.hashes.size, corpus.chunks.length);
  assert.match(attestation.manifestSha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.notEqual(embeddingSha256([1, 2, 3]), embeddingSha256([1, 2, 4]));

  const root = await mkdtemp(join(tmpdir(), "policygraph-embedding-attestation-"));
  try {
    const tamperedPath = join(root, "tampered.json");
    const tampered = (await readFile(manifestPath, "utf8")).replace(/"dimensions": 768/u, '"dimensions": 767');
    await writeFile(tamperedPath, tampered, "utf8");
    await assert.rejects(loadEmbeddingAttestation(tamperedPath, integrity, corpus, "nomic-embed-text"), /header|model|dataset|generation|cardinality/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
