# Zelavis Distribution

This directory owns operating-system delivery for the Zelavis Platform OS. It
does not contain another runtime implementation. A release is the published
`zelavis` package on npm: nothing is built, signed, uploaded or hosted per
release. The installer assembles an installation from two https origins and
trusts nothing else: nodejs.org for the private Node (pinned by `release.json`,
checked against nodejs.org's published SHA-256) and npm for the exact package
(verified by npm against the registry digest).

## How a release is installed

`installers/install.sh` is the one authored bootstrap. The website serves it at
`https://zelavis.com/install.sh` byte for byte, and `create-zelavis` ships a
generated copy. It:

1. resolves an exact version from npm dist-tags (or takes `--version`),
2. downloads and verifies the pinned private Node,
3. runs that Node's own npm: `npm install zelavis@<version>` with install scripts
   off for the whole tree (it may run as root and the dependencies are not ours)
   and then `npm rebuild better-sqlite3`, the one native module,
4. moves the package into `platform/` beside `runtime/node` and runs
   `platform/dist/cli.js install --from-npm <tree>`.

`zelavis install --from-npm` completes the tree from the package's own
installation assets (`dist/installation-assets/`, generated at package build from
this directory): the launcher, systemd unit templates, `traefik.yml`, host
operations (plain manifests with their digests computed at build time), a manifest
and, on Linux, the pinned Traefik binary downloaded and checked against Traefik's
published checksums. Then the shared plan installs it. A staged release tree (what a
`.deb` ships) is installed with `zelavis install --from-release` through the same
plan. Runtime pins live in `release.json`; the Node pin in `install.sh` is kept in
step with it by a test.

## Release layout

A release tree (assembled at install time, or staged by `pnpm distribution:stage`)
contains:

- the exact official Project recipe catalog and dashboard assets shipped by `zelavis`
- production package dependencies, including the native module for the target CPU
- the private Node runtime pinned by `release.json`
- on Linux, a release-pinned Traefik binary plus the hardened
  `zelavis-traefik.service` Edge adapter
- the `zelavis` launcher and systemd units
- the complete-uninstall program and a release manifest

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

Fresh systemd installations generate a 32-byte first-owner bootstrap token in
root-readable `/etc/zelavis/zelavis.env`. The installer prints it once for the
browser or `zelavis setup` wizard. Upgrades preserve an existing environment file
and never rotate the token. The durable bootstrap claim closes after the first
owner is created; complete uninstall removes this installer-owned configuration
with the rest of `/etc/zelavis`.

## Releasing

A release is the npm package. `pnpm release:publish:alpha` (or `:latest`) runs root
verification and docs checks, publishes with Changesets and confirms the exact
version is on npm. That is all: there is no workflow, tag push, artifact, signing key
or secret. npm authentication is the release owner's. Tracked version/source changes
must be committed before publishing. After publishing, run the installer against the
new version on a real host (`sudo zelavis doctor`).

The website (`website/`) is deployed separately to Cloudflare Pages and serves
`/install.sh`, the Install page and `/allowlist.json`. Publish a refreshed allow-list
with `pnpm allowlist update` then `pnpm allowlist publish` and deploy the website.

## Build commands

```bash
pnpm distribution:stage   # a release tree in distribution/.tmp/stage, from the workspace
pnpm distribution:deb     # a .deb from that tree (Linux, needs dpkg-deb); not published
pnpm distribution:test
```

Staging builds the workspace and deploys its production dependencies; build on the
OS and architecture you target so the native module is correct. Generated files stay
in `distribution/.tmp`, `distribution/.cache` and `distribution/artifacts`; none are
committed.

## Host operations

`zelavis.host-report` v1 and the Edge operations ship under
`operations/<id>/<version>/{artifact, manifest.json}` in every release tree. Sources
live in `distribution/operations/` (`artifact` plus `operation.json` without a
digest). `stage-operations.mjs` computes each digest and writes a plain manifest. There
is no signature and no trust store: the operations tree is root-owned, and the Agent
refuses to load a manifest that is not a regular, non-group/world-writable file
owned by root (`--require-root-owned-operations`, set in the packaged units).
Authority to request an operation is the Platform's Ed25519 envelope
(`--platform-authority`), whose key is generated per installation and is not a
release secret.

## Running Projects and host operations through the Agent

`zelavis-agent.service` is installed but not enabled. It runs `zelavis agent` as
`zelavis` with `Delegate=yes`, installed operations, root-owned tree
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

## Debian package and APT (planned)

`pnpm distribution:deb` builds a `.deb` from a staged Linux tree. Its `postinst`
runs `zelavis install --from-release /opt/zelavis/package --installed-by deb` on the
package's private Node. No package is published and there is no APT repository.
Publishing either needs a signing story (a signed repository, or `trusted=yes`, which
is worse than not offering one) and is deliberately deferred.

## Host-local installation plan

The shell installer and create bootstrap run `zelavis install --from-npm <tree>`; a
Debian `postinst` runs `zelavis install --from-release <path>`. Both use the
release's private Node and the same runtime-neutral planner, which describes ordered
steps with their idempotence; the Node host adapter executes those same steps. Unit
files and Traefik configuration are read from `share/` in the tree, not embedded
again in TypeScript. Runtime pins remain in `release.json`; the staging script and
the installer share `distribution/scripts/runtime-assets.mjs`, shipped as a
generated Platform asset.

```bash
curl -fsSL https://zelavis.com/install.sh | sudo sh -s -- --channel alpha --dry-run
curl -fsSL https://zelavis.com/install.sh | sudo sh -s -- --channel alpha
```

(A dry run still downloads Node and the package into a temporary directory; it
changes nothing else.)

Native Platform units bind to `127.0.0.1:3000` by default. Connect from a local
machine with `ssh -N -L 3000:127.0.0.1:3000 <user>@<server>` and open
`http://127.0.0.1:3000/zelavis`. An explicit `--public` writes a unit binding to
`0.0.0.0`; rerunning without it restores the private bind. Agent opt-in is
`--enable-agent`; Traefik remains disabled until Edge activates routes. Releases
stay in `releases/<version>` with a `current` link. Older versions are refused
unless `--allow-downgrade` is given; previous releases are kept.

Install and complete uninstall are host-local maintenance operations and have
no HTTP/dashboard route. Named system instances use explicit `--instance` and `--port`.
The bootstrap performs only acquisition and delegates host setup to the same command.


## Named system instances

With no `--instance`, every entry installs or repairs `default`. To create a
second Linux/systemd instance, choose a name and a distinct port:

```bash
curl -fsSL https://zelavis.com/install.sh | sudo sh -s -- --channel alpha --instance preview --port 3100 --dry-run
curl -fsSL https://zelavis.com/install.sh | sudo sh -s -- --channel alpha --instance preview --port 3100
# Or: npm create zelavis@alpha -- --system --instance preview --port 3100 --yes
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
| Config and token | `/etc/zelavis` | `/etc/zelavis-preview` |
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
links, unit templates and Debian package records are retained. Removing the last instance
removes that shared inventory too. `--all` means all data of the selected
instance, including its Projects; it does not remove every instance on the host.
The instance directories, incoming Debian payload, descriptors, template units
and Edge ownership files are covered by the destructive uninstall inventory and tests.

## Package acquisition and user mode

`npm|pnpm|bun create zelavis` is a machine installer with no folder argument.
It prints the layout and exact command before running. Linux defaults to system
mode with root/sudo; macOS and Linux without sudo default to user mode. The
privileged bootstrap is literal shell code, not a path in the user's package
cache, and fetches its own Node and package before running its private Node. It is
the same `installers/install.sh` the website serves.

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
(default or the selected name), port, Edge ownership, entry (`script|deb|create|cli`), version, paths and account ownership.
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
records when present, recorded command links and the default shell-installer/Debian links
when they still point into this installation, the complete release tree, Platform and
Project data, `/etc/zelavis`, and the dedicated
system account when its properties prove it is installer-owned. Removing the last instance
removes the prefix, including `.install.lock`, receipts, public runtime descriptors,
instance directories, and the Edge ownership record/kernel lock; removing data includes
`.platform.lock` and `.platform-owner.json`. These files are retained during
ordinary runs so concurrent processes cannot lock different inodes. It deliberately
retains shared host dependencies, journal history, external archives/backups,
and operator networking/TLS configuration.

User-mode removal uses the same confirmation without sudo. Its inventory is the
user prefix (all releases, data, configuration/token and receipt) and its owned
command link. It performs no systemd, package or account maintenance. Stop
the user process before removal. Isolated destructive tests cover both modes.

Any release change that adds installer-owned state must update the uninstall
inventory, its isolated destructive-path test, and the public installation
guide in the same change. A current installer receipt authorizes the shared removal
inventory, including package/create installs. Plain npm/source copies without a
receipt use their original package manager or development workflow.

Installations can provision the native WordPress dependencies
through APT or Homebrew on first use when Zelavis has package-install authority.
An unprivileged installation must have those packages installed by the host
operator before creating its first WordPress Project.

## Public delivery

The website's static `/install.sh` endpoint and create ship the one authored
`installers/install.sh`; the website is a Cloudflare Pages project and its build is
the whole publication step. Create passes its stamped exact version as the first
argument; the public entry accepts a version or channel selector. No verification
logic, unit templates or runtime pins are copied into a second authored source.

```bash
# Alpha until a stable release exists; selection flags precede installer flags.
curl -fsSL https://zelavis.com/install.sh | sudo sh -s -- --channel alpha
# Repeatable exact release, or unprivileged laptop installation:
curl -fsSL https://zelavis.com/install.sh | sudo sh -s -- --version <exact-version> --instance preview --port 3100
curl -fsSL https://zelavis.com/install.sh | sh -s -- --channel alpha --user
```

The default channel is `latest`; `--channel alpha` is explicit. A channel resolves
once from npm dist-tags, then every request names that exact version. The bootstrap
never falls back to a different release. Installer flags are literal arguments;
macOS defaults to user mode. Linux system mode requires root and systemd.

Open work: qualify the Debian/Ubuntu/systemd lifecycle, Agent cgroup delegation and
Traefik download on a real host, and publish the first release that carries this
installer. An APT repository and a published `.deb` are deferred.
