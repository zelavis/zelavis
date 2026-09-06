---
"zelavis": patch
---

Run the native WordPress stack when the Platform is root.

A Platform installed as a system service runs as root, and the code invited that
— `provisionNativeWordPressPackages` has an explicit root branch for apt. It
installed the packages and then could not start the Project.

Four things had to hold at once, each only visible once the one before it was
fixed:

- MariaDB refuses to run as root at all unless told which user to become, and
  installing `mariadb-server-core` leaves no `mysql` account to name.
- An account that owns the Project files still cannot reach them unless every
  directory above is traversable, and the Platform's data directory is created
  0700 by root. The execute bit is added, never the read bit, stopping at the
  first directory the Platform does not own — so a directory can be walked
  through by something that knows the path and still cannot be listed.
- PHP-FPM's master creates the pool's socket while it is still root, so without
  `listen.owner` it lands root-owned and nginx — which dropped to the same
  account the pool did — answers 502.
- nginx needs a `user` directive to drop its workers, but only when started as
  root; an unprivileged nginx warns about it.

The daemons share one account rather than the conventional `mysql`/`www-data`
split: they serve a single Project and its files, so one identity keeps
ownership coherent, and it is the shape per-Project Unix identities will need.

CI checks both identities now. Testing only the unprivileged one is how this
stayed broken.
