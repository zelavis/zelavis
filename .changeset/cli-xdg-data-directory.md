---
"zelavis": patch
---

Stop the CLI defaulting its Platform data directory to the current working
directory.

`zelavis serve` and `zelavis agent` resolved their data directory to
`.zelavis` relative to wherever the command was typed, so running the same
installation from two directories served two unrelated Platforms — different
owners, different Tenants, different databases — with nothing on screen saying
so. `cd` was effectively part of the address.

The default is now the user's data directory: `$XDG_DATA_HOME/zelavis` when
that variable names an absolute path, otherwise `~/.local/share/zelavis`. A
relative `$XDG_DATA_HOME` is ignored, as the specification requires. The full
chain is `--data-dir`, then `ZELAVIS_DATA_DIR`, then that default.

Packaged installations are unaffected: their systemd units set
`ZELAVIS_DATA_DIR=/var/lib/zelavis`, which is resolved ahead of the default, so
`.deb` and archive installs keep the FHS location a system service belongs in.
What changes is the npm path, where no installer has chosen a location.

The embedded adapters are deliberately unchanged. `nodeAdapter`/`bunAdapter`
still default to `.zelavis` relative to the application, because two
applications embedding Zelavis on one machine must not silently share one
global directory. A relative `.zelavis` also remains correct for Project-scoped
state stored inside a Project's own directory.
