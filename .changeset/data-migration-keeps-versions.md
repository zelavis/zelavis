---
"zelavis": patch
"@zelavis/ui": patch
---

A data-layout migration now keeps each document's version, creation and update times and expiry. Before, versions restarted at one, so a client holding a version read before the migration could later have a stale `expectedVersion` write accepted, once the document had been written that many times again, and overwrite newer data. Only the change history still restarts: a change-feed cursor issued before the migration is refused, and its consumer reads the feed again.
