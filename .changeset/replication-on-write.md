---
"zelavis": minor
---

Carry writes to `replicated` collections to every shard as they happen, so a
tenant-local read no longer waits for an explicit `db.replication.refresh`.

The naive version of this — running a refresh after each write — would cost the
whole collection per shard on every insert, so a batch of a hundred rows would
pay for a hundred full copies. It is not needed: a refresh compares whole states
only because nothing tells it what moved, and a write knows exactly. Writes now
propagate by identity, one record per shard. Deletes travel the same way, and
the retraction problem that ruled out log-tailing does not arise, because the
caller names the identity rather than leaving it to be recovered from a `Seq`.

A change that is not one record's still re-levels: `rewrite`, index, check,
reference, analyzer and embedding changes rewrite the manifest of every document
in the collection, so there is no single identity to carry. These are rare next
to writing a document, which is what makes the expensive answer right there and
wrong on the write path.

`db.replication.refresh` remains, and still runs when a database opens — it is
what levels a shard that joined while the database was closed, or one left
behind by an interrupted pass.

Adds `ObjectStoreApi.manifestOf`, since copying a single record previously meant
reading the whole partition through `liveRecords` just to find its manifest.

A write that would produce an edge in a replicated collection now fails rather
than replicating a pointer that means something else on every shard. It surfaces
as a defect, because `DocumentsApi` has no error channel for a replication
failure; `refresh` still reports the same condition as a typed
`ReplicationUnsupported`.
