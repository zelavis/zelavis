---
"zelavis": minor
---

Add a provider-neutral remote environment identity, health, session, process,
and cursor-based event replay contract with matching tenant-scoped HTTP routes
and SDK methods. The Node adapter now projects the supervised Zelavis Agent
process runner onto that contract, including stdin, signals, termination,
bounded incarnation-aware output replay, and reattachment of active session
processes after a Platform restart.
