---
"zelavis": minor
---

Removing a Tenant now handles divided Tenants (every part, the division kept), gives the Tenant back writable when calls do not drain in time instead of leaving it fenced, and finishes a removal cut off by a crash when the database opens. A cut-off branch whose source is gone is removed at open, and one waiting on a relocation finishes when the relocation does. The dashboard deletes divided Tenants and asks explicitly where a branch's outbox messages go.
