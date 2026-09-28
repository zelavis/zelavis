---
"zelavis": minor
---

Run `server` frontends as Project-owned runtimes.

A server frontend — an application that brings its own HTTP server — is now
executed by a Project runtime driver rather than refused. The driver spawns the
manifest's declared argv with a Platform-allocated port, waits for that port to
accept connections, and reports a routable loopback URL.

Readiness is a port check rather than a protocol handshake: an arbitrary
frontend knows nothing about Zelavis, so the only portable signal is that it
bound the port it was told to use. A frontend that exits before binding fails
with its own stderr attached, and one that never binds times out rather than
hanging the lifecycle.

The driver reuses the Project environment allow-list and log bounds instead of a
second copy, so a frontend never inherits Platform secrets. A static frontend is
refused a process, because it does not need one.
