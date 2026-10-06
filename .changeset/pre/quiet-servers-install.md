---
"zelavis": minor
"create-zelavis": minor
---

Replace folder scaffolding with a machine installation through the shared Zelavis installer. Create selects the exact Platform version and uses a private Node in system or user mode. System elevation acquires a fresh root-owned tree rather than executing package-cache files as root.

Add `zelavis install --from-npm <prepared-tree>` and `--user`, preserve the versioned release layout, and include user data/configuration/token/receipt in complete uninstall. The launcher never falls back to host Node. Singleton locking, doctor and named instances remain planned.
