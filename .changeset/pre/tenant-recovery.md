---
"zelavis": minor
---

A Tenant can be recovered as it was at a past moment: `branchTenant` takes `asOf` (a change-feed cursor) or `asOfTime`, replaying the source's log from empty into a new Tenant while that log was never compacted, and `recoveryWindow` reports how far back each partition reaches. Both are on HTTP, the SDK (`branchTenant`, `tenantRecoveryWindow`), the CLI (`branch-tenant --as-of|--as-of-time`, `recovery-window`) and the dashboard's Branch dialog.
