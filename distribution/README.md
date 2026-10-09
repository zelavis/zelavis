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
   off for the whole tree (it may run as root and the dependencies are not ours;
   nothing needs them, because every dependency is plain JavaScript and the
   Platform uses Node's built-in `node:sqlite`),
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
- production package dependencies (plain JavaScript; no native modules)
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
enabled on default system installations. Zelavis Edge publishes a canonical
HTTP fallback to the persistent management listener and starts the proxy, so
`http://<server-ip>/zelavis/` works without a hostname. Ports owned by another
service are refused. Hostname-specific routes take precedence over the fallback. The static adapter file is a dpkg conffile at
`/etc/zelavis/edge/traefik/traefik.yml`; generated output lives under
`/var/lib/zelavis/edge/traefik`.

Fresh systemd installations generate a 32-byte first-owner bootstrap token in
root-readable `/etc/zelavis/zelavis.env`. The installer prints it once for the
browser or `zelavis setup` wizard. Upgrades preserve an existing environment file
and never rotate the token. The durable bootstrap claim closes after the first
owner is created; complete uninstall removes this installer-owned configuration
with the rest of `/etc/zelavis`.

## Updating a running installation

Packaged Node installations use a persistent host for the dashboard and Project
preview ports. The updater prepares the new immutable release while the selected
engine serves traffic, then uses `install --live` to drain accepted requests,
transfer exclusive store ownership and probe the candidate. Root acknowledges
the current link, private receipt and public version descriptor before admission
resumes. Failed candidates are fenced before rollback. The host and separate
Project Agent remain running; installed App engine pins remain unchanged.

System installations have a dashboard socket unit and an enabled update path,
which starts the root update helper when the Platform writes a request. A named
instance has its own units and selection. User installations invoke the same
live handover under their own user. The request carries no version: the helper
selects a newer release on the current channel from npm. `doctor` checks the
installation inventory and update watcher.

Installations without this host/protocol need one full local installer run with
a restart. Unsupported live handovers are refused; no compatibility restart
fallback is retained. Public older-version controls and multi-host handover remain
planned. See [the update architecture](../website/src/content/docs/architecture/updates.md).

## Releasing

A release is the npm package. `pnpm release:publish:alpha` (or `:latest`) runs root
verification and docs checks, publishes Changesets-versioned packages and confirms the exact
version is on npm. That is all: there is no workflow, tag push, artifact, signing key
or secret. npm authentication is the release owner's. Tracked version/source changes
must be committed before publishing. After publishing, run the installer against the
new version on a real host (`sudo zelavis doctor`).

With the owner's manual npm login, the publisher runs recursive `pnpm publish`
directly so browser verification can use the terminal. Versions already on npm
are skipped; the requested `alpha` or `latest` tag is explicit for every package.

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
OS and architecture you target. Generated files stay
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

System installations enable `zelavis-agent.service` (or the named-instance
unit) as a separately supervised unprivileged Project process Agent. The
installer configures `ZELAVIS_AGENT_ENDPOINT`; this custody lets running Projects
survive a Platform engine handover. The Agent delegates cgroups and refuses a
host without required cgroup v2 containment rather than silently falling back.
The packaged Debian/systemd qualification exercises this path, including
WordPress daemon adoption, Platform handover and rollback.

The Platform creates its Agent authority key under
`/var/lib/zelavis/system/agent-authority/`; the Agent reads only its public
`platform-authority.json`. Root provisioning uses the separate operation-only
Agent below.

`zelavis agent --operations-only` accepts only installed-operation catalog,
submission and status messages. It requires `--operations-root` and
`--platform-authority`, rejects Project listener/placement options, and opens
neither the Project process registry nor the Platform System Store. This is a
separately privileged provisioning endpoint. System installs and updates also enable
`zelavis-host-agent.service` (or `zelavis-host-agent@<instance>.service`), running
only installed signed operations as root with systemd-delegated cgroup containment.
Its root-owned `<instance-prefix>/host-agent` directory and endpoint are limited to
the Platform service group. Shared package policy/locking state lives at
`<prefix>/host-packages` (root, 0700). `ZELAVIS_HOST_OPERATIONS_ENDPOINT` selects this
broker separately from the unprivileged Project process Agent.

The fixed `zelavis.packages-install` operation provisions the fixed sets `wordpress-stack`,
`php-stack` and `mariadb-server` only after explicit `server.packages.install` authorization. The base installation
adds no Nginx, PHP or MariaDB. Package-triggered starts are suppressed for the APT
process tree; existing host units and policy are preserved. The persistent
`/usr/sbin/policy-rc.d` wrapper delegates normal calls to
`policy-rc.d.zelavis-original`; `policy-rc.d.zelavis-owner` and the root package
inventory prove ownership for uninstall; owned `.new` atomic-write files are included. Cancellation leaves normal host policy
active. The last system uninstall restores only an owned wrapper, retains
operator modifications/backups, and retains shared packages.

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

A default system installation serves `http://<server-ip>/zelavis/` through Traefik.
The management listener binds `127.0.0.1:3000`; `--public` explicitly exposes
that listener. User and named instances have no host Edge and remain local by
default. The first-owner token gates the claim; HTTPS needs hostname/certificate
configuration. The Project Agent is enabled for every system installation. Releases
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
| Project process Agent unit | `zelavis-agent.service` | `zelavis-agent@preview.service` |
| Host operation Agent | `zelavis-host-agent.service` | `zelavis-host-agent@preview.service` |
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
root-owned ownership record. The default installation enables Traefik and owns ports 80 and 443. Secondary instances run with Edge off and receive
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
Only default may hold the host Edge reservation; its Traefik unit owns ports 80/443.

Node and Bun Platforms reserve `<data>/.platform.lock` before opening their
System Store and record PID/start/session metadata in `.platform-owner.json`.
`Zelavis.close()` releases ownership after runtime resources close; failed initial
construction releases it too. Installer maintenance uses this same guard. For
repair/upgrade, the installer can stop a matching owned systemd Platform, reserve
data, then hand it back before service startup. Stop user-run Platforms yourself.
Full installation repair restarts the Platform. Qualified dashboard updates use
the live host handover above and do not use this maintenance path.

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

The removal inventory includes the Platform, Project process Agent, restricted root host Agent, and Zelavis-owned Traefik
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
