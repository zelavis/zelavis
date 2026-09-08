---
"zelavis": minor
---

Store postings as immutable bitmap blobs, so a wide query stops costing one
b-tree entry per object it matches.

`db.maintenance.seal` folds the live postings into segments of 65536
identifiers — a dense bitmap or a sparse offset list, chosen per segment. Writes
keep their cheap shape because a blob is never edited: what is written after a
seal lands in the live tier beside it, and what is removed from a sealed lens
leaves a tombstone that the read subtracts.

At 200k objects and 600k postings: a wide term 304 ms → 24 ms, a wide column
78 ms → 6 ms, and a selective predicate intersected with an unselective one
278 ms → 1.5 ms.
