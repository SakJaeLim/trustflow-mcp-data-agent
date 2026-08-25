import { resolve } from "node:path";
import { OllamaEmbedder } from "../src/adapters/ollama-embedder.ts";
import { PostgresDatabase } from "../src/adapters/postgres.ts";
import {
  EMBEDDING_BATCH_SIZE,
  loadVerifiedDocumentCorpus,
} from "../src/core/document-corpus.ts";
import { verifyCompanyXDataDirectory } from "../src/core/companyx-integrity.ts";
import { embeddingSha256, loadEmbeddingAttestation } from "../src/core/postgres-integrity.ts";

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

async function main(): Promise<void> {
  const dataDirectory = resolve(process.env.COMPANYX_DATA_DIR ?? "data/companyx");
  const integrity = await verifyCompanyXDataDirectory(dataDirectory, process.env.COMPANYX_ARCHIVE_PATH);
  const connectionString = process.env.DATABASE_ADMIN_URL;
  if (!connectionString) throw new Error("DATABASE_ADMIN_URL is required for document ingestion.");

  const database = new PostgresDatabase(connectionString, 30_000);
  const embedModel = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
  const embedder = new OllamaEmbedder(
    process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    embedModel,
  );

  try {
    const [databaseIdentity] = await database.queryRows<{ role_name: string; database_name: string }>(
      "SELECT current_user AS role_name, current_database() AS database_name",
    );
    if (databaseIdentity?.role_name !== "policygraph_admin" || databaseIdentity.database_name !== "companyx") {
      throw new Error("Document ingestion requires the local companyx database and policygraph_admin role.");
    }
    const corpus = loadVerifiedDocumentCorpus(integrity);
    const embeddingAttestation = await loadEmbeddingAttestation(
      resolve(process.env.POLICYGRAPH_EMBEDDING_ATTESTATION_PATH ?? "evaluation/embedding-attestation.json"),
      integrity,
      corpus,
      embedModel,
    );
    const prepared: Array<{ document: (typeof corpus.documents)[number]; chunkIndex: number; content: string; vector: number[] }> = [];
    for (const document of corpus.documents) {
      const embeddings: number[][] = [];
      for (let offset = 0; offset < document.chunks.length; offset += EMBEDDING_BATCH_SIZE) {
        embeddings.push(...await embedder.embed(
          document.chunks.slice(offset, offset + EMBEDDING_BATCH_SIZE).map((chunk) => `search_document: ${chunk.content}`),
        ));
      }
      for (let indexPosition = 0; indexPosition < document.chunks.length; indexPosition += 1) {
        const chunk = document.chunks[indexPosition];
        if (!chunk || !embeddings[indexPosition]) throw new Error(`Embedding preparation failed for ${document.id}:${indexPosition}.`);
        const vector = embeddings[indexPosition];
        const expectedEmbeddingSha256 = embeddingAttestation.hashes.get(`${document.id}:${indexPosition}`);
        if (!expectedEmbeddingSha256 || embeddingSha256(vector) !== expectedEmbeddingSha256) {
          throw new Error(`Embedding differs from the release attestation: ${document.id}:${indexPosition}.`);
        }
        prepared.push({ document, chunkIndex: indexPosition, content: chunk.content, vector });
      }
      console.error(`[ingest] prepared ${document.id}: ${document.chunks.length} chunks`);
    }

    await database.withWriteTransaction(async (transaction) => {
      await transaction.write("SELECT pg_advisory_xact_lock(746112390)");
      await transaction.write("DELETE FROM document_chunks");
      for (const item of prepared) {
        const chunk = item.document.chunks[item.chunkIndex]!;
        const metadata = {
          type: item.document.type,
          title: item.document.title,
          filename: item.document.filename,
          datasetSha256: integrity.datasetSha256,
          generationSha256: corpus.generationSha256,
          sourceSha256: chunk.sourceSha256,
          chunkSha256: chunk.chunkSha256,
          embeddingModel: embedModel,
          embeddingSha256: embeddingSha256(item.vector),
          embeddingAttestationSha256: embeddingAttestation.manifestSha256,
        };
        await transaction.write(
          `INSERT INTO document_chunks (doc_id, chunk_index, content, embedding, metadata)
           VALUES ($1, $2, $3, $4::vector, $5::jsonb)
           ON CONFLICT (doc_id, chunk_index)
           DO UPDATE SET content = EXCLUDED.content,
                         embedding = EXCLUDED.embedding,
                         metadata = EXCLUDED.metadata`,
          [item.document.id, item.chunkIndex, item.content, vectorLiteral(item.vector), JSON.stringify(metadata)],
        );
      }
    });
    console.error(`[ingest] complete: ${prepared.length} authenticated chunks; generation ${corpus.generationSha256}`);
  } finally {
    await database.close();
  }
}

await main();
