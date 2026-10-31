---
"zelavis": minor
---

Add bounded logical-schema import/export and standalone TypeScript generation
through the database API, HTTP, SDK and CLI. Imports default to dry run, preflight
immutable-version conflicts and activate only when explicitly requested. Schema
versions are now claimed atomically under the partition writer.
