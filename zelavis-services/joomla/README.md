# @zelavis/joomla

The official Zelavis Joomla Project recipe: dedicated Nginx, PHP-FPM and MariaDB with Project-owned
configuration, sockets, ports, logs, site files and database. It is an officially maintained service,
published on its own release cycle, and reaches an installation through the marketplace allow-list.

It is the first recipe whose application cannot be set up without values the Platform generated.
Joomla's web installer asks for the database's type, address, name, user and password; the recipe
declares them as the Project's `setup` values (`zelavis projects setup <id>`, and with `--reveal`
for the password, which is audited and needs `project.setup.reveal`).

`src/recipe.ts` is `defineRecipe({ install, start })`, written against `zelavis/recipe`. The Platform's
recipe runtime finds the executables, allocates the ports, runs each phase confined, supervises and
adopts the processes, upgrades the recipe of a running Project without stopping it, and moves the
declared `site` and `db` directories when a newer recipe names other paths. Upgrading the recipe never
changes Joomla itself; Joomla updates itself.

It needs the `php-stack` and `mariadb-server` host package sets.
