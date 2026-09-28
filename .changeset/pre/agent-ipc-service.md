---
"zelavis": minor
---

Run the Agent as its own process.

`zelavis agent` serves the process command contract over a unix socket, and a
host opts in with `projects.agentEndpoint`. The Project drivers are unchanged —
they were put behind the contract for exactly this, so a second implementation
changes the transport rather than three supervisors.

The operator supervises the Agent themselves, so it is restarted on its own
terms rather than inheriting the Platform's lifetime. A Platform that dies no
longer takes supervision down with it: the Agent keeps running the Projects,
and disconnecting is not stopping.

Reclamation follows the ownership. Processes whose Platform disconnected are
stopped by the next Platform's boot sweep, because nothing can drive them any
more — a record-only check would skip them forever, since the record names the
still-running Agent as their owner. A live Platform's processes are left alone.

The Node adapter now owns one Agent for all three Project drivers and reclaims
through it while composing, so an installation that boots and starts nothing
still cleans up after a crashed Platform.

Trust rests on filesystem permissions: a 0700 endpoint directory and a 0600
socket, with a shared token as a second lock for a path that turns out more
permissive than intended.

Not yet included: re-attaching to Projects an earlier Platform started. The new
Platform has no handles to them, so it reclaims and starts fresh, and
`survivesControlPlaneRestart` stays false.
