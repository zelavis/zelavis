---
"zelavis": minor
---

Keep a rebuild possible after compaction, with snapshots.

`reindexLenses` re-derives the lenses from the stored manifests and works
whatever happened to the log. `rebuildLenses` re-derives them from the log
itself — the operation that catches a manifest that is wrong instead of
trusting it — and compaction used to take it away for good.

`store.snapshot` now writes every live record down together with the log
position it covers, in a single batch that also drops the previous snapshot: an
interrupted snapshot leaves the store exactly as it was, and a store never holds
two snapshots or none. `rebuildLenses` starts from the newest snapshot and
replays only the events after it, and still refuses with `LogCompacted` when no
snapshot covers what compaction cut, since those events are genuinely gone.

`db.maintenance.snapshot` takes one per shard, alongside `compact`, `reindex`
and `seal`. A snapshot costs one key per live record.
