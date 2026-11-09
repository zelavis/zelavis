---
"zelavis": minor
---

Followers on other hosts. The leader's database serves everything a follower pass reads over its versioned API —
partition stats, records and log a page at a time, holds on the log, acknowledgments, and a change feed of which
partitions moved — through `GET|POST …/database/followers/*` (`database.replicate`, granted with
`project.runtime.manage`), `client.followers(projectId)` and `zelavis followers`. `remoteLeader`, `remoteAcknowledgments`
and `remoteChanges` in `zelavis/db` make that the same source `levelFollower` and `followLeader` read in-process, so a
follower on another host seeds, carries on, re-seeds after compaction (the leader's `CursorCompacted` arrives as itself)
and acknowledges what it committed, and the leader's `writeAcknowledged` waits on it. `db.followers.follow` keeps a
partition of a database a follower and tells its cross-Tenant indexes after every pass; `followLeader` takes `wakeups`
(the change feed) so a follower wakes on a write instead of polling. Log holds move with a partition: a move carries the
live holds to the target. Cross-Tenant indexes take `crossTenantRefresh.notifications`, so a write they did not see is
read without waiting for the sweep.
