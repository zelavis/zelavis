---
"zelavis": minor
---

Move native release installation and complete uninstall into inspectable TypeScript plans with an injectable host. The installer entries now call `zelavis install` (`--from-release` for a staged tree such as a Debian package's); release templates remain the source for units and configuration. Keep existing tokens, account ownership and foreign-command diagnostics. Native services now bind to 127.0.0.1 by default; `--public` explicitly binds to all interfaces. Package acquisition, create-command changes, singleton locks and named instances remain planned.
