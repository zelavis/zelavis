# @zelavis/wordpress

The official Zelavis WordPress Project recipe. It is an officially maintained
service, published to npm on its own release cycle, and it is not shipped with
Zelavis: it reaches an installation through the marketplace allow-list.

A WordPress Project runs dedicated Nginx, PHP-FPM and MariaDB processes with
Project-owned configuration, sockets, ports, logs, site files and database data.
The exact WordPress release is locked in the Project. The package version is the
release it installs (`7.1.0` installs WordPress 7.1, `6.9.4` installs 6.9.4).

## How it plugs in

The Platform hard-codes nothing about WordPress. This package's `package.json`
declares `zelavis.project.runtime: "./dist/runtime.js"`, and that module exports
`createProjectRuntime(context)`. When a Project is prepared the Platform freezes
this package into the Project (content digest recorded in its lock), verifies the
digest on every load, and runs the runtime from the frozen copy, so updating the
package never changes an existing Project.

A recipe runtime is host code that provisions packages and starts processes with
the Platform's authority, so a host only loads one from a recipe it trusts: the
marketplace allow-list entry must say `projectRuntime: true`, the package must be
in the operator's development checkout, or the operator names it in
`projects.recipeRuntimes`.

The authoring API is `zelavis/adapters/project-runtime`.

## Provisioning

`scripts/check-wordpress-provisioning.mjs` proves the runtime installs what it
needs on a host that has nothing (run in a container by
`scripts/wordpress-provisioning-container.sh`, which CI does for both a
privileged and an unprivileged Platform). `pnpm update:wordpress` moves the
package to the current WordPress release.
