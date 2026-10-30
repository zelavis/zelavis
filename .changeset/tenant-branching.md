---
"zelavis": minor
---

Branch a Tenant: `db.branchTenant(tenant, into)` makes `into` a new Tenant holding a copy of `tenant` as of one position of its log (records, history, definitions, projection and time-series state, outbox and idempotency receipts), taken while the source keeps taking writes. The branch keeps the source's identifiers and log positions and records its lineage, so a cursor or checkpoint from before the branch point carries on in it; until the copy is whole it answers `TenantBranching`, and running the branch again finishes one that was cut off. Also `POST database/tenants/:tenantId/branch` (needs `database.restore`), `client.projects.branchTenant` and `zelavis projects branch-tenant --tenant T --to NEW`. Merging a branch back is not supported.
