# Zelavis Distribution

This directory owns operating-system delivery for the Zelavis Platform OS. It
does not contain another runtime implementation. Every format is built from the
published `zelavis` package and the same staged release tree.

## Release layout

`pnpm distribution:stage` builds `packages/zelavis`, creates a production
deployment under `distribution/.tmp/stage/platform`, and adds:

- the exact official Blueprint catalog and dashboard assets shipped by `zelavis`
- production package dependencies, including native modules for the target CPU
- a private, checksum-verified Node runtime pinned by `release.json`
- the `zelavis` launcher and systemd service
- the archive installer and release manifest

The Debian package also declares Nginx, PHP-FPM and the WordPress PHP
extensions, MariaDB server/client core binaries, and `tar` as dependencies. The
core MariaDB packages avoid provisioning a machine-wide database instance. This
gives native WordPress Projects their required host stack without Docker. Each
Project runs its own service instances and owns its own configuration, sockets,
ports, logs, site files, credentials, and database data.

The private Node runtime lives under `/opt/zelavis/current/runtime/node` after
installation. It does not replace `/usr/bin/node` and cannot conflict with Node
versions used by other applications.

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
- npm: users who manage Node 24 themselves can run `npm install -g zelavis`.

Archive and npm installations can provision the native WordPress dependencies
through APT or Homebrew on first use when Zelavis has package-install authority.
An unprivileged installation must have those packages installed by the host
operator before creating its first WordPress Project.

The generic quick-installer archive URLs are stable aliases such as
`https://downloads.zelavis.com/latest/zelavis-linux-x64.tar.gz`. Release
publishing must point those aliases at the versioned artifacts generated here
and publish the raw SHA-256 digest beside each alias as `<archive>.sha256`.
