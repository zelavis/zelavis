---
"zelavis": minor
---

Give `zelavis/db` a declared placement class and a home for App-scoped data.

`PlacementClass` names the three scopes a collection can have: `partitioned`
(tenant-scoped, routed by the partition map, and the default for anything
undeclared), `global` (App-scoped, one reserved store no map places), and
`replicated` (App-scoped, copied onto every placed shard — named but not yet
implemented). A placement catalog lives beside the partition map in the same
store, records only deviations from the default, and is validated on open and
refused if it has dropped or reclassified an internal. Declaring a class is
idempotent and immutable afterwards: reclassifying moves data, so it belongs to
relocation rather than to a catalog write.

`db.global` is new — the same surface a tenant gets, over one reserved tenant in
one reserved store, for plan definitions, feature flags and shared lookup tables
that would otherwise be copied into every tenant or kept outside the database.
Creating a collection there catalogues it as `global`. Because App-scoped data
is isolated by the same structural tenancy that separates customers, a global
`plans` and a tenant's `plans` are simply different collections and cannot
collide — no App-wide name reservation, and no cross-tenant check on create.

The global store is compacted, reindexed, snapshotted and sealed with every
other store, and `scatter` never reads it: it is not a partition, and a write
there is not atomic with a write to any tenant.

`zv.topology` is now classified through the catalog instead of being
special-cased in `makeDatabase`, and `TOPOLOGY_SHARD` moves to the topology
module beside `ShardId`. Tenant routing is unchanged.
