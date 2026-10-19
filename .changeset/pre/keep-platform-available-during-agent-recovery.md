---
"zelavis": patch
---

Keep the dashboard, login, Project status, logs and repair APIs available during
Project Agent conversion. Resume recovered sites before private integrations
finish starting, and release expired or failed recovery holds so one Project
cannot leave the Platform and other sites permanently unavailable. Allow cold
Project hosts to finish their bounded startup before declaring them failed.

Keep unused hosting backends lazy during conversion, include private integration
failures in the owning Project's logs, and show App hosts and workers in their
Project diagnostics.

Restore private Project runtimes asynchronously after public recovery, with a
separate deadline per Project. Qualify both the previous-release update and the
direct pre-survival Agent conversion on a two-CPU, 4-GB test server.
