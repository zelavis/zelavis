---
"zelavis": patch
"@zelavis/marketplace": patch
---

The Marketplace no longer offers a version your Zelavis cannot run. Each version on the allow-list now names the oldest Zelavis it needs, so a server is offered every app, plugin and frontend at the newest version it runs, and creating or upgrading a Project picks that version too. Installing a version that needs a newer Zelavis is refused before anything is downloaded, with a message naming the version to update to.
