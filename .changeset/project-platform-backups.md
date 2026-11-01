---
"zelavis": minor
---

Scheduled backups capture a whole Project (database image, a consistent copy of its runtime store, and its media) and the Platform backs up its own System Store on its own schedules (`runtime/backups`, `client.runtime.backups`, `zelavis backups`, Server → Backups). A restored System Store is applied host-locally with the Platform stopped by `zelavis system-store import`.
