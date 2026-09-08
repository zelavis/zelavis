---
"zelavis": minor
---

Add `db.scatter`, the explicit contract for questions that span partitions.

Everything else in the database is deliberately partition-local, which is what
makes the common case cheap and is exactly what a cross-partition question gives
up. So this is a surface a caller reaches for on purpose rather than one the
ordinary APIs fall back to: it fans out per shard for lens queries and per
tenant for document queries, and every result carries its legs so the cost is
visible per part.

It refuses two things rather than answering them. A query naming a
partition-local identifier — an edge above all — means a different object on
every shard, so scattering one would return rows that look like matches and are
not. And a shard the partition map does not have is an error, because reading
the rest quietly would answer a narrower question in the shape of the asked one.

Stores gain `identityOf`, the reverse of `lookup`, so an identifier handed
across a partition boundary can be turned back into a name.
