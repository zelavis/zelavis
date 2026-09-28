---
"zelavis": minor
---

Add ranges, sorting and cursor pagination to `zelavis/db`, served by a new ordered lens.

Values now have one defined order, identical on every host: booleans, then
numbers, then strings by code point (no locale and no normalization), then
null. Every scalar document field is indexed in that order, and every storage
engine can scan a key range in either direction to read it.

- `gt`, `gte`, `lt`, `lte` and `between` are serializable query nodes that
  combine with `and` and `or`. A range compares like with like: `lt(price, 5)`
  is numbers below five, never booleans or null.
- `store.ordered` reads a page of objects in value order in either direction,
  ties broken by identifier, with an opaque cursor; `store.extent` returns a
  column's lowest and highest value.
- Document comparisons (`gt`, `gte`, `lt`, `lte`) are answered by the index
  instead of being filtered after it, and `eq` and `in` are exact about type:
  `10` no longer matches `"10"`.
- A one-field `orderBy` reads the index instead of sorting every match.
  Documents whose field is null or absent come last in either direction.
- `documents.findPage` and `POST /database/documents/:collection/page` return a
  page and a `next` cursor that is present only when another document follows.
  Ordering a page by several fields is refused until composite indexes exist.

Every scalar field is now indexed twice, for equality and for order, so writes
take about 1.8 times as long and use about 30% more disk. Merging the two
indexes is the next step.
