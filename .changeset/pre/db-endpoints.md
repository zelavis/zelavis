---
"zelavis": minor
---

Make the newer database capabilities reachable over the wire.

Search and geometry were wired into the versioned endpoints when they landed;
the capabilities after them were not. A collection could declare an embedding,
typed edges or measures in process but not through `POST /collections`, a query
could not carry `linked` or `similar`, and `summarize`, `summarizeBy` and `embed`
had no runtime method or route at all. They do now:

- `POST /:collection/summarize` and `POST /:collection/summarize-by` aggregate a
  declared measure, grouped or not, narrowed by the same clauses a query takes.
- `linked` reaches the query and page routes; `similar` reaches the query route,
  and deliberately not the page route, because an order by score has no cursor
  that survives a write.
- `embedding`, `edges` and `measures` can be declared when a collection is
  created.
- `embed`, `summarize` and `summarizeBy` are on the runtime API beside `analyze`
  and `locate`.

Four domain errors reached the wire as `500`s, because they were in none of the
status sets: a measure or an edge the collection does not declare is a `404`, as
an unknown reference already was, and a malformed vector query or a vector of the
wrong shape is a `400`, as an unanalyzed collection already was. A caller's
mistake now reads as one.

The clauses every filtering read shares are decoded in one place, so a query, a
page and an aggregate narrow by the same words -- an endpoint that understood
`linked` on only some of them would answer a different question depending on
which was asked.
