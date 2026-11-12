---
"zelavis": patch
---

A managed app whose integration host had kept running through several Platform updates could fail **Update recipe** with "Recipe manifest does not match contract 1", because that host loaded the new recipe with its own older code. A host now checks only that a recipe is the locked one, never its content, so later recipes cannot trip it, and a host from an earlier release that cannot read a recipe it is about to load is replaced first. The app's own processes keep serving while it is. Requests that fail with a reference ID now record the full error under that ID in **Server → Logs** and the service journal, so the reference always leads to the cause.
