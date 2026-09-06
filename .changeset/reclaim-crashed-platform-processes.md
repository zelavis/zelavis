---
"zelavis": minor
---

Reclaim the Project processes a crashed Platform left running.

A Platform killed outright — SIGKILL, an OOM kill, a power loss — runs no
shutdown, so its Project processes keep going. They keep their ports, keep
answering requests, and keep their database files open, while the Platform that
replaces them has no memory of them at all. The observed result was a WordPress
Project reported as running whose new nginx logged
`bind() ... Address already in use`, with traffic served by the process from
before the crash.

The Agent runner now records every process it starts, and stops what a previous
Platform left behind: a full sweep on the first start after boot, and a
per-workload reclaim before that workload starts again. Stopped rather than
adopted — a child's output arrives over pipes owned by the process that spawned
it, so once that process is gone there is nothing to reattach to.

A leftover is identified by how long it has been running rather than by its
command line, because daemons rewrite their own argv: php-fpm reports itself as
`php-fpm: master process (...)`, which contains nothing of the path that was
executed. A record whose owning Platform is still alive is left alone, and a
process whose age does not match its record is never signalled.

The native WordPress readiness waits also now fail when the process they are
waiting for has exited, so a stale listener on a reused port cannot be mistaken
for a successful start.

Also fixes a regression: reconciliation started Projects outside their lifecycle
lock, so a start could interleave with a concurrent stop.
