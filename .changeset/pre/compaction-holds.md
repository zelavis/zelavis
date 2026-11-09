---
"zelavis": minor
---

Add holds on a partition's log. A reader that copies records and then follows the log takes a hold (`store.holdLog({ id, position, ttlMillis })`, `releaseLog`), and `compact` goes only as far as the lowest live hold and reports where it was held (`heldAt`) instead of refusing, so a long copy of a busy Tenant is not started over by every compaction pass. A hold is renewable, only ever raised, ends with its time (at most ten minutes) and is limited to 64 a partition; one below the compaction point is refused (`LogCompacted`). Branching a Tenant, a moved or followed copy and the export stream hold their source this way. Holds are in-process like the writer and only prevent starvation: the readers' own detection stays what keeps them correct.
