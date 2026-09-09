---
"zelavis": minor
---

Time series `range` and `aggregate` accept a tag filter.

Points were already indexed by tag; nothing read those postings. A filter now
does: every named tag must match, a tag given several values matches any of
them, and both compose with the time window rather than replacing it.

It is worth most exactly where the window gives up. Past the bucket-clause limit
a range stops naming buckets and asks for the whole series — with a filter, that
fallback is intersected with the tag, so the query costs the tag rather than the
series.
