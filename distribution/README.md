# Zelavis Distribution

This directory owns operating-system delivery for the Zelavis Platform OS. It
does not contain another runtime implementation. Every format is built from the
published `zelavis` package and the same staged release tree.

## Release layout

`pnpm distribution:stage` builds `packages/zelavis`, creates a production
deployment under `distribution/.tmp/stage/platform`, and adds:

- the exact official Project recipe catalog and dashboard assets shipped by `zelavis`
- production package dependencies, including native modules for the target CPU
- a private, checksum-verified Node runtime pinned by `release.json`
- on Linux, a release-pinned, checksum-verified Traefik binary plus the
  hardened `zelavis-traefik.service` Edge adapter
- the `zelavis` launcher and systemd service
- the archive installer, complete-uninstall program, and release manifest

The Debian package also declares Nginx, PHP-FPM and the WordPress PHP
extensions, MariaDB server/client core binaries, `tar`, and `util-linux` (installer `flock`) as dependencies. The
core MariaDB packages avoid provisioning a machine-wide database instance. This
gives native WordPress Projects their required host stack without Docker. Each
Project runs its own service instances and owns its own configuration, sockets,
ports, logs, site files, credentials, and database data.

The private Node runtime lives under `/opt/zelavis/current/runtime/node` after
installation. It does not replace `/usr/bin/node` and cannot conflict with Node
versions used by other applications.

Traefik lives under `/opt/zelavis/current/edge/traefik`; its systemd unit can
listen on ports 80 and 443 through a narrow capability boundary. The unit is
installed but disabled, and its watched generated-route directory starts empty,
so installation alone claims no ports and exposes no hostname. Zelavis Edge
must stage, probe, and activate a canonical publication before enabling it. The static adapter file is a dpkg conffile at
`/etc/zelavis/edge/traefik/traefik.yml`; generated output lives under
`/var/lib/zelavis/edge/traefik`.

Fresh Debian and systemd archive installations generate a 32-byte first-owner
bootstrap token in root-readable `/etc/zelavis/zelavis.env`. The installer
prints it once for the browser or `zelavis setup` wizard. Upgrades preserve an
existing environment file and never rotate the token. The durable bootstrap
claim closes after the first owner is created; complete uninstall removes this
installer-owned configuration with the rest of `/etc/zelavis`.

## Build commands

```bash
pnpm distribution:stage
pnpm distribution:archives
pnpm distribution:deb
pnpm distribution:checksums
pnpm distribution:build
```

The staging and archive commands support macOS and Linux on `x64` and `arm64`.
Build each release on the same OS and architecture it targets so native modules
are correct. Debian packages require Linux and `dpkg-deb`.

The `Distribution artifacts` GitHub workflow performs those target-native builds
for Linux and macOS on both x64 and ARM64. It uploads unsigned release artifacts;
APT repository signing remains a separate protected release-host step.

Generated files stay in `distribution/.tmp`, `distribution/.cache`, and
`distribution/artifacts`; none are committed.

## Host operation signing and trust

`zelavis.host-report` v1 is the first shipped operation. While
`operationTrust.keys` is empty, staging omits operations with a warning instead
of failing, because nothing could verify them; once a key is listed there, a
build without the signing key fails (tag builds) or omits them (manual builds).

Host operations the Agent may run ship under `operations/<id>/<version>/` in the
release tree, each with a release-signed `manifest.json` (Ed25519). Sources live
in `distribution/operations/`; `pnpm distribution:stage` signs them with
`ZELAVIS_OPERATION_SIGNING_KEY` (base64 PKCS8) and
`ZELAVIS_OPERATION_SIGNING_KEY_ID`, and fails if any signature would not verify
against `release.json` `operationTrust`. Without a key, sources fail the build
unless `ZELAVIS_SKIP_UNSIGNED_OPERATIONS=1`, which omits them. Tag builds in CI
never skip.

The trust store is installed root-owned at `/etc/zelavis/operation-trust.json`
(a dpkg conffile; the archive installer never overwrites an existing one).

Key lifecycle, on the release host only:

1. Create a key outside the repository:
   `node distribution/scripts/generate-operation-signing-key.mjs release-2027 /secure/release-2027.key 400`.
   Add the printed entry to `release.json` `operationTrust.keys` and store the
   private key as the `ZELAVIS_OPERATION_SIGNING_KEY` CI secret with its id.
2. Rotate before `notAfter`: add the next key (overlapping window), switch the
   CI secret, release. Manifests signed inside an old key's window keep
   verifying after it closes, so installed releases are unaffected.
