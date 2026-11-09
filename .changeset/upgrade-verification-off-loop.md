---
"zelavis": patch
---

Verify installed engines on a worker thread, so the engine checks before a data migration no longer wait behind a busy Platform's request handling: the combined data migration and recipe upgrade of a managed WordPress Project fell from 75–89 s to about 55 s in the update gate. On a native App, **Manage version** now moves to an engine that writes another data layout with **Stop, migrate and switch** (the restarting upgrade) instead of the plain switch, which the Platform refuses across layouts.
