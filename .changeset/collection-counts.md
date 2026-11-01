---
"zelavis": minor
---

Count collection documents in constant time using namespace counters maintained
atomically with each record change. Replication, restore, copy, rollback, replay
and reindexing maintain the same counts. The pre-release shard layout is now v4;
older development layouts are explicitly refused and must be recreated.