3. Revoke a compromised key: add its id to `operationTrust.revokedKeyIds` and
   release. Every manifest it signed stops verifying, including installed ones,
   once operators receive the updated trust store; re-sign affected operations
   with a current key in the same release. Operators on archive installs update
   `/etc/zelavis/operation-trust.json` themselves.

## Running Projects and host operations through the Agent

`zelavis-agent.service` is installed but not enabled. It runs `zelavis agent` as
`zelavis` with `Delegate=yes`, installed signed operations, root-owned trust
enforcement, and cgroup v2 containment (256 PIDs, 512 MiB per operation). To
opt in:

```bash
sudo systemctl enable --now zelavis-agent.service
sudo systemctl edit zelavis.service   # add: [Service] Environment=ZELAVIS_AGENT_ENDPOINT=/var/lib/zelavis/agent
sudo systemctl restart zelavis.service
```

The Platform creates its Agent authority key under
`/var/lib/zelavis/system/agent-authority/` on first start with
`ZELAVIS_AGENT_ENDPOINT`; the Agent reads the public `platform-authority.json`
there and refuses every operation request until it exists. Once both run,
`zelavis host-operations catalog` lists what the caller may request.

The Agent refuses to start rather than falling back if the host lacks cgroup v2,
`cgroup.kill` (Linux 5.14+) or delegation. This path is not yet qualified on a
production Linux host.

## APT repository

After collecting the Linux `amd64` and `arm64` `.deb` files in
`distribution/artifacts`, build a signed repository on a Debian-family release
host:

```bash
export ZELAVIS_GPG_KEY_ID=<release-signing-key>
pnpm distribution:apt
pnpm distribution:repository-package
```

Publish `distribution/artifacts/apt` at `https://apt.zelavis.com`. The optional
`zelavis-repository_*_all.deb` installs only the signed source and keyring; the
subsequent `apt install zelavis` installs the Platform.

The release host must provide `dpkg-scanpackages`, `apt-ftparchive`, `dpkg-deb`,
`gpg`, and `gzip`. Release signing keys and publishing credentials never belong
in this repository.

## Public installation routes

- Quick install: `curl` installer chooses APT on Debian/Ubuntu and an archive on
  other supported Unix hosts.
- APT: install `zelavis-repository`, then `apt install zelavis`.
- Direct Debian package: `apt install ./zelavis_<version>_<arch>.deb`.
- Manual upload: extract `.tar.gz` or `.zip`, then run its `install.sh`.
- npm/pnpm/Bun create: install the matching prebuilt release through the same
  TypeScript command, in system or user mode.

## Host-local installation plan

The archive's `install.sh` and Debian `postinst` invoke the packaged
`zelavis install --from-release <absolute-release-path>` command using the
release's private Node. The runtime-neutral planner describes ordered steps with their idempotence; the Node host adapter executes those same steps. Unit files,
Traefik configuration and operation trust are read from `share/` in that release,
not embedded again in TypeScript. Runtime pins remain in `release.json`; staging and package acquisition share
`distribution/scripts/runtime-assets.mjs`, shipped as a generated Platform asset.

```bash
sudo ./install.sh --dry-run
sudo ./install.sh
```

Native Platform units bind to `127.0.0.1:3000` by default. Connect from a local
machine with `ssh -N -L 3000:127.0.0.1:3000 <user>@<server>` and open
`http://127.0.0.1:3000/zelavis`. An explicit `./install.sh --public` writes a unit
binding to `0.0.0.0`; rerunning without it restores the private bind. Agent opt-in
is still `ZELAVIS_ENABLE_AGENT=1`; Traefik remains disabled until Edge activates
routes. Releases stay in `releases/<version>` with a `current` link, including
Debian packages. Older versions are refused unless `--allow-downgrade` is given;
previous archive releases are kept.

Install and complete uninstall are host-local maintenance operations and have
no HTTP/dashboard route. Named system instances use explicit `--instance` and `--port`.
The quick installer's APT repository selection remains a bootstrap concern in
this phase; both APT postinst and its archive branch delegate host setup to the
same TypeScript command.


## Named system instances

With no `--instance`, every entry installs or repairs `default`. To create a
second Linux/systemd instance, choose a name and a distinct port:

