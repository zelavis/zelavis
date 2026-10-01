---
title: Installation
description: Install the long-running Zelavis Platform OS with the quick installer, Debian package, archive, or npm.
---

Zelavis is a long-running Platform OS. It is installed on a server or local
machine; it is not deployed as an ephemeral serverless function.

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

Each create package selects an exact Platform version, checks npm metadata and
verifies the matching prebuilt GitHub release archive's SHA-256. Native dependencies
are built for that release target in advance. A matching archive must be
published; missing assets fail explicitly rather than selecting an older version.
Some published prereleases predate this installer and do not carry the required assets.

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
`--allow-downgrade`, `--enable-agent` (system mode only). Services acquired by
the operator live in `<data>/services`; default services ship inside the Platform
and cannot be shadowed there. For embedding the runtime in an application,
use `npm install zelavis` as a library dependency.

## Quick install

The quick installer automatically detects your operating system and CPU
architecture (`x86_64` / `amd64` and `arm64`). On production Linux servers
(such as Hetzner, AWS, DigitalOcean, or bare metal), it pulls the
verified standalone distribution bundle from the release registry, verifies its
SHA-256 integrity, unpacks the private Node 24 runtime, registers the `zelavis`
system user, and sets up systemd service units.

Zero build dependencies are required on your server: no `git`, `node`, `pnpm`,
or compilers are needed.

```bash
# Production server installation (enables Edge Agent & Traefik management)
curl -fsSL https://raw.githubusercontent.com/zelavis/zelavis/main/distribution/installers/install.sh | sudo ZELAVIS_ENABLE_AGENT=1 sh
```

Or via the canonical short URL:

```bash
curl -fsSL https://zelavis.com/install.sh | sudo ZELAVIS_ENABLE_AGENT=1 sh
```

The packaged installation contains an isolated, private pinned Node runtime. It
does not replace or interfere with the host's global Node installation. Setting
`ZELAVIS_ENABLE_AGENT=1` ensures the Zelavis Edge Agent service (`zelavis-agent.service`)
is enabled alongside the main Platform OS (`zelavis.service`), allowing automated
Let's Encrypt TLS certificate issuance and reverse-proxy cutovers via Traefik.

## Direct Debian / Ubuntu package (.deb)

If you prefer managing packages natively with `apt`, download the `.deb` release
matching your server CPU and install it:

```bash
# For x86_64 / amd64 servers (e.g. Hetzner CX22, standard cloud instances)
curl -fsSLO https://github.com/zelavis/zelavis/releases/download/v1.0.1-alpha.2/zelavis_1.0.1.alpha.2_amd64.deb
sudo apt install -y ./zelavis_1.0.1.alpha.2_amd64.deb

# For ARM64 servers (e.g. AWS Graviton, Ampere)
curl -fsSLO https://github.com/zelavis/zelavis/releases/download/v1.0.1-alpha.2/zelavis_1.0.1.alpha.2_arm64.deb
sudo apt install -y ./zelavis_1.0.1.alpha.2_arm64.deb
```

Installing through `apt install ./<package>.deb` rather than `dpkg` directly
allows the system package manager to verify dependencies and maintain package
database integrity.

## One host-local native installation plan

Archive installers, Debian `postinst` and the create bootstrap run `zelavis install --from-release`
with the staged release's private Node. The TypeScript command computes an
ordered plan with each step's idempotence; dry-run and execution use that same inventory. It reads
unit templates, Edge configuration and operation trust from the release tree.
It has no HTTP/dashboard route: installation is local host maintenance.

For an extracted archive, inspect and execute the plan:

```bash
sudo ./install.sh --dry-run
sudo ./install.sh
```

The equivalent local command is `zelavis install --from-release
/absolute/path/to/release`. `--json` provides machine-readable output,
`--force` deliberately replaces a foreign command link, and
`--allow-downgrade` permits an older release. Existing tokens, trust and Edge
configuration are kept. Releases live in `/opt/zelavis/releases/<version>` with
`current` selecting the active one; previous archive releases are retained.
Downtime-free blue/green updates remain [planned](../../architecture/updates/).

An installed CLI can also acquire an exact release with
`zelavis install --from package --version <exact-version>` (add `--user` for user
mode). Package dry-run shows acquisition and layout without downloading; the
full step inventory is computed after the archive has been verified.



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
shared. Each instance selects its own release, so upgrading `preview` leaves
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
the shared releases, management `current`, command links, unit templates, APT
source/key and Debian package records are retained. Removing the last instance
removes that shared inventory too. `--all` means all data of the selected
instance, including its Projects; it does not remove every instance on the host.
The instance directories, descriptors, template units and Edge ownership files
are covered by the destructive uninstall inventory and tests.

## Installation ownership and health

The current receipt records the source, entry point, version, paths and
selected instance and port. Without `--instance`, all installer entries repair or upgrade `default`.
A different recorded installation or service layout is refused. Foreign npm,
source or other commands on PATH are reported with removal/PATH guidance.
`--force` permits deliberate command replacement; it cannot bypass a live data
owner or another listener on the selected port. Public ports 80/443 remain unclaimed at installation.

