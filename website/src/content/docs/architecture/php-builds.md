---
title: PHP Builds
description: How the PHP the recipes run is built from php.net's source, published to a mirror, and managed from the dashboard without giving a plugin root.
---

php.net publishes only source code for Linux and macOS, and a server has no compiler, so the PHP a recipe runs
(its manifest `runtimes`) is built by Zelavis and pinned by SHA-256. Two things do that work.

## The build script

`distribution/php-builds/build.sh <exact version>` compiles a static PHP (CLI and FPM) for the machine it runs on
with a pinned [static-php-cli](https://github.com/crazywhalecc/static-php-cli) (`spc.pins` holds its SHA-256 for
each platform) and the extension set in `extensions.txt`. It checks that PHP reports the version asked for, that
every extension is present (including `mbregex`, which the builder needs named on its own) and that `php-fpm` runs,
then writes one archive per program, named with the digest of the extension set, and a line of JSON for each in
`builds.jsonl`. Between the download and the compile, `sources-lock.sh` checks every downloaded source against
`sources.lock` (an archive's SHA-256, a git checkout's commit, per PHP series and platform) and stops the build on any
difference, so what goes into PHP changes only when someone accepts it with `--update-lock`. `pin.mjs` turns those lines into the recipes' manifest entries. Nothing is signed: the digest a
recipe pins is the only trust, and the mirror (a Cloudflare R2 bucket at `mirror.zelavis.com`, movable to Zelavis's
own cloud) is untrusted storage.

## The PHP Builds service

`@zelavis/php-builds` is a marketplace plugin that does that work from the dashboard, the SDK, HTTP or the CLI. It
has no authority of its own. A plugin may name fixed host operations in its manifest
(`zelavis.hostOperations`, see the [plugin API](../guides/plugin-api/)); the service names six, and every call is
made with the caller's own principal, so the Platform checks the caller's permissions:

| Operation | Permission | What it does |
| --- | --- | --- |
| `zelavis.host-report`, `zelavis.container-probe` | `server.host.report` | machine facts; whether a container engine exists and works |
| `zelavis.php-build-start` | `server.php-builds.run` | one detached, labeled, resource-limited container from a digest-pinned image, at most half the host's cores and free memory, one build at a time |
| `zelavis.php-build-status` | `server.php-builds.view` | state, a safe log tail, each archive's digest |
| `zelavis.php-build-upload` | `server.php-builds.run` | one archive to a presigned R2 address, from the build's output |
| `zelavis.php-build-clean` | `server.php-builds.run` | stop and remove the build's container and output volume |

A build outlasts the 15 minutes an operation may run, so start only launches it; the host's labeled container is
the truth, and the service keeps one record per job. The start operation carries `build.sh` and its pins inside its
own artifact (`operation.json`'s `embed`), so its digest covers them and nothing has to be installed on the host.
Upload credentials never reach the build host: the service signs a short-lived address with the operator's R2 key
(read from the Platform's environment file, never stored or returned) and the host sends the archive straight there.

## Limits

A container engine must already be on the host (Zelavis does not install one), and the host operation Agent of a
system installation is required. Builds start cold: the shared work volume keeps sources and compiled libraries so
later versions are quick, and GitHub's anonymous API limit of 60 requests an hour allows roughly one cold build an
hour per network. The static builds have a fixed extension set; loadable extensions for per-Project switching are a
later step.
