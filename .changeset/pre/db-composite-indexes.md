---
"zelavis": minor
---

Order pages by several fields with composite indexes.

A collection declares indexes — `createIndex({ collection, name, fields })`, or
`indexes` on `createCollection` — each a list of fields in order with a
direction and a null placement (`nulls: "first" | "last"`, last by default in
either direction). `findPage` and `findMany` read an index for an order made of
its fields, or exactly its reverse, after any leading fields an equality filter
fixes. A first page of 50 by two fields over 50k documents takes about 7 ms,
where `findPage` refused the order and `findMany` sorted every match in memory
(1.2 s).

An index created over existing documents writes each one back with its new
posting while other writes carry on, and answers reads once it is complete;
`dropIndex` removes one. `findPage` still refuses an order of several fields no
index serves, and says what index would. Single-field sorts take
`nulls: "first"` as well.

Every document write now reads its collection's indexes inside its
transaction, which costs inserts about 8% on a collection without any.

The database service mounts `POST /database/documents/:collection/indexes` and
`DELETE /database/documents/:collection/indexes/:name`.
