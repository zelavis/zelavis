---
"zelavis": minor
---

Run a store on a libSQL database reachable only over the network.

The `libsql` engine covers local files and embedded replicas through libSQL's
synchronous binding. `libsql-remote` covers the case that binding cannot: a
database that lives elsewhere, reached with `@libsql/client` (an optional peer).
A `turso://` address is accepted for the one Turso prints.

It implements the key-value contract directly rather than through the shared
SQLite layer, which needs a synchronous handle: range bounds and limits are
pushed into the statement so a page costs one round trip and the rows it
returns, and a write is one `batch` in write mode — all of it lands or none
does, which is the only transaction mechanism the store above it asks for.

Verified against a real Turso database, and the contract tests skip when
`TURSO_URL` and `TURSO_TOKEN` are unset. Prefer an embedded replica wherever a
local file is possible: here every read is a round trip.
