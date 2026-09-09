---
"zelavis": minor
---

Add a multi-model object store with its own event log.

`zelavis/dbnew` writes a payload once and projects it through document, column,
measure and graph lenses that hold only pointers back to a shared,
partition-local identifier space. Because every lens addresses the same space, a
predicate spanning several data models is one set intersection rather than an
exchange between separate engines. Measured on a million synthetic objects,
three specialist stores would have to ship roughly 1,363 identifiers between
themselves for every row such a query returns; sharing the space removes that
entirely. The lenses cost 1.79x the payload in derived storage, a ratio that
moved by four thousandths across a fivefold change in scale.

Locality is declared, not inferred. Everything sharing a `PartitionKey` is
guaranteed to live together, which is what keeps that intersection cheap.
Identifiers are dense and partition-local so posting sets stay small, and global
identity is the pair rather than one global sequence — so a single-partition
deployment today is a placement fact rather than an architectural commitment,
and never needs repartitioning to become several.

The event log is the source of truth. Writes append before projecting, so a
crash leaves an event whose projection can be replayed rather than a lens row
with no event behind it, and the lenses can be re-derived from the log alone.
Cursors are opaque and carry their partition, keeping physical positions inside
the driver where nothing can mistake a SQLite autoincrement for a logical global
order. Opening a partition claims the next writer generation and fences the
previous holder, including when both sit on one Node. Followers apply events
idempotently by sequence and version, so an interrupted range can be
re-consumed without duplicating work.

Postings are a sorted array or a bitset, chosen per set by density. The shape
matters more than the compression: a sorted run has to be walked to be
intersected, while a bitset can be probed, so a selective predicate stays cheap
against an arbitrarily unselective one — which is what a developer writes
without thinking about it. Intersecting the two widest predicates from the
design study drops from 26.4ms to 0.13ms, and postings are 10.7x smaller. The
remaining cost of a wide query is now the b-tree scan that feeds the
intersection rather than the intersection itself.

Two contracts are shaped for what comes later. Queries are data rather than
closures, because a closure cannot cross a network boundary and a router that
takes one could only ever answer locally. Partition handles are held in a
`LayerMap` rather than a cache, because eviction has to close the file; dropping
the handle would leak descriptors and risk corruption on a WAL database.

Not yet included: cross-partition resolution, snapshots — rebuilding replays all
history rather than live objects — postings stored as bitmap blobs, which would
remove the remaining scan but needs immutable segments and compaction, and any
durability testing, so `synchronous=NORMAL` is configured rather than proven.
