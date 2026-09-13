---
"zelavis": minor
---

Inbound adjacency and bounded graph traversal (Graph Slice Two).

A collection with declared `EdgeDefinition`s can now be queried for inbound links:
answering "which documents link to document X", narrowing candidates through `where`,
`search`, or `geometry` before reading.

Inbound adjacency is implemented with zero target document re-versioning: reverse
edge postings are keyed under `Tag.EdgeReverse` (`0x10`) as `[Tag.EdgeReverse][edgeType][dstSeq][srcSeq]`,
and are owned entirely by the source document's lifecycle and manifest. Retractions,
rewrites, and segment sealing operate on both forward and reverse edge postings
without modifying target document manifests, payloads, or version numbers.

In addition, `documents.traverse` provides bounded breadth-first graph traversal
across declared edge types with cycle detection, configurable traversal `direction`
(`outbound`, `inbound`, or `both`), `maxDepth`, `maxVisits`, and per-hop filter
intersection. The traverse capability is exposed over HTTP at `POST /:collection/traverse`.
