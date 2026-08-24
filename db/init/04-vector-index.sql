CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_chunks_doc_chunk
    ON document_chunks(doc_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_doc_chunks_embedding_hnsw
    ON document_chunks USING hnsw (embedding vector_cosine_ops);
