# PHP builds

Recipes run their own PHP (the manifest's `runtimes`), and php.net publishes no runnable PHP for Linux or
macOS, only source. These scripts compile a static PHP (CLI and FPM) with
[static-php-cli](https://github.com/crazywhalecc/static-php-cli) on a machine the owner runs, and print the
archives' SHA-256 for the recipes to pin. There is no CI step and nothing is signed: the digests are what
the recipes trust, and they ship through npm.

```sh
distribution/php-builds/build.sh 8.4.23 --out ./out
```

It builds for the platform it runs on, so run it once per platform:

| Platform | Run it on |
| --- | --- |
| `linux-x86_64` | a Linux machine, a VPS, or WSL2 on Windows (work inside the Linux filesystem, not `/mnt/c`) |
| `linux-aarch64` | an ARM Linux machine or VPS, or Docker on an Apple-silicon Mac (a Linux ARM container) |
| `macos-aarch64`, `macos-x86_64` | a Mac of that architecture |

A build wants about 4 cores, 8 GB of memory and 12 GB of free disk at its peak (it refuses to start with
less, `ZELAVIS_PHP_BUILD_MIN_FREE_GB` changes the limit); the work directory is removed afterwards unless
`--keep` is given. On a fresh Debian or Ubuntu machine install the usual compiler tools first
(`build-essential`, `curl`, `git`, `pkg-config`); the builder's own `doctor` step reports anything else it
needs.

## What it produces

For each PHP version and platform, two archives with the program at the archive's root, the layout the
manifests' `executable` expects:

```
php-8.4.23-cli-linux-x86_64.tar.gz     php
php-8.4.23-fpm-linux-x86_64.tar.gz     php-fpm
```

and one line per archive in `builds.jsonl` (file, `sha256`, `bytes`, builder version, and the digest of the
extension list). The build checks that PHP reports the exact version asked for, that every extension in
`extensions.txt` is loaded, and that `php-fpm` runs, before it packages anything.

## What is pinned

- `spc.pins` the builder's own version and SHA-256 per platform; the script refuses a builder that does not
  match.
- `extensions.txt` the extension set of every build. Changing it changes every build.
- The PHP version is exact (`8.4.23`), never a range, so a rebuild asks for the same source.

Builds are not bit-for-bit reproducible (compilers embed paths and times); what is reproducible is the
description, and the digest of what was actually built is what a recipe pins.

## The mirror

The archives are served from `https://mirror.zelavis.com/php/<version>/<file>`, a Cloudflare R2 bucket
(`zelavis-mirror`) with that custom domain. It is untrusted storage: the recipes pin each archive's SHA-256, so
the host can change (it may move to Zelavis's own cloud) without changing what is trusted. Upload with
the owner's own Wrangler login:

```sh
wrangler r2 object put zelavis-mirror/php/8.4.23/<file> --file <file> \
  --content-type application/gzip --cache-control "public, max-age=86400" --remote
```

## After a build

Upload the archives wherever the mirror is, and put the new URL (as `archive`, or as one of its `mirrors`),
`sha256`, `bytes` (as `maxBytes`, with room) and `executable` into the recipe manifests' `runtimes`. These
are static builds: their extensions are fixed when they are compiled. A build with loadable extensions
(glibc, `shared-extensions`) is the later step for per-Project extension switching.
