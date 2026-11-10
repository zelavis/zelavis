---
"zelavis": patch
"@zelavis/ui": patch
---

A data-layout migration now carries each Tenant's document change history: every put and deletion is recreated in order at its original time, so the change feed and the time series rebuilt from it are what they were. The export is checked against the earlier engine's own reads, so a shard whose log reached that engine's export limit is refused instead of migrated with missing writes. A change-feed cursor issued before the migration is still refused; its consumer reads the feed from the start. Activating a schema now writes a collection's documents back only when the schema changes what they index, so an activation that changes no lens adds no change events.
