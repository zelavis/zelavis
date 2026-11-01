---
"zelavis": minor
"@zelavis/wordpress": patch
"@zelavis/joomla": patch
"@zelavis/drupal": patch
"@zelavis/prestashop": patch
"@zelavis/typo3": patch
"@zelavis/dokuwiki": patch
---

Backups of managed apps, and restore drills on another machine. Each named directory of a recipe manifest says how a
backup captures it (`backup: "files" | "recipe"`), and a managed app's Project backups gain an `app` component: the
`files` directories copied as they are, and what the recipe's `backup` phase makes of the rest. The MariaDB recipes dump
their database in one transaction while the site serves, with the shared `dumpMariaDb` from `zelavis/recipe` and the
`mariadb-dump` they now pin beside `mariadbd` (the host's where they fall back to it, the image's own in the container
method). A drill checks the `app` component. `drillFrom` drills any run on a machine holding nothing but the target and
the recovery key: `POST …/runtime/backups/drills`, `client.runtime.backups.drillFrom`, `zelavis backups drill-from`.
The release gate `pnpm release:qualify:backups` backs up a serving WordPress Project, drills and restores it, and
drills the same run on a second, fresh machine.
