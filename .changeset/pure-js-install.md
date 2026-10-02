---
"zelavis": patch
"create-zelavis": patch
---

Remove the last native dependency. The local System Store now uses Node's built-in `node:sqlite` instead of `better-sqlite3`, which ships no prebuilt binaries and so needed a compiler (`make`, a C++ toolchain) on the server and failed to install on a plain Debian/Ubuntu host. The bootstrap no longer rebuilds anything, and the launcher silences Node's experimental-SQLite warning. The installed tree is plain JavaScript on the private Node.
