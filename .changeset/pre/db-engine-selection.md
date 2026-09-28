---
"zelavis": minor
---

Choose a storage engine when opening a database, defaulting to SQLite.

Four engines shipped with no way to ask for one: the host hardcoded SQLite, so
the choice was a code edit rather than configuration. `openNodeDatabase` now
takes `engine`, and every engine is reachable through the same host with the
same behaviour.

SQLite is the default because it is the only engine that needs nothing
installed — a default that can fail to install is not a default. The others are
optional peer dependencies and say which package is missing when one is asked
for and absent.

Which to pick is a question about the working set rather than about speed. LMDB
is three to four times faster than everything else while the data fits in
memory, which on a 64 GB machine is roughly forty million objects. RocksDB holds
the same data in about a sixth of the space and barely slows when the cache goes
cold, so it is the engine that keeps working once the data outgrows the machine.
libSQL is for replicating from a remote primary rather than for local speed.

`openLibsqlDatabase` and `makeLibsqlDatabase` are removed. They existed only
because the host could not select an engine, and keeping a second way to open a
libSQL database would mean two paths to maintain and one of them going stale.
