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
