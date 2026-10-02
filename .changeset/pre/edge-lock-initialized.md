---
"zelavis": patch
"create-zelavis": patch
---

Fix the Platform service crash-looping on a real Linux host. The Edge ownership lock lives in the root-owned installation prefix, and SQLite writes a database header (needing a journal file in that directory) the first time anyone locks an empty file, which the unprivileged service user cannot do, so every start failed with a misleading "already reserved". The installer now initializes the lock file as root and the service only takes the lock. Re-running the installer repairs an existing install. Ownership errors now name the real cause instead of always saying the lock is reserved.
