---
"zelavis": minor
---

A frontend package can now be installed and run as an owned Project.

Frontends are selectable as Project recipes, which they were not — recipes were
filtered to `kind: "app"`, so an installed frontend package could never be
chosen. A frontend recipe always produces a Project of kind `frontend`,
whatever the package is called, because the runtime driver routes on that kind.

The Node adapter supplies the server-frontend driver it never wired, along with
a resolver that finds an installed package by walking up from its locked
specifier to the nearest `package.json`, bounded by the directory packages are
installed into. A frontend that was never installed is refused rather than
guessed at.

Preparing a frontend now also writes the Project record the local runtime reads
back to route `stop`, `logs`, and `destroy`, which take a Project id rather than
a descriptor. A frontend that wrote only its own metadata could be started and
then never stopped.
