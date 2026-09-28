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

Sealing is incremental. A segment is read, merged and written back only where a
live posting or a tombstone falls inside it, so a periodic seal costs what
changed rather than what is stored.

At 200k objects and 600k postings: a wide term 305 ms → 27 ms, a wide column
77 ms → 6 ms, and a selective predicate intersected with an unselective one
279 ms → 1.4 ms. Re-sealing after touching 1% of them takes 0.09s against 4.11s
for the first seal.
