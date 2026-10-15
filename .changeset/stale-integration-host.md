---
"zelavis": patch
---

A managed app whose integration host had kept running through several Platform updates could fail **Update recipe** with "Recipe manifest does not match contract 1", because that host loaded the new recipe with its own older code. The Platform now replaces an integration host that runs an earlier release's code before using it. The app's own processes keep serving while it does. Requests that fail with a reference ID now record the full error under that ID in **Server → Logs** and the service journal, so the reference always leads to the cause.
