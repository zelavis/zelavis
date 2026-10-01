---
"zelavis": minor
"create-zelavis": minor
---

Replace folder scaffolding with a machine installation through the shared Zelavis installer. Create selects the exact Platform version, verifies its matching prebuilt release, and uses a private Node in system or user mode. System elevation acquires a fresh verified root-owned tree rather than executing package-cache files as root.

Add `zelavis install --from package --version <exact-version>` and `--user`, preserve the versioned release layout, and include user data/configuration/token/receipt in complete uninstall. The launcher never falls back to host Node. Matching release archives must be published alongside these packages; singleton locking, doctor and named instances remain planned.
