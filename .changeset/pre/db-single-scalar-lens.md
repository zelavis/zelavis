---
"zelavis": minor
---

Answer equality, ranges and order from one typed, sealable scalar lens.

The equality index and the ordered index are now one. A manifest's `columns`
carry typed scalar values — `10`, `"10"` and `true` are three different values
— and one posting per value answers `equals`, every range and every order.
Writes are back to one posting per field: about 6.5k objects/s at 50k objects
of five fields, against 2.9k/s with two indexes.

The scalar lens seals into segment blobs like the others, and ordered reads
merge those blobs with the live postings, so a sealed store pages as fast as a
live one while wide equality filters keep sealing's speedup (14× on a wide
column, 180× intersecting a selective filter with a wide one). A value is
sealed only once it has 64 postings in a segment: a unique value gains nothing
from a blob and would cost ordered reads a decode per row.

`equals(column, value)` takes a typed value, and the manifest's separate
`ordered` field is gone. A store written in the older layout is re-indexed
the first time it opens.
