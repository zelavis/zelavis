---
"zelavis": minor
---

Re-seal only what changed since the last seal.

Once a store has been sealed, every posting write marks the group it lands in,
and the next seal visits only the marked groups instead of every posting still
live. A value an earlier seal declined as too sparse is no longer read again by
every seal after it: re-sealing 2,000 changed objects of 200k takes 0.19 s,
down from 0.66 s. The first seal, and the first after a reindex or a rebuild,
still sweeps every posting.

`db.seal` reports, per shard, how many live postings the seal `examined`.
