---
"zelavis": minor
---

Repair documents indexed under older rules, and reach every constraint over HTTP.

`documents.rewrite()` writes documents back so their postings are the ones the
lenses derive today. It is what repairs documents written before the typed
scalar lens, whose numbers and booleans were indexed as text and so were missed
by a typed equality, a range or an order; a reindex cannot, because it
re-derives postings from the stored manifests and those are what is wrong. It
takes one collection or every one of the tenant's, and is mounted at
`POST /database/maintenance/documents/rewrite`.

Checks and references can now be added and dropped over HTTP
(`POST`/`DELETE /database/documents/:collection/checks` and `/references`), and
a delete takes `expectedVersion` and a JSON `precondition` in its query string,
where the method has no body.

An insert hands the collection record it already read to the write instead of
reading it again: 4.0k inserts/s against 3.3k/s, measured in one run.