Install and complete removal use an exclusive `<prefix>/.install.lock` (`flock`
on Linux, supplied by `util-linux`). Node and Bun Platforms and installer
maintenance share `<data>/.platform.lock`, with PID/start/session metadata in
`.platform-owner.json`. Two Platforms cannot open the same default System Store.
Normal close and process death release ownership; the lock file remains for reuse.
Stop user-run Platforms before maintenance. A matching owned systemd Platform
can be stopped and restarted by the installer for repair/upgrade; this involves
downtime. Old pre-release receipts/layouts are not migrated.

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

## Manual release archive (.tar.gz)

The standalone `.tar.gz` and `.zip` archives are self-contained and suitable for
manual download, SFTP upload, or air-gapped environments:

```bash
# 1. Download and extract the matching archive
curl -fsSLO https://github.com/zelavis/zelavis/releases/latest/download/zelavis-linux-x64.tar.gz
tar -xzf zelavis-linux-x64.tar.gz
cd zelavis-*

# 2. Run the archive installer
sudo ZELAVIS_ENABLE_AGENT=1 ./install.sh
```

The installer places versioned releases under `/opt/zelavis/releases/<version>`,
symlinks `/opt/zelavis/current`, links the CLI binary to `/usr/local/bin/zelavis`,
creates the dedicated `zelavis` system user, and enables the Platform unit.
The Agent is opt-in and Traefik remains disabled until Edge activates routes.

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

A system installation starts its HTTP service listener at
`http://127.0.0.1:3000` (port 3000 on loopback). Use the SSH tunnel below for
remote browser access. Passing `--public` to the archive installer deliberately
writes a unit that binds to all interfaces; rerunning without it restores loopback.

Public web ports (`80` and `443`) intentionally remain dormant during first install:
Zelavis never hijacks public HTTP/HTTPS ports before you have explicitly configured
your domain and verified DNS.

A one-time **bootstrap token** is generated during installation and printed in
your terminal output (also saved in `/etc/zelavis/zelavis.env` with
strict `0600` permissions). In user mode, it is saved in
`~/.local/share/zelavis/config/zelavis.env`, and the operator starts `zelavis serve`.

You have two primary ways to access the graphical onboarding wizard, plus an
interactive terminal option:

### Option A: Direct Browser Access (Without SSH Tunnel)

If you deliberately installed with `sudo ./install.sh --public` and your
firewall permits inbound traffic on port 3000:

1. Open your browser and navigate directly to:
   ```text
   http://<your-server-ip>:3000/zelavis/setup
   ```
2. Paste the **bootstrap token** from `/etc/zelavis/zelavis.env`.
3. Enter your administrator email and password to claim the **Owner** account.
4. In the **Edge Onboarding** step, enter your domain name (e.g. `app.example.com` or `example.com`).
   Make sure your domain's DNS A/AAAA record points to your server's public IP.
5. Select **Managed TLS** and click **Continue**.
6. Zelavis performs DNS preflight verification, requests automated Let's Encrypt
   certificates using pure RFC 8555 ACME v2, and switches Traefik to serve production
   traffic on standard ports **80** and **443**.
7. Once completed, port 3000 is no longer needed—you can close it in your firewall
   and access your dashboard directly over secure HTTPS at:
   ```text
   https://yourdomain.com/zelavis
   ```

### Option B: Secure Access via SSH Port Forwarding (With SSH Tunnel)

Use an SSH tunnel for the default loopback listener:

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
4. Select **Managed TLS** and provide your domain.
5. When the wizard confirms your domain is live and certificates are active, close
   the SSH tunnel (`Ctrl+C` or exit the SSH session).
6. Access your platform directly at:
   ```text
   https://yourdomain.com/zelavis
   ```

### Option C: Interactive Terminal Setup (CLI)

If you are logged into the server over SSH and prefer completing setup directly in the
terminal without a web browser:

```bash
zelavis setup
```

The CLI wizard prompts for the bootstrap token, creates the first Owner, runs
DNS preflight checks on your domain, issues certificates, and activates Edge Traefik
routing.

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

- Stops and disables `zelavis.service`, `zelavis-agent.service`, and `zelavis-traefik.service`.
- Removes `/opt/zelavis`, including the receipt, `runtime.json`, `.install.lock`, instance directories and host Edge ownership files, recorded command links, and systemd unit files. The default `/usr/local/bin/zelavis` and `/usr/bin/zelavis` links are removed only when they point into this installation.
- Removes configuration, signed host operations, and certificates.
- Completely deletes `/var/lib/zelavis`, including all project databases and runtimes, `.platform.lock` and `.platform-owner.json`.
- Removes the Zelavis APT source/key and Debian package records when present.
- Removes the `zelavis` user/group only when the receipt records installer ownership and their current properties are safe.

Shared host packages, journal history, external archives/backups and
operator-managed proxy/firewall/DNS/TLS state are retained. Complete uninstall
has no remote HTTP/dashboard route. Package/create installs with a current
receipt use this inventory; plain npm/source copies without one use their
originating package manager or development lifecycle.

For a **user installation**, run those two uninstall commands without sudo.
Its inventory is the complete `~/.local/share/zelavis` prefix (including releases,
data and ownership lock/record, configuration/token, installer lock, receipt and runtime descriptor) and the owned `~/.local/bin/zelavis` link.
It does not touch systemd units, APT sources/keys, system commands or accounts.
Stop the user-run Platform before removing it.
