---
"zelavis": minor
---

Re-attach to Projects an earlier Platform started.

A Platform behind a separately supervised Agent used to reclaim what it found
running and start again, because it had no handles to those processes. It now
takes them back instead. The Agent keeps a bounded tail of each process's
output and hands a reconnecting client the processes for a workload along with
what it missed; the Node driver re-derives readiness from that replay, which is
the only place the bound address exists — the Project announced it while no
Platform was connected.

Adoption runs before reclamation while the host composes, so a Project that
never stopped serving is taken over rather than killed and restarted. Restarting
is not a harmless alternative: it drops the connections the Project is serving,
and for a Project with a persisted port it collides with the copy still
listening. What remains after adoption is what nothing can drive, and that is
what gets reclaimed.

`survivesControlPlaneRestart` is now read from the runner rather than hardcoded
`false` in three drivers. It is a property of where processes actually run, and
it is true behind an Agent.

Two cases are handled explicitly rather than assumed away: a Project whose
readiness line has aged out of the buffer is reported running without an
address, instead of being routed to a guessed one; and reconciliation stops an
adopted Project whose desired state is stopped, so "stopped" does not quietly
mean "stopped, unless it survived a crash".
