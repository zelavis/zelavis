---
"zelavis": minor
---

Enforce unique, check and reference constraints, and preconditions, in the transaction that writes.

Document writes now read, check and write in one transaction under the store's
single writer: the id, the version, the data a merge builds on, the schema, the
idempotency receipt and the move fence. Two racing updates can no longer both
build on one version, and a refused keyed write records no receipt.

- `unique: true` on an index refuses a second document with the same values.
  A document missing one of them is not held to it, as SQL treats NULL. An
  index created over documents that already break it is not created, and the
  error names two of them.
- `checks` on a collection are filters every document must satisfy, stored as
  data; a field with no value passes, as a NULL passes a SQL CHECK. `addCheck`
  validates the documents already there.
- `references` name a document in another collection of the same tenant.
  Deleting a named document restricts (the default), cascades, or sets the
  field to null, all in the delete's own transaction. `addReference` validates
  the documents already there.
- `precondition` on `update` and `delete` is a compare-and-set on field values,
  alongside `expectedVersion`.

Unconstrained writes run as before; enforcing a unique index, a check and a
reference together costs about a third of insert throughput.
