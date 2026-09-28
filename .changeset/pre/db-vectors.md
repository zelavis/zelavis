---
"zelavis": minor
---

Search a collection's embeddings by closeness.

A collection can declare an `EmbeddingIndex`: which field holds the vector, how
many elements it has, how two of them are compared — cosine, dot or euclidean —
and a version. `findMany` takes a `similar` clause naming that field, a query
vector and a `k`, and answers with the `k` closest documents, closest first.

The search is exact, not approximate. Every document the rest of the query
admits is compared, which is what makes the other clauses matter: `where`,
`search` and `geometry` narrow the candidates before anything is scored, so a
similarity read under a narrow filter costs what that filter returns rather than
what the collection holds. Ties break by identifier, so the same query over the
same documents answers in the same order every time.

The vectors stay in the documents, which remain the authoritative state. They
are posted to no lens, so there is no second copy to fall out of date and
nothing to re-derive when documents are rewritten. `embed` declares the index on
a collection that already holds documents: it records the shape, reads every
document against it, and withdraws the declaration if one does not match, rather
than leaving a collection promising a shape its own documents do not keep. A
write whose vector has the wrong length, or holds a value that is not a finite
number, is refused as a `VectorShapeMismatch`; a field holding nothing is not a
fault, and such a document simply never answers a similarity read.

The model and its version can be recorded on the index. They are stored rather
than enforced: vectors from two different models are not comparable, and a
search mixing them returns nonsense in the shape of an answer, so writing the
identity down is what lets a reader notice that it happened.

Stated limits: `similar` is not on `findPage`, because an order by score has no
cursor that survives a write. It cannot be combined with `orderBy`. `normalize`
scales vectors for the comparison only — the document keeps the vector it was
given. There is no approximate index yet: this is the exact baseline that one
would have to be measured against for recall.
