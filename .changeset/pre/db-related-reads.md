---
"zelavis": minor
---

Join collections through their references.

`findMany` and `findPage` take a `related` clause — `{ reference, where?, id? }`
— for documents whose reference names a document matching something else. The
named collection answers its own query first, and the ids it returns become an
equality union over the referencing field's existing postings, so a join is a
set operation over the dense identifier space rather than a scan of either
side: over 20k posts across 2k authors, the posts of one country's authors take
33.7 ms against 154.9 ms for reading every post, resolving its author and
filtering; by id, 0.2 ms.

`withRelated` resolves what documents you already hold name, reading each named
document once however many name it. `db.scatter` carries a join to every tenant
it asks, and a join stays inside one tenant because a reference does. A
reference the collection does not declare is `UnknownReference`, so a mistyped
name is refused rather than quietly matching nothing.

Over HTTP, `related` is accepted by the query and page routes.
