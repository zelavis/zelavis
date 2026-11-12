---
"zelavis": patch
---

Retrying a completed workflow that returns no value now reads its saved result. Workflow replay also reuses saved activity and durable deferred results when their encoded value is undefined.
