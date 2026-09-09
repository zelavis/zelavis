---
"zelavis": minor
---

Add `tenant.migrations`, which brings stored documents forward from one schema
version to another.

Activating a version changes what is accepted from that moment on and leaves
everything already written exactly as it was. That stays the default — a schema
change should never silently rewrite data — but validation rejects unknown keys,
so removing a single field is enough to put every existing document out of step
with the active version. Migration is the deliberate other half.

Instructions are data (`Rename`, `Set`, `Default`, `Drop`) rather than a
function, for the same reason a query here is a value: a closure cannot be
inspected, logged, or reviewed before it runs. `plan` reports what separates two
versions, which fields will be discarded, and which differences the caller still
has to answer.

The decision is all-or-nothing even though the writes are not. Every document is
transformed and checked against the new version before anything is activated or
written, so a migration that would leave documents invalid refuses rather than
getting halfway — and because every instruction is idempotent, an interrupted
one is finished by asking for it again.
