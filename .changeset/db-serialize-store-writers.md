---
"zelavis": patch
---

Serialize writes to a store, so concurrent writers no longer lose commits.

A commit reads the event log's next position and writes it back advanced;
`nextSeq`, sealing, compaction and both lens rebuilds read state and write it
back the same way. On an engine whose reads and writes are asynchronous, two
of those in flight at once read the same value, and the second write replaced
the first. With LMDB and RocksDB, 31 of 32 concurrent commits returned
successfully and left no event behind, and on LMDB concurrent `nextSeq` calls
handed one identifier to two objects. SQLite and libSQL were unaffected only because their drivers
never interleaved.

Each store now admits one writer at a time. Reads take no permit and still see
committed state, and nothing holding the permit waits on another write, so
the lock cannot deadlock against itself. `db-concurrent-commits.test.mjs`
holds every engine to it.
