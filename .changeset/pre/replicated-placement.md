---
"zelavis": minor
---

Implement the `replicated` placement class, so App-scoped data can be read from
a tenant's own shard without a fan-out.

`db.replication.refresh` materializes every `replicated` collection onto every
placed shard, and `tenant.shared` is the read-only view of what landed there.
The read is physically local — same shard, no second store opened, no partition
crossed — which is the whole point of paying to replicate.

The copy is a snapshot rather than a log tail, deliberately. A retraction
carries only a `Seq` and no identity, so a log follower has to remember what
every identifier stood for in order to apply a delete; `movement` can hold that
map in memory because a move is one bounded operation, but replication never
ends and survives restarts, so the same map would have to be persisted and would
grow with the data. A snapshot needs no such memory. The cost is the size of the
replicated data per refresh rather than the size of the change, which is the
right trade only while replicated collections stay small and read-mostly.

Refreshing is explicit and runs when a database opens, so a write to a
replicated collection reaches tenant-local reads at the next refresh rather than
when it commits. There is no cross-store transaction.

Two things are refused rather than silently got wrong: a replicated collection
carrying edges fails with `ReplicationUnsupported`, because an edge names a
record by an identifier every replica reallocates; and the tenant occupancy
marker is never copied, so a replica cannot make the App look like an occupant
of a shard and mislead a rebalance.

Creating a collection through `db.global` now claims it as `global` only when
the name is undeclared, so declaring `replicated` first and creating it second
is how a replicated collection is made.
