# @zelavis/wordpress

The official Zelavis WordPress Project recipe. It is an officially maintained
service, published to npm on its own release cycle, and it is not shipped with
Zelavis: it reaches an installation through the marketplace allow-list.

A WordPress Project runs dedicated Nginx, PHP-FPM and MariaDB processes with
Project-owned configuration, sockets, ports, logs, site files and database data.
The exact recipe revision is locked in the Project. Its WordPress software version
and archive digest are pinned independently, so provisioning fixes can ship without
changing the WordPress release.

This recipe requires Zelavis 2.0.0-alpha.16 or newer. Its runtime adopts all three
daemon handles from the separately supervised Project Agent during a Platform
engine handover, verifying their execution identities before admitting traffic.
Linux sockets live in shared installation data so separately supervised systemd
units can reach them. Frozen older recipes require an explicit recipe upgrade;
updating the Platform never rewrites their code.

## What is in the package

The recipe is `src/recipe.ts`: `defineRecipe({ install, start })`, written with Effect against
the `zelavis/recipe` contract. `install` downloads the pinned release (digest-checked),
writes the site's configuration with the credentials as secret references, validates the
Nginx and PHP-FPM configuration, and initializes a dedicated MariaDB data directory.
`start` returns the three processes (database, PHP-FPM, Nginx) as a plan. It knows nothing
about the machine: the Platform's recipe runtime finds the executables (Debian paths,
Homebrew), allocates the ports, picks the OS account, runs each phase in a process of its own
under Node's permission model, supervises and adopts the processes, and cleans up.
The WordPress releases on offer, with their archive addresses and SHA-256 digests, are the
`zelavis.project.install` manifest in `package.json` (`pnpm update:wordpress` adds the
newest); a Project chooses one when it is created and keeps it.

Files live below the Project's `app/` directory (`site/`, `db/`, `run/` and the generated
configuration); generated credentials live in `.zelavis/secrets/`, outside it.

## Upgrading an existing Project

A Project made by an earlier version of this recipe (site in `.zelavis/wordpress`, database in
`.zelavis/mariadb`) upgrades to this one with the Project's **Upgrade** action once it is
stopped. The `adopt` entry in the manifest tells the Platform to move those folders into the
new layout and carry over the ports and database password, so the address, content, uploads and
admin login stay exactly as they were; nothing in WordPress or its database is read or
rewritten. If the upgrade cannot be completed the folders are moved back.

## How it plugs in

The Platform hard-codes nothing about WordPress. This package's `package.json`
declares `zelavis.project.runtime: "./dist/runtime.js"`, and that module exports
`createProjectRuntime(context)`, which is three lines over the Platform's
`createRecipeProjectRuntime`. When a Project is prepared the Platform freezes
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
of `projects.create`. The Platform submits the fixed `php-stack` and `mariadb-server` sets to its
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
WordPress startup, idempotent retry, Platform handover and rollback, live App
engine upgrades, stable preview traffic, doctor and complete uninstall.
`pnpm update:wordpress` refreshes software
pins; add a recipe changeset to release them.
