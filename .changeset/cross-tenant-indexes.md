---
"zelavis": minor
---

Add cross-Tenant indexes to `zelavis/db`. `db.crossTenantIndexes` keeps one collection's documents from every Tenant in a partition of its own, fed from each Tenant's event log through a per-partition cursor that is committed with the entries it produced, so a live query across Tenants reads one partition instead of asking every Tenant. A Tenant that moves carries on from its cursor; one compacted past it, or removed and written again, is derived again from its records. Plugins' `service:` Tenants are never read. Indexes refresh in the background shortly after writes and on a sweep, and are available as HTTP routes under `database/cross-tenant-indexes`, `client.crossTenantIndexes(projectId)` and `zelavis cross-tenant-indexes`. Defining one needs the new `database.indexes.manage` permission, carried by `project.runtime.manage`; querying needs `database.inspect`.

Partitions now record an `incarnation` with their first write, kept by a move or a follower's copy and new after a partition is removed, exposed in `PartitionStats`.

A shard a move has left now keeps the partition-map version that moved the Tenant, and refuses a call routed by an older map with `TenantRelocated` instead of answering it from an emptied partition.
