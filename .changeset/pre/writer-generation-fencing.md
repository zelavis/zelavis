---
"zelavis": minor
---

Enforce writer generations inside physical SQLite writes.

A writer claims a generation before it may mutate a shard, and every write
transaction re-reads the durable fence. A superseded writer — one partitioned,
paused, or holding a stale topology — is rejected by the shard it is trying to
write to, rather than trusted to notice it lost ownership.

The fence is persisted, so it survives reopening the database and holds across
processes. Taking over advances it; re-claiming the same generation is allowed
so a restart does not need a new one; claiming an older generation is refused.

Fencing is advertised through `DatabaseCapabilities.writerFencing` and an
optional `DatabaseDriver.claimWriterGeneration`. A driver that does not
implement it stays unfenced, which remains the embedded single-process default.
The sharded driver claims each shard at the generation its topology says owns
it, before its first write.
