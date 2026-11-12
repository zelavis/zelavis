---
"zelavis": minor
---

`db.tenants` and the Tenants overview (`GET database/tenants/overview`, `client.projects.tenants`, `zelavis projects tenants`) now report Tenants, not partition keys: a divided Tenant is one entry with no shard of its own and a `parts` list (each part that holds data, with its shard, tables, documents, records and bytes), and its counts are the parts' sums. `db.partitions` (and `DatabaseRuntimeApi.partitions`) lists the partition keys, `DatabaseRuntimeApi.partsOf` and `forPart` reach a divided Tenant's parts, and `ZelavisTenantSummary.shard` is optional. The dashboard's Database → Tenants page shows a divided Tenant as one row with its parts, offers Branch on it and no Delete (which is refused for a divided Tenant). A divided Tenant's branch is consistent within each part, not across them; this is documented rather than changed.
