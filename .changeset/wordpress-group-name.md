---
"zelavis": patch
---

Resolve the PHP-FPM group by name instead of assuming it matches the user.

The root fix set `group` and `listen.group` to the account's username. On Debian
that is invisible — `www-data` belongs to a group called `www-data` — and on
macOS an ordinary user belongs to `staff`, so PHP-FPM refused to start with
"cannot get gid for group" and every WordPress Project on a Mac failed.

The group is now read with `id -gn`: the resolved account's group when the
Platform is root, the running user's otherwise.

Found by running the Homebrew provisioning path for the first time, which also
confirmed that path works: from a Mac with none of the packages installed,
WordPress comes up in under a minute.
