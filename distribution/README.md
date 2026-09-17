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
- npm: users who manage Node 24 themselves can run `npm install -g zelavis`.

Archive and npm installations can provision the native WordPress dependencies
through APT or Homebrew on first use when Zelavis has package-install authority.
An unprivileged installation must have those packages installed by the host
operator before creating its first WordPress Project.

The generic quick-installer archive URLs are stable aliases such as
`https://downloads.zelavis.com/latest/zelavis-linux-x64.tar.gz`. Release
publishing must point those aliases at the versioned artifacts generated here
and publish the raw SHA-256 digest beside each alias as `<archive>.sha256`.
