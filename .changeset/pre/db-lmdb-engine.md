---
"zelavis": minor
---

Add an LMDB storage engine.

A memory-mapped B+tree, so a third shape beside the SQL b-trees and the LSM
tree — and the one that answers reads without decoding anything. It is the
fastest engine on every measured axis: six times SQLite on the cross-model
query, nearly five times on posting scans, three times on point reads, and it
ingests fastest as well. It pays in space, taking more disk than SQLite and five
times more than RocksDB.

Adding it took one file and no changes above it, which is the clearest evidence
so far that the key-value interface is the right seam. It joins the conformance
suite and the object-store contract like every other engine.

It also corrects an earlier reading of the benchmark. Building the measure
vector looked storage-independent because three engines all took about the same
time; LMDB does it in a third of that, so the work was in the read path after
all rather than in the JavaScript above it.

`lmdb` is an optional peer dependency. Whether it should displace SQLite as the
default is left open: it is faster everywhere measured, but SQLite ships inside
Node and needs no native build.
