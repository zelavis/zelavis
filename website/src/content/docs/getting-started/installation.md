---
title: Installation
description: Install the long-running Zelavis Platform OS with the shell installer or npm create.
---

Zelavis is a long-running Platform OS. It is installed on a server or local
machine; it is not deployed as an ephemeral serverless function.

Both methods do the same thing and end in the same installation: the shell
installer needs nothing but `curl`; `npm create` is for people who already have a
JavaScript toolchain. The [Install page](/install) has copy-ready commands.

## Quick install

The shell installer detects your operating system and CPU (`x86_64`/`amd64` and
`arm64`) and runs unattended:

```bash
# Linux server (root, systemd). Current prerelease channel; an exact version can
# replace --channel alpha.
curl -fsSL https://zelavis.com/install.sh | sudo sh -s -- --channel alpha

# Unprivileged installation (also the default on macOS).
curl -fsSL https://zelavis.com/install.sh | sh -s -- --channel alpha --user
```

It trusts exactly two https origins and nothing else:

1. **nodejs.org** supplies the private Node the Platform runs on. The Node version
   is pinned by the release and the archive is checked against nodejs.org's
   published SHA-256 before it is unpacked. It never touches the Node already on
   your machine.
2. **npm** supplies the exact `zelavis` package. npm verifies it against the
   registry digest. Dependency install scripts stay off for the whole tree (this may
   run as root and the dependencies are not Zelavis's). Nothing needs them: every
   dependency is plain JavaScript and the Platform uses Node's built-in SQLite, so
   there is no compiler or native build on your server.

There are no release signatures, keys or second download host to manage. Read the
script first at [zelavis.com/install.sh](https://zelavis.com/install.sh): it is one
short, commented file, and the same file `npm create zelavis` runs.

Place `--version <exact-version>` or `--channel alpha|latest` before installer
flags. A channel is resolved once from npm's dist-tags and a missing version fails
explicitly. The default channel is `latest`; prerelease installation uses `alpha`
deliberately. The installed CLI then runs `zelavis install --from-npm` with all
remaining flags, including `--instance`, `--port`, `--public` and `--dry-run`
(a dry run still downloads into a temporary directory, and changes nothing else).

The runtime does not depend on the host's Node. On a default system installation Traefik serves
`http://<server-ip>/zelavis/`; the management listener stays on loopback unless
explicitly exposed with `--public`. The installer prints the URL to open; the one-time
first-owner token decides who may claim the account. Project process supervision
runs through a separately supervised Agent. System installations
also enable the restricted root host-operation Agent for signed package and Edge
operations, with cgroup v2 containment; the Platform and Project processes remain
unprivileged. Traefik is enabled and started with a canonical domain-free HTTP route.
Hostname-based HTTPS needs certificate configuration; automated ACME/cutover
reconciliation remains pending.

## Updating

Open the dashboard: when a newer version exists, a banner offers **Update now**, and
Settings has an Updates card with the same button. Or from a terminal on the server:

```bash
zelavis update status
zelavis update apply --wait
```

The server downloads the new version beside the current one while the old keeps
serving, then switches over and checks that it answers; if it does not, it goes back
to the previous version by itself. Your data, token and configuration are untouched.
On a Linux server, systemd holds the dashboard port during the switch, so visitors see
a short pause (under half a second in tests) and no failed requests. How it works, and
why the Platform only asks while a root unit does the work, is in
[Updating without downtime](../../architecture/updates/).

Packaged Node installations use the same live engine handover for system,
named-instance and user installations. The host keeps dashboard and preview
ports bound while requests drain, database ownership transfers, and the new
engine is qualified. Running Projects remain in separately supervised Agent
custody. Failed candidates are fenced before rollback.

An installation without the persistent host and versioned runtime inventory
needs one full installer run (Quick install) with a restart. Later dashboard
updates use live handover. `sudo zelavis doctor` checks the installation inventory,
held socket and dashboard update watcher. Named instances retain their own
release selection and never update another instance.

## Install with npm, pnpm or Bun create

The create command installs Zelavis on this machine. It takes no folder argument:

```bash
npm create zelavis@latest -- --dry-run
npm create zelavis@latest -- --yes
# pnpm create zelavis --yes
# bun create zelavis --yes
```

Linux defaults to system mode when root or sudo is available. Releases live in
`/opt/zelavis/releases/<version>` with a `current` link, data in `/var/lib/zelavis`,
and configuration in `/etc/zelavis`. The Platform starts through systemd. The
invoking Node or Bun runs only the create frontend; the installed Platform
always uses its checksum-verified private Node.

The frontend shows the layout and exact command before installation. When sudo
is needed, the privileged bootstrap downloads and verifies its own release into
a root-owned temporary directory. It never executes a file in the user's package
cache as root. Dry-run makes no downloads or changes. Non-interactive installs
require `--yes`.

Each create package selects an exact Platform version. It runs the same shell
bootstrap as the quick installer, so the trust chain is the same two origins:
nodejs.org for the private Node and npm for the package. A missing version fails
explicitly rather than selecting an older one.

### User mode

macOS and Linux without sudo default to user mode. Use it explicitly on a laptop
or for a local trial:

```bash
npm create zelavis@latest -- --user --yes
# Add ~/.local/bin to PATH, then start the Platform:
zelavis serve
```

The same versioned layout lives under `~/.local/share/zelavis`: `releases/`,
`current`, `data/`, `config/` and `installation.json`. The command is linked at
`~/.local/bin/zelavis`. Its launcher loads `config/zelavis.env` (0600), which
holds the one-time first-owner token and data location, from any working directory.
Open http://127.0.0.1:3000/zelavis and use the token printed at installation to
claim the first owner. Rerunning preserves it. User mode starts no systemd,
Agent or Edge, and offers no automatic login service yet.

Options: `--user`, `--system`, `--yes`, `--dry-run`, `--public`, `--force`,
`--allow-downgrade`. Services acquired by
the operator live in `<data>/services`; default services ship inside the Platform
and cannot be shadowed there. For embedding the runtime in an application,
use `npm install zelavis` as a library dependency.

## Debian package and APT (planned)

A `.deb` can be built from the same release tree (`pnpm distribution:stage` then
`pnpm distribution:deb` on a Linux host), but none is published, and there is no
APT repository: `apt.zelavis.com` does not exist yet. Both are planned, and the
[Install page](/install) says so. The supported Linux path today is the shell
installer. A package's `postinst` runs the same `zelavis install --from-release`,
so it will produce the same installation.

## One host-local native installation plan

The shell installer and the create bootstrap run `zelavis install --from-npm` with
the private Node they just fetched, on a tree assembled from the npm package's own
installation assets. A staged release tree (what a Debian package ships) is
installed with `zelavis install --from-release`. Both feed one TypeScript command
that computes an ordered plan with each step's idempotence; dry-run and execution
use that same inventory. It reads unit templates and Edge configuration from the
tree. It has no HTTP/dashboard route: installation is local host maintenance.

`--json` provides machine-readable output, `--force` deliberately replaces a foreign
command link, and `--allow-downgrade` permits an older release. Existing tokens and
Edge configuration are kept. Releases live in `/opt/zelavis/releases/<version>` with
`current` selecting the active one; previous releases are retained. Running the
installer again with a newer version is the upgrade, and the dashboard's Update button
uses [live engine handover](../../architecture/updates/) on qualified Node
installations. Candidate preparation holds no writable store; activation follows
exclusive ownership transfer and durable selection acknowledgement.


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
| Project process Agent | `zelavis-agent.service` | `zelavis-agent@preview.service` |
| Restricted host operation Agent | `zelavis-host-agent.service` | `zelavis-host-agent@preview.service` |
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
`zelavis@.service`, `zelavis-agent@.service`, and `zelavis-host-agent@.service`. Prefer systemd for system instances.

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

## Installing a worker

A worker is a machine that runs the Projects a Platform places on it. It has no
dashboard, no ingress, no database of its own and no update socket: it is the same
release, one dedicated `zelavis-worker` account, and one unit that runs the Agent.
A machine is **either a Platform or a worker**; each installer refuses the other's
machine.

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://zelavis.com/install.sh | sudo sh -s -- --role worker
```

It needs Linux, systemd and root, and refuses the Platform-only flags (`--user`,
`--instance`, `--port`, `--public`, `--live`) by name. Then enroll it into a Platform
(see [Node Enrollment](../../architecture/node-enrollment/)): issue a credential with
`zelavis nodes enroll-token <node-id>` on the Platform, and on the worker run, as its own
account, so the Agent's key is created and owned by the account that uses it:

```bash
sudo -u zelavis-worker /usr/local/bin/zelavis worker join --data-dir /var/lib/zelavis-worker \
  --platform-url https://panel.example.com --node-id worker-1 --enrollment-token <token>
```

The Agent starts by itself once the machine has joined (a systemd path unit waits for
the configuration `join` writes last), listens on port 8443, and the Platform must be
able to reach it. The enrollment credential is never part of an install plan or a dry
run. Running the installer again updates the worker: it selects the new release and
restarts a running Agent. A worker is **not** updated from the dashboard, and
`zelavis doctor` does not inspect workers yet.

`sudo zelavis uninstall --all --dry-run` and `--confirm DELETE-ALL-ZELAVIS-DATA` work on
a worker too, with its own inventory: its units, command links, `/var/lib/zelavis-worker`
(the Agent's key, certificate, trust keys and every Project run there), the `zelavis-worker`
user and group only when the receipt records that the installer created them, and
`/opt/zelavis`. The node's record on its Platform is not removed from there: run
`zelavis nodes remove <node-id>` on the Platform.

## Installation ownership and health

The current receipt records the source, entry point, version, paths and
selected instance and port. Without `--instance`, all installer entries repair or upgrade `default`.
A different recorded installation or service layout is refused. Foreign npm,
source or other commands on PATH are reported with removal/PATH guidance.
`--force` permits deliberate command replacement; it cannot bypass a live data
owner or another listener on the selected port. Default system installations require free public ports 80/443, or listeners already owned by their Traefik unit.

Install and complete removal use an exclusive `<prefix>/.install.lock` (`flock`
on Linux, supplied by `util-linux`). Node and Bun Platforms and installer
maintenance share `<data>/.platform.lock`, with PID/start/session metadata in
`.platform-owner.json`. Two Platforms cannot open the same default System Store.
Normal close and process death release ownership; the lock file remains for reuse.
Stop user-run Platforms before maintenance. A matching owned systemd Platform
can be stopped and restarted by the installer for full repair; this involves
downtime. Qualified dashboard updates use the persistent host handover instead. Old pre-release receipts/layouts are not migrated.

Inspect the installation locally:

```bash
sudo zelavis doctor --json    # system mode
zelavis doctor --user --json  # user mode; no sudo
```

Doctor reports PATH, receipt and selected release/private Node, data ownership,
service state, ports and Agent cgroup/delegation. It writes no files, takes no
locks, downloads nothing and never reads the bootstrap environment. An error
returns exit status 1. Agent host features do not prove production containment;
real-server qualification remains pending.

## Direct npm library and CLI use

`npm install zelavis` remains available for embedding. A deliberate global
npm CLI installation uses the operator's Node 24 and package-manager lifecycle;
it is separate from the host installation produced by create. For a machine
installation with a private Node, use the create workflow above.

`zelavis --version` reports which installation is answering. The shared installer
refuses a foreign command unless `--force` is given, and warns if another command
shadows it on PATH.

---

## First-Run Setup & Ownership Claim

A default system installation starts Traefik on public ports 80 and 443 and
prints `http://<server-ip>/zelavis/`. The management listener stays on
`127.0.0.1:3000` unless explicitly exposed with `--public`. A hostname is optional
for HTTP; HTTPS requires hostname and certificate configuration. Claim the owner
account and configure HTTPS in the setup wizard. Installation refuses ports
owned by another service. Named instances and user-mode installs have no host
Edge and stay on loopback by default. Live updates retain configured listeners.

A one-time **bootstrap token** is generated during installation and printed in
your terminal output (also saved in `/etc/zelavis/zelavis.env` with
strict `0600` permissions). In user mode, it is saved in
`~/.local/share/zelavis/config/zelavis.env`, and the operator starts `zelavis serve`.

You have two primary ways to access the graphical onboarding wizard, plus an
interactive terminal option:

### Option A: Direct Browser Access (the default on a server)

If your firewall permits inbound HTTP on port 80:

1. Open your browser and navigate directly to:
   ```text
   http://<your-server-ip>/zelavis/setup
   ```
2. Paste the **bootstrap token** from `/etc/zelavis/zelavis.env`.
3. Enter your administrator email and password to claim the **Owner** account.
4. The optional Platform hostname step follows the durable Owner claim. An apex
   (`example.com`) or subdomain (`panel.example.com`) is a valid hostname.
5. Choose **Configure later** to keep using the IP address,
   or configure an external TLS terminator separately. Automatic certificate
   issuance and hostname cutover still need production qualification;
   installation does not establish public HTTPS.

Hostname/TLS setup uses authenticated Edge operations after ownership is claimed.
A failure there does not undo the Owner account or reopen first-owner setup.

### Option B: SSH Port Forwarding to the private management listener

Use an SSH tunnel when a firewall blocks the port or you prefer not to expose it, including for a named or user-mode instance:

1. On your **local machine**, open an SSH tunnel using your preferred SSH authentication method:

   **Using an explicit SSH private key (recommended for cloud servers like Hetzner/AWS):**
   ```bash
   ssh -i ~/.ssh/id_ed25519 -L 3000:localhost:3000 root@<your-server-ip>
   ```
   *(Replace `~/.ssh/id_ed25519` with the path to your private key, such as `~/.ssh/id_rsa`).*

   **Using a non-root user (e.g. `ubuntu` or `debian`):**
   ```bash
   ssh -i ~/.ssh/id_ed25519 -L 3000:localhost:3000 ubuntu@<your-server-ip>
   ```

   **Using a non-standard SSH port (e.g. port 2222):**
   ```bash
   ssh -i ~/.ssh/id_ed25519 -p 2222 -L 3000:localhost:3000 root@<your-server-ip>
   ```

   **Using an SSH config host alias (`~/.ssh/config`):**
   ```bash
   # If ~/.ssh/config defines Host my-server:
   ssh -L 3000:localhost:3000 my-server
   ```

   *(Keep this terminal session open while you perform setup).*

2. Open your local web browser to:
   ```text
   http://localhost:3000/zelavis/setup
   ```
3. Enter the **bootstrap token** from `/etc/zelavis/zelavis.env` and configure your Owner credentials.
4. Configure the optional Platform hostname after the Owner claim, or choose
   **Configure later**. Keep the tunnel as the local recovery path until you have
   independently verified a working public HTTPS endpoint.

Managed DNS/ACME and traffic cutover reconciliation remain planned; the wizard
must not be treated as evidence that production certificates and routes are active.

### Option C: Interactive Terminal Setup (CLI)

If you are logged into the server over SSH and prefer completing setup directly in the
terminal without a web browser:

```bash
zelavis setup
```

The CLI wizard prompts for the bootstrap token and claims the first Owner
through the same bootstrap capability as the dashboard. Hostname/TLS setup is a
separate authenticated Edge operation; automatic production certificate issuance
and route activation remain pending qualification.

For unattended automation or cloud-init scripts, use the non-interactive equivalent:
```bash
zelavis bootstrap --email admin@example.com --password-stdin < my-password.txt
```

---

## Completely uninstall a packaged installation

To return a host to a clean state where the Zelavis installer can be run again
from scratch, inspect the scope first with a dry run:

```bash
sudo zelavis uninstall --all --dry-run
```

Then execute the complete removal with the confirmation phrase:

```bash
sudo zelavis uninstall --all --confirm DELETE-ALL-ZELAVIS-DATA
```

For the default instance, when it is the last installation on the host, this:

- Stops and disables the Platform, Project process Agent, restricted root host Agent, Traefik, socket and update units.
- Removes `/opt/zelavis`, including the receipt, `runtime.json`, `.install.lock`, instance directories and host Edge ownership files, recorded command links, and systemd unit files. The default `/usr/local/bin/zelavis` and `/usr/bin/zelavis` links are removed only when they point into this installation.
- Removes configuration, host operations, certificates, the instance's root Agent state and the final shared host-package inventory.
- Restores the recorded original `/usr/sbin/policy-rc.d`, or removes a wrapper created by Zelavis, only while its ownership and digest still match. Operator modifications and their original-policy backup are retained. Pending owned atomic-write files are included in this inventory.
- Completely deletes `/var/lib/zelavis`, including all project databases and runtimes, `.platform.lock`, `.platform-owner.json`, and the persistent runtime host’s custody, control socket, engine journal, kernel ownership files and development Agent state.
- Removes Debian package records when the installation came from a package.
- Removes the `zelavis` user/group only when the receipt records installer ownership and their current properties are safe.

Shared host packages, journal history, external archives/backups and
operator-managed proxy/firewall/DNS/TLS state are retained. Complete uninstall
has no remote HTTP/dashboard route. Package/create installs with a current
receipt use this inventory; plain npm/source copies without one use their
originating package manager or development lifecycle.

For a **user installation**, run those two uninstall commands without sudo.
Its inventory is the complete `~/.local/share/zelavis` prefix (including releases,
data and ownership lock/record, configuration/token, installer lock, receipt and runtime descriptor) and the owned `~/.local/bin/zelavis` link.
It does not touch systemd units, system commands or accounts.
Stop the user-run Platform before removing it.
