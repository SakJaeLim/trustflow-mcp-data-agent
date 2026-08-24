# Ollama Gemma 4 evaluation

- Model: gemma4:e2b
- Evaluated paraphrases: 30 / 90
- Plan schema success: 100.0%
- Raw LLM tool accuracy: 93.3%
- PolicyGraph-normalized tool accuracy: 100.0%
- Policy acceptance: 100.0%
- Execution success: 100.0%
- Semantic correctness: 100.0%
- P50 / P95 plan latency: 22818 ms / 41008 ms
- Evidence-answer samples: 3; model accepted 2; safe fallback 1; citation integrity PASS

The full 90-paraphrase fixture is versioned in `evaluation/paraphrases.json`. The default live run evaluates one representative paraphrase for each official question because the installed 7.2 GB model runs on CPU; set `OLLAMA_EVAL_VARIANTS=all` for all 90. The raw, pre-normalization baseline is preserved in `artifacts/evaluation/ollama-planner-results-raw.json`. An answer that does not satisfy claim-level evidence validation is counted as a safe deterministic fallback rather than a model answer. Results are public-fixture measurements, not hidden-test claims.
