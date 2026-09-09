---
"zelavis": major
---

Store on an ordered key-value engine, and retire the SQL store.

Lenses are key ranges rather than tables. A posting list is the entries under
one prefix, already sorted; a posting is a key with no value, because the key is
the fact. That is what the column-family design was reaching for, and it is what
lets an engine with no tables back the same semantics — which is the point:
RocksDB is now a driver rather than a rewrite.

A transaction is one atomic batch instead of a BEGIN/COMMIT window, with reads
overlaying the pending writes. That second part is not optional: a put after a
retract of the same identifier must observe the retraction, or it re-reads a
manifest the batch already removed. It also removes the hazard that forced the
old gateway to be synchronous — there is no open transaction for a concurrent
caller to write into, so an asynchronous engine is now a driver.

`sqlite-store.ts` and the SQL gateway are deleted rather than kept alongside.
Two stores meant two definitions of retraction, cursors and event replay, and
the one nobody opened would drift until it was wrong in a way nothing caught.

Key encoding is the part that had to be exact. Identifiers are fixed-width
big-endian so 2 sorts before 10 in bytes; strings are terminated so ("ab","c")
cannot collide with ("a","bc"); each lens takes a tag so a scan cannot leave its
namespace. `0x00` escapes to `0x01 0x01` rather than the obvious `0x00 0xFF`,
which would make the encoding of a value containing a null begin with the
encoding of the value truncated before it — and the prefix range does not save
that, because the escape sorts below the incremented bound.

libSQL keys travel as hex text. Binding a Buffer to a SELECT panics inside
libsql 0.5.29's native layer, so the driver encodes around an upstream bug; hex
preserves order, so scans behave identically.

Correctness is established by running the existing object-store, event-log and
document contracts against the new store unchanged, rather than by new tests
written to agree with new code.
