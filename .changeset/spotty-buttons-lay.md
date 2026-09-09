---
"zelavis": patch
---

Prove what `synchronous = NORMAL` promises, rather than assuming it.

In WAL mode that setting does not fsync on every commit, which trades two
guarantees against each other. A killed process must lose nothing it had already
committed; a power cut may lose recent transactions but must never leave the
database torn. Both are now tested by killing real processes: a `SIGKILL`ed
writer loses no committed transaction on any of the four engines, and a
write-ahead log truncated mid-frame recovers a prefix of what was written rather
than a set with holes in it.

Also covers the maintenance passes: a seal killed halfway leaves every query
answering as it did, because the read handles a store that is part sealed and
part live.