```bash
sudo zelavis install --from-release /absolute/path/to/release --instance preview --port 3100 --dry-run
sudo zelavis install --from-release /absolute/path/to/release --instance preview --port 3100
# Or: npm create zelavis@latest -- --system --instance preview --port 3100 --yes
sudo zelavis doctor --instance preview --json
```

Names start with a lowercase letter and contain at most 24 lowercase letters,
digits or hyphens. Named instances require system mode; `--user` has only the
default instance. A new named instance requires an explicit port from 1024 to
65535. A port recorded by another instance is reserved even while it is stopped.
Rerunning a named install retains its port unless `--port` changes it.

| Resource | Default | Named `preview` |
|---|---|---|
| Data and System Store | `/var/lib/zelavis` | `/var/lib/zelavis-preview` |
| Config, trust and token | `/etc/zelavis` | `/etc/zelavis-preview` |
| User/group | `zelavis` | `zelavis-preview` |
| Platform unit | `zelavis.service` | `zelavis@preview.service` |
| Agent unit (opt-in) | `zelavis-agent.service` | `zelavis-agent@preview.service` |
| Release selection | `/opt/zelavis/current` | `/opt/zelavis/instances/preview/current` |
| Receipt | `/opt/zelavis/installation.json` | `/opt/zelavis/instances/preview/installation.json` |

The immutable `/opt/zelavis/releases/<version>` tree and management command are
shared. Debian packages own the incoming `/opt/zelavis/package` payload;
postinst calls the same installer to copy it into the release tree. dpkg never
owns the persistent release folders or their `current` links, so package
upgrades cannot delete a version selected by another instance. Each instance
selects its own release, so upgrading `preview` leaves
default and other named instances on their selected versions. If a named
instance is installed first, `/opt/zelavis/current` selects the initial management
CLI without creating a default Platform. `zelavis serve --instance preview`
reads that instance's secret-free `runtime.json` descriptor and executes its
selected release's private Node. Systemd uses the release-shipped templates
`zelavis@.service` and `zelavis-agent@.service`. Prefer systemd for system instances.

Only `default` may own host Edge. The installer serializes its persistent
`/opt/zelavis/edge-owner.json` claim with the prefix installer lock. The default
Platform holds the kernel reservation in `/opt/zelavis/.edge-owner.lock`; a live
reservation refuses another claimant, and process death releases the lock.
The service can reserve the existing lock inode but cannot rewrite its
root-owned ownership record. Installation still leaves Traefik disabled and
claims no public ports. Secondary instances run with Edge off and receive
traffic through the primary's Edge or an operator-managed external proxy.
Configure those routes explicitly; installation does not publish them.

Endpoint-backed commands select the secondary Platform with its URL, for
example `zelavis setup --url http://127.0.0.1:3100/zelavis`.
`--instance` selects host-local install, serve, doctor and complete removal;
it never selects a remote wipe target. Moving a Project between instances is
separate from installation; this change provides no Project export/import.

Inspect and remove just the selected instance:

```bash
sudo zelavis uninstall --instance preview --all --dry-run
sudo zelavis uninstall --instance preview --all --confirm DELETE-ALL-ZELAVIS-DATA
```

Removal stops only its own units and deletes its data, configuration/token,
installer-owned account, receipt, descriptor and release link. Removing default
also releases its Edge record/lock. While any other instance receipt remains,
the shared releases, incoming Debian payload, management `current`, command
links, unit templates, APT source/key and Debian package records are retained. Removing the last instance
removes that shared inventory too. `--all` means all data of the selected
instance, including its Projects; it does not remove every instance on the host.
The instance directories, incoming Debian payload, descriptors, template units
and Edge ownership files are covered by the destructive uninstall inventory and tests.

## Package acquisition and user mode

`zelavis install --from package --version <exact-version>` uses npm metadata to
identify the release and verifies its prebuilt archive against the release's
`SHA256SUMS`. The production dependencies, private pinned Node and templates
are the ones staging built; installation needs no native compilation. The
archive must exist for that exact version and OS/CPU. Published older alpha
assets do not satisfy new create builds; publish matching archives and checksums
alongside the packages. Installation never substitutes an older release.

`npm|pnpm|bun create zelavis` is a machine installer with no folder argument.
It prints the layout and exact command before running. Linux defaults to system
mode with root/sudo; macOS and Linux without sudo default to user mode. The
privileged bootstrap is literal shell code, not a path in the user's package
cache, and fetches/verifies its own release before running its private Node.
The one authored bootstrap is `installers/package-bootstrap.sh`.

