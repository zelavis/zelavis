---
"zelavis": minor
---

Follow a document's typed links as a lens.

A collection can declare an `EdgeDefinition`: a name, the field holding the
target id or ids, and the collection those ids name. Writes resolve each target
and post it on the edge lens, and `findMany` and `findPage` take a `linked`
clause naming a document and one of its declared edges, answering with the
documents it links to.

A reference already holds one id, so following one is a lookup, and asking which
documents name a given one is an ordinary column filter. An edge is the case
those do not cover: it holds a list, so following it is a posting scan, and
because the postings are the neighbours' own identifiers the result intersects
with everything else the target collection indexes. That is the point of making
it a lens rather than a field -- `where`, `search` and `geometry` narrow the
neighbours before they are read, instead of filtering them afterwards. Links
also page, because an intersection has no order of its own to lose.

The field may hold a single id as well as an array; one link is a short list.
A document may link to itself, and a document written in one batch may link to
another written earlier in the same batch, because targets resolve through the
same transaction overlay that references already use. A link naming a document
that does not exist is refused as a `ReferenceViolation` at the write.

Edge postings were already carried by the store -- keyed, sealable, dropped on
retraction, and re-derived by a reindex -- but nothing populated them. They are
filled in now from the resolution the constraint pass was already performing, so
a write costs no extra read. A rewrite re-derives them on its own path, and
re-derives rather than re-checks: a target that has since gone leaves the link
unposted instead of failing the rewrite.

Stated limits: this is outbound only. The lens keys a posting by the source
document, so an inbound posting would have to be written into the target's
manifest and re-version it on every source write; asking which documents link to
a given one is not supported here. There is no bounded traversal, no shortest
path, reachability or component query, and no edge properties or first-class
edge objects yet. A `linked` clause is refused across more than one shard by the
existing scatter check, since an edge names a partition-local identifier.
Links resolve as each change in a batch is applied, in order, so two documents
that link to each other cannot be written in one batch: the first of the pair
names a document that exists nowhere yet, and the batch is refused.
