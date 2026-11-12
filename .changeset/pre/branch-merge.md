---
"zelavis": minor
---

A branch can be merged back into the Tenant it came from: per document from the branch point, applying what only the branch changed through the source's own writes, with conflicts (changed differently on both sides) settled explicitly per document and nothing written while one is unsettled. Available as `db.mergeBranch`, `POST …/tenants/:id/merge`, `client.projects.mergeTenantBranch`, `zelavis projects merge-branch` and the dashboard's Merge back; the Tenants overview reports `branchedFrom`.
