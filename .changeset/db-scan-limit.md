---
"zelavis": patch
---

Stop bounded scans at the engine.

`KvScanOptions` takes a `limit`, and every engine honours it — SQLite with
`LIMIT`, the others by closing their iterator. The store passes it wherever it
reads only part of a range. A stream pulls an iterable thousands of entries at
a time, so a scan cut short by the stream still read up to 4,096 rows: a first
page of 50 over 50k documents drops from 6.6 ms to 0.6 ms.
