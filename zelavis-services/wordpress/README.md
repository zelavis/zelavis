# @zelavis/wordpress

The official Zelavis WordPress Project recipe. It is an officially maintained
service, published to npm on its own release cycle, and it is not shipped with
Zelavis: it reaches an installation through the marketplace allow-list.

A WordPress Project runs dedicated Nginx, PHP-FPM and MariaDB processes with
Project-owned configuration, sockets, ports, logs, site files and database data.
The exact recipe revision is locked in the Project. Its WordPress software version
and archive digest are pinned independently, so provisioning fixes can ship without
changing the WordPress release.

## How it plugs in

The Platform hard-codes nothing about WordPress. This package's `package.json`
declares `zelavis.project.runtime: "./dist/runtime.js"`, and that module exports
`createProjectRuntime(context)`. When a Project is prepared the Platform freezes
this package into the Project (content digest recorded in its lock), verifies the
digest on every load, and runs the runtime from the frozen copy, so updating the
package never changes an existing Project.

A recipe runtime is host code that prepares Project files and starts processes with
the Platform's authority, so a host only loads one from a recipe it trusts: the
marketplace allow-list entry must say `projectRuntime: true`, the package must be
in the operator's development checkout, or the operator names it in
`projects.recipeRuntimes`.

The authoring API is `zelavis/adapters/project-runtime`.

## Provisioning

On Debian/Ubuntu, check **Install required host packages** in the create-project
form, or use `zelavis projects create Blog --recipe @zelavis/wordpress
--install-host-packages`. This requires `server.packages.install`, independently
of `projects.create`. The Platform submits the fixed `wordpress-stack` set to its
signed host-operation broker before preparing the Project. System installations
and updates configure a separate root operation Agent; the Platform and Project
processes remain unprivileged. The recipe never runs APT or sudo.

Package-triggered service starts are suppressed only for that APT process tree.
An existing `policy-rc.d` is preserved and delegated to for ordinary invocations;
only newly introduced systemd units are disabled. Complete uninstall restores the
owned policy and retains shared packages. macOS development uses the Homebrew
owner's account.

`scripts/wordpress-provisioning-container.sh` qualifies a clean packaged Debian
systemd installation, the root broker, denied package authority, cancellation,
WordPress startup and idempotent retry. `pnpm update:wordpress` refreshes software
pins; add a recipe changeset to release them.