User mode (`--user`) keeps releases, `data/`, `config/` and `installation.json`
under `~/.local/share/zelavis` and links `~/.local/bin/zelavis`. Configuration is
private (0700 directory, 0600 environment/receipt). The launcher reads the token
and data location and always requires the private Node; it never falls back to
host Node. Run `zelavis serve` yourself. No systemd, Agent or Edge is enabled.

## Ownership guards and doctor

Every install/removal takes the prefix's exclusive `.install.lock` (`flock` on
Linux; a SQLite kernel reservation on macOS). Linux needs `util-linux`.
Process death releases the reservation; no stale PID-based takeover is used.
The current receipt records mode, source (`release|package`), instance
(default or the selected name), port, Edge ownership, entry (`archive|deb|create|cli`), version, paths and account ownership.
Old pre-release receipt shapes are refused; no layout migration is performed.

Preflight rejects another recorded system/user installation, a different service
layout, foreign PATH commands, live data owners and an occupied or reserved instance port. `--force`
only permits deliberate command replacement; it cannot bypass data or ports.
Create forwards the invoking PATH for inspection, while the privileged bootstrap
continues executing commands through a fixed trusted PATH. Named instances share the prefix and releases, with their own data/config/port.
Only default may hold the host Edge reservation; installation claims no ports 80/443.

Node and Bun Platforms reserve `<data>/.platform.lock` before opening their
System Store and record PID/start/session metadata in `.platform-owner.json`.
`Zelavis.close()` releases ownership after runtime resources close; failed initial
construction releases it too. Installer maintenance uses this same guard. For
repair/upgrade, the installer can stop a matching owned systemd Platform, reserve
data, then hand it back before service startup. Stop user-run Platforms yourself.
This is a restart upgrade; blue/green updates remain planned.

```bash
sudo zelavis doctor --json     # system; receipt is root-readable
zelavis doctor --user --json   # user mode
```

Doctor inspects PATH, receipt/current/private Node, data owner, services, ports
and Agent cgroup v2/delegation. It changes no files or configuration, acquires no
locks, downloads nothing and never reads the bootstrap environment. Errors
return exit status 1; warnings include unqualified Agent containment. A feature
probe is not a real-server conformance result. KVM is not checked without a
configured Firecracker backend.

## Complete native uninstall

Every staged release carries a thin `share/uninstall.sh` entry, and the packaged
CLI executes the same TypeScript removal plan through the Node host adapter. Operators can inspect the owned inventory and
then remove the complete native installation:

```bash
sudo zelavis uninstall --all --dry-run
sudo zelavis uninstall --all --confirm DELETE-ALL-ZELAVIS-DATA
```

The native installer records customized data and command locations in an
owner-only installation receipt under the installation prefix, so the later
uninstall does not depend on recreating the original shell environment.

The removal inventory includes the Platform, Agent, and Zelavis-owned Traefik
units and files, Debian package
records when present, recorded command links and the default archive/Debian links
when they still point into this installation, the complete release tree, Platform and
Project data, `/etc/zelavis`, the Zelavis APT source/key, and the dedicated
system account when its properties prove it is installer-owned. Removing the last instance
removes the prefix, including `.install.lock`, receipts, public runtime descriptors,
instance directories, and the Edge ownership record/kernel lock; removing data includes
`.platform.lock` and `.platform-owner.json`. These files are retained during
ordinary runs so concurrent processes cannot lock different inodes. It deliberately
retains shared host dependencies, journal history, external archives/backups,
and operator networking/TLS configuration.

User-mode removal uses the same confirmation without sudo. Its inventory is the
user prefix (all releases, data, configuration/token and receipt) and its owned
command link. It performs no systemd, APT, package or account maintenance. Stop
the user process before removal. Isolated destructive tests cover both modes.

Any release change that adds installer-owned state must update the uninstall
inventory, its isolated destructive-path test, and the public installation
guide in the same change. A current installer receipt authorizes the shared removal
inventory, including package/create installs. Plain npm/source copies without a
receipt use their original package manager or development workflow.

Archive and npm installations can provision the native WordPress dependencies
through APT or Homebrew on first use when Zelavis has package-install authority.
An unprivileged installation must have those packages installed by the host
operator before creating its first WordPress Project.

The generic quick-installer archive URLs are stable aliases such as
`https://downloads.zelavis.com/latest/zelavis-linux-x64.tar.gz`. Release
publishing must point those aliases at the versioned artifacts generated here
and publish the raw SHA-256 digest beside each alias as `<archive>.sha256`.
