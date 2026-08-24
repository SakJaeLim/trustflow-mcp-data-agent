import { resolve } from "node:path";
import { OllamaEmbedder } from "../src/adapters/ollama-embedder.ts";
import { PostgresDatabase } from "../src/adapters/postgres.ts";
import {
  EMBEDDING_BATCH_SIZE,
  loadDocumentIndex,
  MAX_CHUNKS_PER_DOCUMENT,
  MAX_CORPUS_BYTES,
  readDocumentMarkdown,
  splitMarkdown,
} from "../src/core/document-corpus.ts";

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

async function main(): Promise<void> {
  const dataDirectory = resolve(process.env.COMPANYX_DATA_DIR ?? "data/companyx");
  const connectionString = process.env.DATABASE_ADMIN_URL;
  if (!connectionString) throw new Error("DATABASE_ADMIN_URL is required for document ingestion.");

  const database = new PostgresDatabase(connectionString, 30_000);
  const embedder = new OllamaEmbedder(
    process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text",
  );

  try {
    const documentsDirectory = resolve(dataDirectory, "documents");
    const index = await loadDocumentIndex(documentsDirectory);
    let inserted = 0;
    let corpusBytes = 0;

    for (const document of index) {
      const { content: markdown, bytes } = await readDocumentMarkdown(documentsDirectory, document.filename);
      corpusBytes += bytes;
      if (corpusBytes > MAX_CORPUS_BYTES) throw new Error(`Document corpus exceeds ${MAX_CORPUS_BYTES} bytes.`);
      const chunks = splitMarkdown(markdown);
      if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
        throw new Error(`${document.id} exceeds ${MAX_CHUNKS_PER_DOCUMENT} chunks.`);
      }
      const embeddings: number[][] = [];
      for (let offset = 0; offset < chunks.length; offset += EMBEDDING_BATCH_SIZE) {
        embeddings.push(...await embedder.embed(
          chunks.slice(offset, offset + EMBEDDING_BATCH_SIZE).map((chunk) => `search_document: ${chunk}`),
        ));
      }
      await database.write("DELETE FROM document_chunks WHERE doc_id = $1", [document.id]);

      for (let indexPosition = 0; indexPosition < chunks.length; indexPosition += 1) {
        const metadata = {
          type: document.type,
          title: document.title,
          filename: document.filename,
        };
        await database.write(
          `INSERT INTO document_chunks (doc_id, chunk_index, content, embedding, metadata)
           VALUES ($1, $2, $3, $4::vector, $5::jsonb)
           ON CONFLICT (doc_id, chunk_index)
           DO UPDATE SET content = EXCLUDED.content,
                         embedding = EXCLUDED.embedding,
                         metadata = EXCLUDED.metadata`,
          [document.id, indexPosition, chunks[indexPosition], vectorLiteral(embeddings[indexPosition] ?? []), JSON.stringify(metadata)],
        );
        inserted += 1;
      }
      console.error(`[ingest] ${document.id}: ${chunks.length} chunks`);
    }
    console.error(`[ingest] complete: ${inserted} chunks`);
  } finally {
    await database.close();
  }
}

await main();
