---
"zelavis": patch
"@zelavis/ui": patch
---

A data-layout migration now replays document puts and deletions for live collections with uncompacted logs. It keeps their order, revisions, and times so time series can rebuild the same points. A compacted partition carries its final document state. The export is checked against the earlier engine's own reads, so a shard whose log reached that engine's export limit is refused instead of migrated with missing writes. A change-feed cursor issued before the migration is still refused; its consumer reads the feed from the start. Activating a schema now writes a collection's documents back only when the schema changes what they index, so an activation that changes no lens adds no change events.
