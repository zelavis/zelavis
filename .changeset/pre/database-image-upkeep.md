---
"zelavis": minor
---

Database images record a SHA-256 digest per shard and can be verified, deleted and pruned to the newest N, through HTTP, the SDK (`verifyDatabaseImage`, `deleteDatabaseImage`, `pruneDatabaseImages`), the CLI (`verify-image`, `delete-image`, `prune-images`) and a new Database → Images dashboard page.
