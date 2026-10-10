# @zelavis/drupal

The official Zelavis Drupal Project recipe: Caddy, PHP-FPM and a dedicated MariaDB with Project-owned
configuration, sockets, ports, logs, site files and database. It is an officially maintained service,
published on its own release cycle, and reaches an installation through the marketplace allow-list.

Drupal is downloaded from drupal.org (`ftp.drupal.org/files/projects`), pinned to one release and its
SHA-256. The recipe prepares what Drupal's web installer expects (`sites/default/settings.php` copied from
the release's defaults, an empty `files/` directory) and serves it; the installer then asks for the
database's name, user, password, host and port, which the recipe declares as the Project's `setup` values
(`zelavis projects setup <id>`, and with `--reveal` for the password, which is audited and needs
`project.setup.reveal`). Clean URLs go to Drupal's front controller; private files, source and
configuration files, and PHP files under `files/` are never served.

`src/recipe.ts` is `defineRecipe({ install, start })`, written against `zelavis/recipe`. Upgrading the
recipe never changes Drupal itself; Drupal updates itself.

It brings its own PHP 8.4 and its own web server (pinned builds in its manifest, unpacked into the
Platform's store), so the host needs no PHP and no web server; it needs only the `mariadb-server` package set.
