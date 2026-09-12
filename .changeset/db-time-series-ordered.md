---
"zelavis": minor
---

Answer time-series windows from the ordered lens.

A point now carries its instant as a single ordered posting instead of five
bucket postings, and a window is one exact range over it. That removes the
interval cover of buckets, the clause-count backstop, the fallback that
answered a very wide window by reading the whole series, and the trimming that
coarse buckets made necessary.

Ingest rises from about 2.6k to 3.2k points/s over 20k points, on four fewer
postings each; read times are unchanged within noise, which is what the change
is for — the cover was cheap to query but expensive to write and to keep
correct. Tag filters are untouched.

`BucketSize`, the `bucket` option on a time-series definition, `bucket` on its
summary and the `coverBuckets` helper are removed, and the time-series system
view no longer carries a bucket column. A series whose points were written
under the old scheme answers from those postings until `rebuild` replays it.
