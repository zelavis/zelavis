---
"zelavis": minor
---

Add a libSQL driver, over the same store logic as the built-in one.

Removing the old database took `@zelavis/app-db-libsql` with it, because it was
built on the driver contract that went. This restores the engine, and does it
without a second implementation: both drivers meet a small synchronous gateway,
so retraction, manifests, events, cursors and posting evaluation exist once. Two
copies of that logic would not diverge visibly — they would diverge into one
engine quietly returning different rows.

It uses libSQL's synchronous binding rather than `@libsql/client`. The
asynchronous client would make every statement a promise, and a transaction
built from promises on one connection is one another caller can write inside;
that needs serialization designed rather than assumed. The synchronous binding
covers local files and embedded replicas syncing from a primary, which is the
case worth having first.

Two differences between the engines are handled in the driver rather than pushed
into the store. libSQL binds `Buffer` but not a bare `Uint8Array`, and it returns
blobs as a `Buffer` from `get` but an `ArrayBuffer` from `all` and `iterate`.
Rows are only rebuilt when they actually carry a blob, because posting scans
return rows of plain integers and are the hottest path in the engine.

`libsql` is an optional peer dependency: an installation that does not ask for
the engine should not have to carry it.

Not yet included: remote-only libSQL, which needs the asynchronous client and
therefore the transaction serialization above.
