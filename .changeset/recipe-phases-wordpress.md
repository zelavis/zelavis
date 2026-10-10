---
"zelavis": patch
"@zelavis/wordpress": patch
---

WordPress is now a recipe (`defineRecipe` install and start phases) run by the Platform's recipe runtime instead of a hand-written runtime module. Phases run in their own process under Node's permission model, the process plan is supervised and adopted after a restart, and the WordPress release is pinned in the recipe's `zelavis.project.install` manifest. A stopped WordPress Project made by an earlier version upgrades to it from the Upgrade action: its folders are renamed into the new layout and its ports, database password and socket identity are carried over, so its address, content, uploads and admin login stay as they were (the move is journaled and is reversed if anything fails). New Projects use the new layout.

A running Project made from a recipe with a process plan now upgrades to a newer recipe without stopping: the new plan is reconciled against the running processes, unchanged ones keep serving, configuration-only changes reload in place and only changed processes are replaced in dependency order, with a durable journal and rollback to the previous plan on any failure.

Managed apps (WordPress and any recipe that declares `managed`) upgrade their processes and their Zelavis integration in one transaction while running, and a recipe upgraded while stopped prepares the app the next time it starts.

A recipe can place its data directories by name (`directories` in the manifest, `context.directories.named`). A running Project upgrades to a recipe that names another path without touching its data, and the data moves, atomically, the next time the Project starts from a stop.

While a launch change replaces a serving process, public requests wait at the gateway instead of failing. `@zelavis/dokuwiki` is a second managed recipe (Nginx and PHP-FPM, no database) on the same path, and WordPress now declares its site and database directories by name.

Recipes can declare `setup` values (templates over the Project's ports, directories, sockets, account and generated secrets) for an application's own installer: `projects setup <id> [--reveal]`, `client.projects.setup|revealSetup` and `GET|POST /projects/:id/setup[/reveal]`; revealing needs `project.setup.reveal` and is audited. `@zelavis/joomla` is the first recipe to use them. Host package sets `php-stack` and `mariadb-server` join `wordpress-stack`; `@zelavis/dokuwiki` uses `php-stack` alone.

The dashboard has a Setup page for managed Projects (values, a Reveal secrets button and recent reveals), and the reveal trail is readable through HTTP, SDK and CLI (`projects setup-audit`). `@zelavis/wordpress` now needs the `php-stack` and `mariadb-server` sets; `@zelavis/typo3` is a fourth managed recipe.
