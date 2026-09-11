---
"zelavis": minor
---

Order and page documents across tenants and shards.

`db.scatter.findMany` with an `orderBy` now merges every tenant's ordered run
by value, tenant by tenant among equals, instead of re-sorting the rows by
tenant and id; with a `limit`, each tenant is read only that far. The new
`db.scatter.findPage` pages the same merge: its cursor holds a position per
tenant, a page reads a share of itself from each tenant and tops up the ones
the merge drains, and a continued read keeps the tenants and the order it began
with. Across 20 tenants on 4 shards a page of 50 takes about 5 ms whether they
hold 1,000 documents each or 5,000. An order some tenant cannot page is refused
with that tenant named.

`findPage({ cursors: true })` returns the cursor after every document, and
`compareDocuments(orderBy)` exposes the order `findMany` and `findPage` use.
