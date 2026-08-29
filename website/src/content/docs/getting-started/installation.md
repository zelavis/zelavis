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

## After installation

The service starts the dashboard at `http://127.0.0.1:3000/zelavis`. Put a
reverse proxy and TLS in front of it before exposing a production installation
to the internet. Platform data defaults to `/var/lib/zelavis` for packaged
installs.

Before the first owner is created, configure a one-time bootstrap token with at
least 32 characters. For an npm-managed process, for example:

```bash
export ZELAVIS_BOOTSTRAP_TOKEN="replace-with-a-random-token-at-least-32-characters-long"
zelavis serve
```

Open the dashboard, create the first owner with that token, then remove the
bootstrap token from the service environment and restart Zelavis. The bootstrap
endpoint permanently refuses to create another owner once an account exists.

The first release matrix targets Linux and macOS on `x64` and `arm64` for
archives, plus Debian/Ubuntu on `amd64` and `arm64` for APT and `.deb` packages.
Windows packages and other Linux package repositories are not implemented yet.
