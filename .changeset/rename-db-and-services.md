---
"zelavis": major
---

Rename the store to `zelavis/db`, its drivers to engines, and `product-services` to `services`.

`dbnew` was only ever a name for "not the old one", and the old one is gone. The
subpaths become `zelavis/db`, `zelavis/db/node`, `zelavis/db/node-sqlite` and
`zelavis/db/libsql`, and the backup format identifier follows.

`adapters` became `engines`, which is what they are: a driver is a handle to a
storage engine, not an adapter between two APIs. `node-database.ts` moved out of
that folder to `db/node-host.ts`, because opening a database for a promise-based
host is not an engine and sat there only by accident.

`product-services` said who shipped a package rather than what it is. The folder
is now `packages/zelavis/services`. The runtime directory of the same name is
left alone deliberately: it is where an operator drops services on disk, so
renaming it changes a contract with installations rather than a folder in this
repo, and that deserves its own decision.

Also removes `packages/zelavis/adapters`, which had already lost its tracked
contents in the database cutover and was surviving as stale build output.
