---
"zelavis": minor
---

`restoreTenant` can restore into a tenant that already holds data.

Restoring is not one operation: putting a tenant back as it was and folding a
copy of it into what is there now are different intentions with different right
answers, so the mode is the caller's to choose. `empty` refuses and stays the
default, because it is the only one that cannot lose anything. `purge` discards
what the tenant holds and leaves it as the backup describes it. `merge` writes
the backup over records sharing a name and leaves the rest alone.

A backup whose identities name a different tenant is now refused whatever its
envelope says. Those identities are lens keys, and a merge looks them up to
decide what to write over — so a mislabelled backup would have written over the
tenant they really belong to on the same shard.
