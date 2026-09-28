---
"zelavis": minor
---

Search a collection's text by terms it declares how to make.

A collection can declare an `Analyzer`: which fields become searchable, NFC
normalization, case folding, stop words, a minimum term length, the language
(recorded, not yet acted on), and a version. Writes turn those fields into term
postings, and `findMany` and `findPage` take a `search` string analyzed the same
way — every word must appear, a word counts in any analyzed field, and the whole
thing is one more set that intersects with filters, ranges and joins.

`documents.analyze` declares or changes the rule and rewrites every document
under it, since the terms already stored are what a search reads. Searching a
collection with no analyzer fails with `UnanalyzedCollection` rather than
answering "no matches" to a question that was never askable. Over HTTP, `search`
is accepted by the query and page routes, and `analyzer` on collection creation.

This is term search, not ranked full text: no positions, phrases, prefix or
fuzzy matching, no BM25 scores or highlights. Those need storage this does not
add — positions need their own key shape, and scoring needs document lengths and
term frequencies — and are tracked as the next slice.
