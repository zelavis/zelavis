# @zelavis/dokuwiki

The official Zelavis DokuWiki Project recipe: a flat-file wiki with its own Caddy and PHP-FPM,
no database. It is an officially maintained service, published on its own release cycle, and reaches
an installation through the marketplace allow-list.

It is the second managed recipe, chosen to differ from WordPress in shape (two processes, no
credentials, no database) so that the recipe runtime, the live upgrade and the integration are known
not to depend on one application.

`src/recipe.ts` is `defineRecipe({ install, start })`: `install` downloads the pinned release
(digest-checked), validates the Caddy and PHP-FPM configuration; `start` returns the two processes.
The Platform finds the executables, allocates the port, runs each phase confined, supervises and
adopts the processes, upgrades the recipe of a running Project without stopping it, and moves the
`site` directory (declared by name in `zelavis.project.install.directories`) when a newer recipe
names another path. DokuWiki's own installer, opened in the browser on first visit, creates the
administrator. Upgrading the recipe never changes DokuWiki itself; DokuWiki updates itself.

It brings its own PHP and its own web server (pinned builds of PHP's CLI and FPM and of Caddy in its manifest, unpacked into the Platform's store), so the host needs nothing at all: no PHP, no web server, no database, no package set.

The software version is `2026.7.14` (the manifest allows numeric versions only); the pinned archive is DokuWiki's `2026-07-14c` release, whose letter is part of the archive address.
