---
"zelavis": minor
---

Refuse edges on a `replicated` collection where they are declared, rather than
as a defect raised later by whichever write first produced one.

An edge names a record by identifier and every replica reallocates those, so a
replicated collection cannot carry one. That was previously caught when the
record was copied, which meant an ordinary `insert` died with no way to report
why: `DocumentsApi` has no error channel for a replication failure. The same
condition reported a typed error from `db.replication.refresh`, so identical
misconfiguration failed in two different shapes.

`db.global.documents.createCollection` now refuses an `edges` definition on a
name declared `replicated`, returning `InvalidConstraint` — which the collection
API already reports for a constraint it cannot accept, so no error channel had
to widen. The opposite order was already refused: creating an undeclared
collection through `db.global` claims it as `global`, and a class does not
change afterwards, so a collection created with edges can never become
replicated.

There is no other way for a collection to gain edges, so the state is now
unreachable and the checks in `replication` are assertions rather than an
expected path. A `global` collection may still declare edges freely, since
nothing copies it.
