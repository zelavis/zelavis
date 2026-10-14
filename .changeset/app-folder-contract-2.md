---
"zelavis": patch
"@zelavis/wordpress": patch
"@zelavis/dokuwiki": patch
"@zelavis/drupal": patch
"@zelavis/joomla": patch
"@zelavis/typo3": patch
"@zelavis/prestashop": patch
---

A third-party app's Project now keeps the application, and only the application, in `app/`: its site in `app/site` and its database in `app/db`. Everything Zelavis runs it with (web server and PHP configuration, pid files, logs, temporary files) lives in `.zelavis/server` instead, so recipe updates, new dashboard features and Platform updates never touch the application's folder. WordPress, DokuWiki, Drupal, Joomla, TYPO3 and PrestaShop use this layout (recipe contract 2). An existing Project moves to it with an ordinary recipe upgrade, live and without stopping: its site and database stay exactly where they are, only the Platform's own files move out of `app/`.
