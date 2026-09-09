---
"zelavis": minor
---

Time series ranges stay indexed however long they are.

A range spanning more than 400 buckets used to give up naming them and scan the
whole series. Points are now indexed at five widths, each eight times the last,
so a range is covered by whole coarse blocks in the middle and finer ones at its
edges. Ten years of days costs under thirty clauses; the cap survives only as a
backstop against a range of a million years.

The cost is one posting per level on each point written, which sealing folds
into blobs. Points are derived state, so an existing series takes the new index
by being rebuilt.
