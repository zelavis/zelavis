# @zelavis/typo3

The official Zelavis TYPO3 Project recipe: Caddy, PHP-FPM and a dedicated MariaDB with Project-owned
configuration, sockets, ports, logs, site files and database, from TYPO3's own source package
(a complete classic installation, `vendor` included). It is an officially maintained service,
published on its own release cycle, and reaches an installation through the marketplace allow-list.

Installing unpacks the pinned release into the web root and leaves TYPO3's `FIRST_INSTALL` marker, so
its installer opens on the first visit. The installer asks for the database's driver, address, port,
name, user and password; the recipe declares them as the Project's `setup` values
(`zelavis projects setup <id>`, and `--reveal` for the password, which is audited and needs
`project.setup.reveal`). The Platform's recipe runtime upgrades the recipe of a running Project
without stopping it and moves the declared `site` and `db` directories when a newer recipe names
other paths. Upgrading the recipe never changes TYPO3; TYPO3 updates itself.

It brings its own PHP and its own web server (pinned builds of PHP's CLI and FPM and of Caddy in its manifest, unpacked into the Platform's store), so the host needs no PHP and no web server and the versions are the recipe's to choose; the host needs only the `mariadb-server` package set.
