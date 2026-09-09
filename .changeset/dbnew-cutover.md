---
"zelavis": major
---

Replace the document-first SQL database with `zelavis/dbnew`.

The database service is now built on the multi-model object store, both
construction sites open a sharded database through `zelavis/dbnew/node`, and its
shards close on runtime shutdown. `src/app/db` is removed rather than deprecated:
around ten thousand lines, its adapters, its export subpaths, and the seven test
files that exercised it structurally. What those tests covered is asserted
against `dbnew` instead, by tests written against the behaviour rather than
ported from the implementation.

It lands as one change because it cannot land as several. Pointing the service at
the new store forces both construction sites, a `Zelavis` member with its own
lifetime, the `core.database` slot, and two shape guards; those force removing
the old database, whose tests assert a service it would no longer have. Split
across commits it leaves the tree unbuildable between them.

No URL changed. The Tenant was added to the schema and system-view routes in an
earlier change specifically so that switching the store would not also move the
API underneath the dashboard, and so a break in one could not be mistaken for a
break in the other.

Two capabilities are genuinely gone rather than moved. The raw SQL surface was
the last way to reach storage without the guarantees the documents API exists to
provide, and it is not coming back. `@zelavis/app-db-libsql` went with the driver
contract it was built on, so only the Node SQLite driver ships today — engine
swappability is a claim the code does not currently back, and restoring it means
writing a libSQL driver for `dbnew`.

Not yet included: real topology on `/database/health`, which only became
truthful once `dbnew` served the endpoint.
