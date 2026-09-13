---
"zelavis": minor
---

Approximate nearest neighbour index (ANN / usearch) and findPage score pagination.

- **Approximate Index & Rebuildable Projection**: Supported `usearch` as an optional
  peer dependency. Vectors remain stored authoritatively in the documents, and
  the approximate index is an in-memory projection that can be dropped and rebuilt
  from documents at any time via `rebuildVectorIndex` and `dropVectorIndex`.
- **Similarity on `findPage` with Score Cursor**: Added `similar` filter on `findPage`.
  Paging order is score descending (`score DESC, seq ASC`), with a cursor that
  reliably survives concurrent writes (`phase: "score", score, seq`).
- **Per-Read Metric Selection**: `SimilarFilter.metric` allows overriding the
  collection's declared metric per query (`cosine`, `dot`, `euclidean`).
- **Quantized Storage**: Added support for vector quantization formats (`"f32" | "f16" | "i8" | "b1"`)
  declared on `EmbeddingIndex` and validated on creation and embedding.
- **Recall Measurement**: Added `measureRecall(groundTruth, approximate)` to benchmark
  recall@k of the approximate index against the exact ground truth.
