---
title: Installation
description: Install the long-running Zelavis Platform OS with APT, a Debian package, an archive, or npm.
---

Zelavis is a long-running Platform OS. It is installed on a server or local
machine; it is not deployed as a serverless function.

## Quick install

The quick installer detects the operating system and CPU. It configures the
signed Zelavis APT repository on Debian and Ubuntu, and uses a self-contained
archive on other supported Unix systems.

```bash
curl -fsSL https://zelavis.com/install.sh | sudo sh
```

The packaged installation contains a private pinned Node runtime. It does not
replace the machine's global Node installation.

## APT

Install the small repository bootstrap package once, then manage Zelavis with
normal APT commands:

```bash
sudo apt install ./zelavis-repository_1.0.0_all.deb
sudo apt update
sudo apt install zelavis
```

Future releases then arrive through `sudo apt upgrade`. The repository package
contains the source definition and public signing key only.

## Direct Debian package

Download the package matching the server CPU and install it locally:

```bash
sudo apt install ./zelavis_<version>_amd64.deb
```

Use the `_arm64.deb` artifact on ARM64 servers. Installing through `apt` rather
than invoking `dpkg` directly lets the system resolve package dependencies.

## Manual archive

The `.tar.gz` and `.zip` releases are suitable for a traditional browser
download, SFTP upload, or SSH transfer. Extract the matching OS and CPU archive,
then run:

```bash
sudo ./install.sh
```

The installer places versioned releases under `/opt/zelavis/releases`, points
`/opt/zelavis/current` at the selected release, creates the `zelavis` system
user, and enables the systemd service when systemd is present.

## npm

Use npm when you deliberately manage the host runtime yourself:

```bash
npm install --global zelavis
zelavis serve
```

The npm path requires Node.js 24 or newer. It exposes the same CLI as the
operating-system packages.

Both paths install a command called `zelavis`, and npm's prefix is often the
same directory the archive installer uses. The archive installer refuses to
replace a `zelavis` it did not create, rather than overwriting an npm install
silently; remove the other one, point `ZELAVIS_BIN_DIR` elsewhere, or set
`ZELAVIS_FORCE_BIN=1` to replace it deliberately.

A Debian package installs to `/usr/bin` and overwrites nothing, but
`/usr/local/bin` comes first on the default path, so an npm install there
answers instead. `zelavis --version` prints which installation is running:

```bash
zelavis --version
# 1.0.1-alpha.2
# packaged installation at /opt/zelavis
```

Platform data is written to `~/.local/share/zelavis`, or to
`$XDG_DATA_HOME/zelavis` when that variable names an absolute path. The
location does not depend on the directory `zelavis serve` runs from. Override
it with `--data-dir`, or with `ZELAVIS_DATA_DIR` when running under a process
supervisor:

```bash
zelavis serve --data-dir /srv/zelavis
```

## After installation

The Platform starts its private dashboard listener at
`http://127.0.0.1:3000/zelavis`. Packaged Linux installations also install the
release-pinned, checksum-verified Traefik binary and
`zelavis-traefik.service`, the first Zelavis Edge adapter. The unit remains
disabled until Edge can stage and verify a complete publication. Its generated route
directory starts empty: merely installing Zelavis never publishes an unknown
hostname or an unverified TLS route.

The setup wizards check Edge after the owner is claimed. Until the host adapter
can stage and verify a complete route publication, keep using the private
listener through an SSH tunnel and do not expose port 3000 directly. npm and
source installations do not install an operating-system reverse proxy; their
host adapter must be configured separately. Platform data defaults to
`/var/lib/zelavis` for packaged installs.

Before the first owner is created, configure a one-time bootstrap token with at
least 32 characters. For an npm-managed process, for example:

```bash
export ZELAVIS_BOOTSTRAP_TOKEN="replace-with-a-random-token-at-least-32-characters-long"
zelavis serve
```

Native package and archive installers generate this token in the private
`/etc/zelavis/zelavis.env` service environment and print it once at the end of
installation. Copy that value into either first-run wizard. Existing
configuration is preserved on upgrades, so an installer never silently rotates
an operator's bootstrap token.

Open the dashboard, create the first owner with that token, then remove the
bootstrap token from the service environment and restart Zelavis. The bootstrap
endpoint permanently refuses to create another owner once an account exists.

The first browser visit redirects to the guided setup wizard at
`/zelavis/setup`. To perform the same guided setup from an SSH session instead,
run:

```bash
zelavis setup --url http://127.0.0.1:3000/zelavis
```

Both wizards use the same one-time bootstrap endpoint. For unattended installs,
use `zelavis bootstrap --email <email> --password-stdin`; it remains the
non-interactive equivalent rather than a separate setup mechanism.

## Completely uninstall a packaged installation

Use the complete uninstall when you want to return a native packaged host to a
state where the Zelavis installer can be exercised again. Inspect the exact
scope first:

```bash
sudo zelavis uninstall --all --dry-run
```

Then run the destructive operation with its exact acknowledgement:

```bash
sudo zelavis uninstall --all --confirm DELETE-ALL-ZELAVIS-DATA
```

This stops and removes the Zelavis Platform, Agent, and Zelavis-owned Traefik
services; removes the
packaged releases, command links, APT source and key, local configuration and
trust material; deletes the installer-recorded data directory (by default
`/var/lib/zelavis`), including every Project, database, log and runtime record;
and removes the dedicated system account when it is safe to identify. The
operation cannot be undone.

Zelavis-owned Traefik binaries, service files, generated routes, and static
adapter configuration below the installation paths are removed. Zelavis
intentionally retains shared operating-system packages such as Nginx,
PHP and MariaDB, systemd journal history, archives and backups outside the data
directory, and operator-managed proxy, firewall, DNS and TLS configuration.
Those resources may belong to other workloads, so a Zelavis installer cannot
prove that it owns them.

Complete uninstall is available only from a native packaged installation
(quick install, APT, `.deb`, or the release archive). An npm or source checkout
must be removed with the package manager or development workflow that created
it; the CLI refuses to guess which data or host resources those workflows own.

The first release matrix targets Linux and macOS on `x64` and `arm64` for
archives, plus Debian/Ubuntu on `amd64` and `arm64` for APT and `.deb` packages.
Windows packages and other Linux package repositories are not implemented yet.
