---
"zelavis": patch
---

Event cursors now name the life of the Tenant that issued them. A cursor held across Tenant removal and recreation is
refused with `CursorFromAnotherLife` (HTTP 409, code `cursor-from-another-life`). The consumer can read again from the
beginning. A move, a follower, and a copy keep the Tenant life. A branch can continue its source's cursors and merge
back only within the source life it was branched from.

The Project upgrade to data layout 5 reads layouts 2 and 4. It carries document history when the source log is intact.
Layout 4 also keeps pending outbox messages, durable entity and workflow state, idempotency receipts, saved schema
activations, and materialized aggregate definitions and results. App-wide collections are carried and cross-Tenant
indexes rebuild from the migrated documents. Aggregate checkpoint cursors, derived time-series state, and old event
cursors do not carry over. A compacted partition carries its final state. The upgrade refuses layout-4 branches
because recreating them would sever their lineage. It also refuses divided Tenants and databases with shards or replicas
on other Nodes.
