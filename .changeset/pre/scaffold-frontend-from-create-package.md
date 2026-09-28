---
"zelavis": minor
---

Scaffold a frontend from a `create-*` package.

`POST /runtime/services` accepts `scaffoldFrom` alongside `packageSource`. The
create package is acquired through the same verified npm path as any other
install — so the installation's source policy governs what can run — and its
declared bin runs as a child under Node's permission model with the network
closed: no child processes, no native addons, reads confined to the package and
the run directory, writes confined to the output directory, and the outbound
network primitives removed from the module layer the child sees.

Deliberately not `npx`, which would resolve and install a dependency tree from
whatever registry npm is configured with and leave the source policy
decorative. What the run produces is validated as a Zelavis frontend and
registered like any other installed package, so it is immediately selectable as
a Project recipe.

This is a boundary against a create package doing something unexpected, not an
OS sandbox; an operator running genuinely untrusted create packages still wants
container isolation around the Platform.
