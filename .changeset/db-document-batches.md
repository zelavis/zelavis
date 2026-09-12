---
"zelavis": minor
---

Apply several document changes as one.

`documents.write` takes a list of inserts, updates and deletes and applies them
in a single transaction: all of them land or none does. Every check a single
write makes is made against what the batch has written so far as well as what
is committed, so changes can depend on each other — a post may name an author
the same batch inserts, a document deleted earlier in the batch is gone for the
changes after it — while two changes may not take one unique value. A violation
anywhere refuses the whole batch.

Atomicity stops where a tenant does: a tenant lives on one shard, there is no
write spanning shards, and `db.scatter` reads rather than writes. A change set
spanning tenants is several batches, each atomic on its own.

`POST /database/documents/write` carries a batch. Deleting a document that
others name now resolves each of those documents once, with every field naming
it cleared together, instead of once per reference.
