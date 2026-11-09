---
"zelavis": minor
---

Databases take a `durability` choice when they open: `crash` (default) or `power`, which flushes every commit to the device on SQLite and LMDB and is refused by RocksDB. Database health reports the engine and durability. Followers can acknowledge the positions they hold, and `writeAcknowledged` waits for a number of them before a write is treated as kept, failing with `FollowersNotAcknowledged` without undoing it.
