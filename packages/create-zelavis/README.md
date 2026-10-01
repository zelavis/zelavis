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
`--instance <name>`, `--port <port>`, `--allow-downgrade`, `--enable-agent`, `--help`, `--version`. A non-interactive
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

The receipt identifies source `package`, entry `create`, version, mode and the
selected instance and port. Re-running repairs/upgrades the same layout. Installer locks
serialize maintenance; live data and instance port conflicts cannot be forced.
Foreign PATH commands are checked using the invoking user's PATH, passed only as
diagnostic data; privileged command execution still uses a fixed trusted PATH.
Stop a user-run Platform before maintenance. A matching systemd Platform can be
stopped and restarted during repair/upgrade. Named system instances share immutable releases and have their own data, config,
account, units, token, System Store and release selection.

Run `zelavis doctor --user --json` for user mode or `sudo zelavis doctor --json`
for system mode. It inspects installation health without changing configuration
or taking locks and returns status 1 for errors.

Inspect removal before confirming it (add `sudo` for system mode):

```bash
zelavis uninstall --all --dry-run
zelavis uninstall --all --confirm DELETE-ALL-ZELAVIS-DATA
```

User removal deletes its prefix, data and `.platform.lock`/`.platform-owner.json`,
private configuration/token, `.install.lock`, receipt and
owned command link, while retaining system packages, units and APT state.
Embedding remains `npm install zelavis` in an application; it is a library use,
not the create command.

See [Installation](https://zelavis.com/docs/getting-started/installation).


To install a named Linux/systemd instance:

```bash
npm create zelavis@latest -- --system --instance preview --port 3100 --dry-run
npm create zelavis@latest -- --system --instance preview --port 3100 --yes
sudo zelavis doctor --instance preview --json
sudo zelavis uninstall --instance preview --all --dry-run
sudo zelavis uninstall --instance preview --all --confirm DELETE-ALL-ZELAVIS-DATA
```

Names use at most 24 lowercase letters, digits and hyphens, starting with a
letter. A new named instance requires a distinct port (1024–65535). User mode
supports only default. `preview` owns `/var/lib/zelavis-preview`,
`/etc/zelavis-preview`, the `zelavis-preview` account, `zelavis@preview.service`
and the opt-in `zelavis-agent@preview.service`. Its `current`, receipt and public
`runtime.json` live under `/opt/zelavis/instances/preview`. Only default may own
host Edge, enforced by the persistent Edge record and kernel reservation;
secondary instances run with Edge off. Use explicit `--url` for their setup/API.
Removing one instance retains shared releases, management command/current,
unit templates and package/APT state until the last instance is removed.
Removal of default releases its Edge record/lock. No Project transfer is added.
