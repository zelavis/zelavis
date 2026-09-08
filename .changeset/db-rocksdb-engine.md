---
"zelavis": minor
---

Add a RocksDB storage engine.

The engine the lens design was originally drawn for, and it needed no
accommodation: `get`, a bounded iterator and an atomic write batch are exactly
the key-value interface, so it is four methods and nothing above it changed.
That was the point of moving the store off SQL.

Its single keyspace and absent column families cost nothing. Each lens already
takes a leading key tag, which gives it the disjoint range column families would
have provided — the emulation the original design expected to need turned out to
be the design.

It is also the first asynchronous engine, which is only safe because a
transaction is one batch rather than an open window another caller could write
into. The interface was typed for that from the start.

RocksDB joins the engine conformance suite and runs the object-store contract,
so it is held to the same ordering, prefix isolation, batch atomicity and binary
fidelity as every other engine rather than being trusted because it is a
database.

`rocksdb` is an optional peer dependency, so an installation that does not ask
for the engine does not carry a native build.
