---
"zelavis": minor
"create-zelavis": minor
---

Update a server from its own dashboard. The Platform checks npm for a newer version on its channel (at start and every six hours), a banner offers **Update now** on every page, and Settings has an Updates card; `zelavis update status|check|apply [--wait]`, `client.updates` and `GET /runtime/updates`, `POST /runtime/updates/check` and `/apply` do the same (`system.updates.view` / `system.updates.manage`). The unprivileged Platform only drops a request; a root-owned `zelavis-update.path` unit starts `zelavis update --run`, which looks up the newest version itself (never taking one from the request), refuses anything not newer, runs the installer embedded in the installed release, waits for the new release to answer, and rolls back to the previous release if it does not. The installer sets the two units up for the default system instance, `zelavis doctor` reports whether updates are armed (`update-watch`), and complete uninstall removes the units and the `<data>/update` folder. User-mode installs, named instances and macOS still update by running the installer again.
