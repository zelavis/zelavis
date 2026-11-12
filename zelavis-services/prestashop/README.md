# @zelavis/prestashop

The official Zelavis PrestaShop Project recipe: Caddy, PHP-FPM and a dedicated MariaDB with
Project-owned configuration, ports, logs, shop files and database, from PrestaShop's own release
archive (a zip holding a zip, both unpacked by the recipe host with nothing but Node).

It brings **its own PHP 8.1** (pinned builds of the CLI and FPM) and its own Caddy, so the shop runs on
the PHP release PrestaShop 8 is built for whatever PHP the host has, or none. The host needs only the
`mariadb-server` package set. The installer's database values are the Project's `setup` values
(`zelavis projects setup <id>`; `--reveal` for the password, audited, needs `project.setup.reveal`).
The back office folder is named by PrestaShop's installer, so the Project's admin link is the site root.
Upgrading the recipe never changes PrestaShop; PrestaShop updates itself.
