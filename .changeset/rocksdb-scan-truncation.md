---
"zelavis": patch
---

Close the last open RocksDB defect: a scan over a corrupted block no longer
ends silently.

`@harperfast/rocksdb-js` saw RocksDB's iterator fail and returned "done"
instead of surfacing the error, so a scan across a corrupt block handed the
caller a truncated result set with nothing to indicate it was short. Silent
truncation is worse than a crash — a short answer that looks complete is
acted on.

Fixed upstream in 2.9.1, which throws when a range iterator fails. The test
that recorded this was marked `todo`; it now passes, and is kept as a
regression guard rather than deleted, because only the iterator path ever
swallowed the error — the point read and the corrupt manifest pointer always
failed correctly and are checked separately.

This also clears the condition the engine evaluation set for itself: the
`rocksdb-js` engine's remaining known correctness gap is closed.
