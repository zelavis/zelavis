---
"zelavis": minor
---

Add `db.movement`, which relocates a tenant's records so an occupied range can
be re-placed.

A partition map carries routing and no data, which is why `topology.update`
refuses to move a range tenants are standing on — the records would stay put
while every read went to the new shard and found nothing. That refusal is
correct and was also a dead end: a map could only ever be changed where it did
not matter.

Relocation is deliberately not a transaction, since there is no atomic write
across two shards. It is a sequence whose every intermediate state is one a
reader can safely be in, recorded as it goes so an interruption resumes rather
than needing repair: fence writes on the shard being left, copy the tenant,
move the routing, then drop the source. A tenant is unwritable for the length
of the copy and never unreadable.

Routing is now read from the topology on every call rather than from the map a
database opened with, so `forTenant`, `shardOf`, `partitionMap` and the health
endpoint all follow a relocation instead of describing the layout as it used to
be.
