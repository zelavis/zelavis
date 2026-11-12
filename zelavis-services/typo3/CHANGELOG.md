# @zelavis/typo3

## 13.4.36-alpha.2

### Patch Changes

- 0f0457f: Backups of managed apps, and restore drills on another machine. Each named directory of a recipe manifest says how a
  backup captures it (`backup: "files" | "recipe"`), and a managed app's Project backups gain an `app` component: the
  `files` directories copied as they are, and what the recipe's `backup` phase makes of the rest. The MariaDB recipes dump
  their database in one transaction while the site serves, with the shared `dumpMariaDb` from `zelavis/recipe` and the
  `mariadb-dump` they now pin beside `mariadbd` (the host's where they fall back to it, the image's own in the container
  method). A drill checks the `app` component. `drillFrom` drills any run on a machine holding nothing but the target and
  the recovery key: `POST …/runtime/backups/drills`, `client.runtime.backups.drillFrom`, `zelavis backups drill-from`.
  The release gate `pnpm release:qualify:backups` backs up a serving WordPress Project, drills and restores it, and
  drills the same run on a second, fresh machine.
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [4f6719c]
- Updated dependencies [0f0457f]
- Updated dependencies [d57e446]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [4f99eca]
- Updated dependencies [0f0457f]
- Updated dependencies [4f6719c]
- Updated dependencies [0f0457f]
- Updated dependencies [4326e6b]
- Updated dependencies [f88cb26]
- Updated dependencies [bf41f4b]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [ac78c91]
- Updated dependencies [b2e08f1]
- Updated dependencies [0f0457f]
- Updated dependencies [4f6719c]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [ec60fac]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [b7e5333]
- Updated dependencies [362ae43]
- Updated dependencies [0f0457f]
- Updated dependencies [0f0457f]
- Updated dependencies [4f6719c]
  - zelavis@2.0.0-alpha.43

## 13.4.36-alpha.1

### Patch Changes

- 7185b50: A third-party app's Project now keeps the application, and only the application, in `app/`: its site in `app/site` and its database in `app/db`. Everything Zelavis runs it with (web server and PHP configuration, pid files, logs, temporary files) lives in `.zelavis/server` instead, so recipe updates, new dashboard features and Platform updates never touch the application's folder. WordPress, DokuWiki, Drupal, Joomla, TYPO3 and PrestaShop use this layout (recipe contract 2). An existing Project moves to it with an ordinary recipe upgrade, live and without stopping: its site and database stay exactly where they are, only the Platform's own files move out of `app/`.
- Updated dependencies [7185b50]
- Updated dependencies [e540a0d]
  - zelavis@2.0.0-alpha.30
