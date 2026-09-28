---
"zelavis": minor
---

Compact the database event log, so storage tracks live objects rather than
every write ever taken.

Payloads, manifests and identities already are the snapshot and postings are
derivable from manifests, which makes compaction log truncation rather than a
separate snapshot format. `db.maintenance` exposes it per shard along with
`status` and `reindex`.

Reading history now has to handle being cut off: a cursor from before the cut
fails with `CursorCompacted`, a full replay refuses with `LogCompacted`, and
the state-reading paths are what still work — `reindexLenses` re-derives
postings from stored manifests, and a backup exports from state once history no
longer reaches back far enough to rebuild the tenant.
