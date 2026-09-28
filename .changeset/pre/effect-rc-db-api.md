---
"zelavis": major
"@zelavis/ecommerce": patch
---

Update the database runtime to Effect `4.0.0-rc.112` and validate it with the
Effect language service during package typechecks.

The low-level Effect database API now exposes argument-free reads such as
`documents.listCollections`, `schemas.listCollections`, `projections.list`,
`timeSeries.list`, and `backups.exportTenant` directly as lazy Effect values.
The promise-facing Node/runtime API retains its existing method syntax. Numeric
wire and schema fields now reject `NaN` and infinities through `Schema.Finite`.
