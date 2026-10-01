# create-zelavis

Installs Zelavis on this machine through `zelavis install`. It takes no folder
argument and does not scaffold a project.

```bash
npm create zelavis@latest -- --dry-run
npm create zelavis@latest -- --yes
# pnpm create zelavis --yes
# bun create zelavis --yes
```

Linux defaults to system mode when root or sudo is available: `/opt/zelavis`
contains versioned releases, `/var/lib/zelavis` contains data, and `/etc/zelavis`
contains configuration. The Platform starts through systemd using the release's
private Node. The default listener is `127.0.0.1:3000`; use an SSH tunnel for a
remote host. Agent enablement is opt-in (`--enable-agent`).

macOS and Linux without sudo default to user mode. Select it explicitly with:

```bash
npm create zelavis@latest -- --user --yes
# Add ~/.local/bin to PATH, then:
zelavis serve
```

User mode keeps releases, `data/`, `config/` and the receipt below
`~/.local/share/zelavis`, with a command link at `~/.local/bin/zelavis`. It does
not register systemd, Agent or Edge. The launcher loads the private token and
data location from `config/zelavis.env` regardless of the working directory.

Options: `--user`, `--system`, `-y/--yes`, `--dry-run`, `--public`, `--force`,
`--allow-downgrade`, `--enable-agent`, `--help`, `--version`. A non-interactive
installation requires `--yes`. Dry-run prints the layout and exact bootstrap
command without downloads, elevation or changes.

Each build stamps the exact Platform version. npm supplies that version's
metadata; the matching prebuilt GitHub release supplies the production package,
native dependencies, private Node and release templates. SHA-256 is verified
before extraction or execution. Missing archives fail explicitly; no older
release is substituted. Published prereleases must include these assets for
this path to work. Native dependency compilation is done at release build time,
not on the installing host.

For system mode, sudo runs literal bootstrap code that downloads and verifies
its own release into a private root-owned temporary directory. It never runs a
file from the invoking user's package cache as root. The bootstrap source is
maintained once in `distribution/installers/package-bootstrap.sh` and copied
into the package at build time.

Inspect removal before confirming it (add `sudo` for system mode):

```bash
zelavis uninstall --all --dry-run
zelavis uninstall --all --confirm DELETE-ALL-ZELAVIS-DATA
```

User removal deletes its prefix, data, private configuration/token, receipt and
owned command link, while retaining system packages, units and APT state.
Embedding remains `npm install zelavis` in an application; it is a library use,
not the create command.

See [Installation](https://zelavis.com/docs/getting-started/installation).
