---
"zelavis": minor
---

Give every Tenant its own storage partition in `zelavis/db`. Everything a Tenant stores (records, postings, its event log, identities, counters) now lives in one key range of its shard, with its own identifiers, its own log positions and its own writer. Isolation follows from the key layout rather than from each lens remembering to scope itself, and a transaction cannot touch another Tenant's keys. Shards written by earlier builds are refused with a format error: delete and recreate development databases.

Confine full-text search and geometry to the Tenant and collection being queried. Term and cell postings were filed under the bare field path, so a search or a geometry filter with no other clause could return another Tenant's documents, or documents from another collection, and fuzzy search matched another Tenant's words.

Stop a Tenant's event stream from stalling behind other writes. `events.read` returns `{ events, cursor, more }`: `cursor` moves past every log entry the read looked at, matching or not, and one read looks at a bounded stretch of the log. Projections and the KV change feed (`kv.namespace(name).changes()`, `POST …/kv/:namespace/changes`, `zelavis data kv-changes`) use the same page shape. Event ids are `${tenant}:${record}:${version}` and `nodeId` is the node that accepted the write, so both survive a move.

Move Tenants verbatim. A move seeds the destination from a consistent image of the source (its records, then the log written while they were copied), keeps identifiers and log positions, fences the source inside the final commit, and keeps only the fence on the old shard, so cursors, projection checkpoints, idempotency receipts and graph links carry on. Backup export is consistent under concurrent writes, and a restore carries graph links to the new identifiers instead of naming whatever the destination gave those numbers to.

Stop counters from wrapping. Identifiers are 48-bit and log positions and meta counters 64-bit; a full partition refuses with `PartitionExhausted` instead of reusing a number. A deleted record leaves a tombstone, so re-applying an old put no longer brings it back, and a follower's `apply` refuses a gap (`EventGap`) or a different event at a position it already holds (`ReplicaDiverged`).

Bound reads and upkeep. A query reads each clause up to a cap and checks broad clauses per candidate against the record instead of reading them in full; an update rewrites only the postings that changed; `measure` is sparse. Sealing, reindexing, rebuilding, snapshots and compaction write in bounded batches; a rebuild or reindex cut off by a crash leaves the partition refusing reads (`LensesRebuilding`) until the database opens and finishes it, and a snapshot no longer holds the writer while it copies. Maintenance status is reported per Tenant partition from stored counters.

Replicated collections may now hold graph edges between themselves; an edge to a collection that is not replicated is still refused.
