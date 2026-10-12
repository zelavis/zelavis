# @zelavis/wordpress

## 7.1.3-alpha.3

### Patch Changes

- 7c7dab2: WordPress is now a recipe (`defineRecipe` install and start phases) run by the Platform's recipe runtime instead of a hand-written runtime module. Phases run in their own process under Node's permission model, the process plan is supervised and adopted after a restart, and the WordPress release is pinned in the recipe's `zelavis.project.install` manifest. A stopped WordPress Project made by an earlier version upgrades to it from the Upgrade action: its folders are renamed into the new layout and its ports, database password and socket identity are carried over, so its address, content, uploads and admin login stay as they were (the move is journaled and is reversed if anything fails). New Projects use the new layout.
  
  A running Project made from a recipe with a process plan now upgrades to a newer recipe without stopping: the new plan is reconciled against the running processes, unchanged ones keep serving, configuration-only changes reload in place and only changed processes are replaced in dependency order, with a durable journal and rollback to the previous plan on any failure.
  
  Managed apps (WordPress and any recipe that declares `managed`) upgrade their processes and their Zelavis integration in one transaction while running, and a recipe upgraded while stopped prepares the app the next time it starts.
  
  A recipe can place its data directories by name (`directories` in the manifest, `context.directories.named`). A running Project upgrades to a recipe that names another path without touching its data, and the data moves, atomically, the next time the Project starts from a stop.
  
  While a launch change replaces a serving process, public requests wait at the gateway instead of failing. `@zelavis/dokuwiki` is a second managed recipe (Nginx and PHP-FPM, no database) on the same path, and WordPress now declares its site and database directories by name.
  
  Recipes can declare `setup` values (templates over the Project's ports, directories, sockets, account and generated secrets) for an application's own installer: `projects setup <id> [--reveal]`, `client.projects.setup|revealSetup` and `GET|POST /projects/:id/setup[/reveal]`; revealing needs `project.setup.reveal` and is audited. `@zelavis/joomla` is the first recipe to use them. Host package sets `php-stack` and `mariadb-server` join `wordpress-stack`; `@zelavis/dokuwiki` uses `php-stack` alone.
  
  The dashboard has a Setup page for managed Projects (values, a Reveal secrets button and recent reveals), and the reveal trail is readable through HTTP, SDK and CLI (`projects setup-audit`). `@zelavis/wordpress` now needs the `php-stack` and `mariadb-server` sets; `@zelavis/typo3` is a fourth managed recipe.
  
  Recipes bring their own PHP: manifest `runtimes` pin a build per platform (address, SHA-256, size), unpacked once into `<data>/runtimes/<sha256>/` and offered as commands. WordPress, DokuWiki, Joomla and TYPO3 no longer need PHP on the host, run the PHP version they pin, and an upgrade can switch builds. The host package sets are now `nginx` and `mariadb-server`.
  
  Recipes bring their own web server too: all five managed recipes (WordPress, DokuWiki, Joomla, TYPO3, new `@zelavis/prestashop`) pin Caddy next to their PHP, so only MariaDB is still taken from the host (`mariadb-server`), and DokuWiki needs nothing from it. The recipe host unpacks `.zip` archives with plain Node, retries downloads that stumble, and the Platform prunes runtime builds no Project names.
  
  New `@zelavis/drupal` (Drupal 11.4.9 from drupal.org, pinned): the sixth managed recipe, on its own PHP 8.4 and Caddy, with Drupal's web installer fed from the Project's setup values. A runtime download may list up to three `mirrors` (other places holding the same archive, tried in order; the digest is the only trust).
  
  Recipes bring their own MariaDB on Linux x86_64 (pinned official 11.4.9 build as the `mariadbd`, `mariadb-install-db` and `mariadb` runtimes); a runtime's `hostRequirement` names the host requirement used on platforms without a build. WordPress, Joomla, TYPO3, PrestaShop and the new Drupal no longer need the `mariadb-server` host package there.
  
  WordPress, Joomla, TYPO3, PrestaShop and Drupal offer a second install method, `container`, that runs MariaDB from the official image (pinned by digest) through the operator's own Docker; the database code of all five is now one shared helper in `zelavis/recipe`. A process can be ready on its server's greeting (`readiness.greeting`), and `RecipeContext.account` carries numeric `uid`/`gid`.
- Updated dependencies [7c7dab2]
  - zelavis@2.0.0-alpha.26

## 7.1.3-alpha.2

### Patch Changes

- Share Node Platform and App engine factories, and use Effect scopes to close HTTP before stores during shutdown and failed startup. Add shared Effect admission and handover primitives and a Node supervisor with streaming ingress, exclusive writer transfer, generation checks and rollback, exercised against both actual runtime compositions.

  Add immutable recipe snapshots, a scoped kernel-locked journal with flushed release/generation checkpoints, and a Gateway broker that preserves replay protection and queued authorization across worker replacement. Reserve a fresh generation for every update attempt, including aborted drains, and bound the complete readiness probe.

  Run native Apps behind a persistent host and allow qualified running recipe upgrades through the existing HTTP, SDK, CLI and dashboard action. Persist an unfinished Project update, freeze the candidate separately, and acknowledge the Platform recipe lock before admission resumes. Failed lock commits roll back; reconciliation settles lost replies from proved host selection. Preserve deletion precedence and re-key surviving Gateway hosts over the Agent pipe.

  Seal full engine artifacts including their private Node and dependency-link graph, execute installed App locks through the exact release catalog, and retain qualified engine versions during Platform updates. Stage releases through the same script-disabled npm transport used by installations.

  Run the main Platform behind the same persistent host. Dashboard updates prepare an immutable release, drain accepted requests, transfer exclusive store ownership, probe adoption of running Projects, and acknowledge the root-owned receipt, current link and public version descriptor before resuming traffic. Preview listeners share admission and remain bound during transfer and rollback. User installations use the same handover.

  Enable the separately supervised Project Agent for every system installation; remove the optional Agent flag. Adopt WordPress daemon handles by exact execution identity and put Linux Unix sockets in shared installation data so the Platform and Agent can use them across separate private temporary directories. Preserve Project placement custody across engine replacement. Unexpected engine exit wakes the host for supervised restart.

  Explicit native App recipe upgrades select the latest qualified installed engine. New Apps use that same default, even on an older parent; parent upgrades and rollbacks preserve existing App engine pins. Public older-version selection controls remain planned.

  Breaking installation transition: installations without the persistent host and versioned runtime inventory need one full local installer run, which restarts the old process. The live installer refuses unsupported handover protocols; there is no legacy execution shim.
- Updated dependencies
  - zelavis@2.0.0-alpha.16

  Persist status refreshes under the same Project lifecycle permit as upgrades so a stale read cannot overwrite a recipe lock, update intent or deletion tombstone. Fleet views remain read-only for Fabric scheduling. Keep ordinary Platform startup ready while desired-running Projects reconcile asynchronously; require adoption proof only for engine handover.

## 7.1.3-alpha.1

### Patch Changes

- Use Effect v4 for Project lifecycle, native runtime drivers, recipe rollback and update orchestration; preserve durable deletion progress on interruption and enforce mandatory Effect usage.
- Updated dependencies
  - zelavis@2.0.0-alpha.15

## 7.1.3-alpha.0

### Patch Changes

- Provision the WordPress host stack through a separately supervised, operation-only root Agent with signed, bounded requests and explicit server.packages.install authorization. System installs and updates configure the broker automatically; Project processes remain unprivileged. Project creation exposes the same package-install opt-in through the dashboard, HTTP, SDK and CLI. Package installation preserves existing host services and suppresses package-triggered starts; uninstall restores only the owned policy.

  Separate WordPress software pins from recipe revisions. The recipe no longer invokes APT or sudo or asks operators to run the Platform as root; its pinned WordPress archive is unchanged.
- Updated dependencies [bbe74e4]
- Updated dependencies
- Updated dependencies
  - zelavis@2.0.0-alpha.12
