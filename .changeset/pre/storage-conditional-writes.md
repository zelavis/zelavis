---
"zelavis": minor
---

Add conditional writes to file storage, and a probe that checks a store enforces them.

`storage.put` takes an optional `condition`: `{ ifAbsent: true }` creates only
where nothing is stored, and `{ ifMatch: etag }` replaces only the version a
reader saw. Entries now carry that `etag`. A condition that does not hold
rejects with `ZelavisStorageConditionError` and writes nothing. S3-compatible
storage sends `If-None-Match` and `If-Match`; local storage creates by hard
link, which is exact across processes, and compares and replaces under a
per-object queue, which is exact within one process.

`probeFileStorageGuarantees(storage)` asks a store directly whether it keeps
the guarantees a lease or a fence rests on, in the four steps celld runs before
a node serves: a create applies, a second create is rejected, an update with
the current version applies, an update with a stale one is rejected, and every
read returns the last write. Some stores accept the conditional headers and
ignore them. The probe names that failure rather than letting it surface later
as two owners of one thing.
