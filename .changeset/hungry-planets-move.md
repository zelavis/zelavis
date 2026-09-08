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
than needing repair: copy the tenant while it is still being written to, catch
the copy up from the source log in rounds, fence writes for the last round
alone, move the routing, then drop the source. The tenant is never unreadable,
and it is unwritable only for that last round — proportional to what arrived
during the round before it rather than to how much the tenant holds.

Routing is now read from the topology on every call rather than from the map a
database opened with, so `forTenant`, `shardOf`, `partitionMap` and the health
endpoint all follow a relocation instead of describing the layout as it used to
be.
