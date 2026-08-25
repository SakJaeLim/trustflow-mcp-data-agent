# pgvector retrieval evaluation

- Labeled official vector questions: 10
- Corpus: 40 documents / 40 embedded chunks
- Embedding model: Ollama nomic-embed-text
- Relevance fixture SHA-256: 1c00ee70d82cebd13fd0dcbaa7c22dc7ef1e7ceda535963001b13afaf36137eb
- Hit@1 / @3 / @5: 100.0% / 100.0% / 100.0%
- Mean Recall@1 / @3 / @5: 58.4% / 85.3% / 97.1%
- MRR@10: 1.0000
- Cold-start warmup: 69.36 ms
- Warm P50 / P95 query latency: 102.03 ms / 132.02 ms

Labels were manually derived from the 40 official Markdown documents and retain source-line evidence in `evaluation/vector-relevance.json`. The evaluator validates its schema and records its exact hash. This is a public-fixture retrieval result, not a hidden-test or production claim.
