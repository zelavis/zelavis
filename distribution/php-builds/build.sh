#!/bin/sh
# Builds a static PHP (CLI and FPM) for this machine's platform with static-php-cli and packages it the way
# the recipes' `runtimes` manifests expect: one .tar.gz per program with the executable at its root, plus a
# line of JSON per archive (file, SHA-256, size) in builds.jsonl for pinning.
#
#   build.sh 8.4.23                  build PHP 8.4.23 into ./out
#   build.sh 8.4.23 --out DIR        put the archives somewhere else
#   build.sh 8.4.23 --dry-run        fetch and verify the builder and show what would run; builds nothing
#   build.sh 8.4.23 --keep           keep the work directory (sources, logs) afterwards
#   build.sh 8.4.23 --update-lock    record the sources this build downloaded in sources.lock (a reviewed change)
#   build.sh 8.4.23 --lock-only      download and check (or, with --update-lock, record) the sources, then stop
#
# It runs only where you start it (a Linux box, WSL2, a Mac); no CI. Nothing is signed: the digests in
# builds.jsonl are what the recipes pin, and they ship through npm.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
VERSION=
OUT="$PWD/out"
WORK=
KEEP=no
DRY=no
UPDATE_LOCK=no
LOCK_ONLY=no
MIN_FREE_GB=${ZELAVIS_PHP_BUILD_MIN_FREE_GB:-12}

die() { printf 'build.sh: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || die "--out needs a directory"; OUT=$2; shift 2 ;;
    --work) [ $# -ge 2 ] || die "--work needs a directory"; WORK=$2; shift 2 ;;
    --keep) KEEP=yes; shift ;;
    --dry-run) DRY=yes; shift ;;
    --update-lock) UPDATE_LOCK=yes; shift ;;
    --lock-only) LOCK_ONLY=yes; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$VERSION" ] || die "one PHP version only"; VERSION=$1; shift ;;
  esac
done
[ -n "$VERSION" ] || die "give an exact PHP version, for example 8.4.23"
case "$VERSION" in
  [0-9].[0-9]*.[0-9]*) ;;
  *) die "the version must be exact (major.minor.patch), not a range" ;;
esac

# ---- which platform --------------------------------------------------------------------------------
case "$(uname -s)" in
  Linux) FAMILY=linux ;;
  Darwin) FAMILY=macos ;;
  *) die "this builds on Linux and macOS (on Windows, run it inside WSL2)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) CPU=x86_64 ;;
  aarch64|arm64) CPU=aarch64 ;;
  *) die "unsupported processor $(uname -m)" ;;
esac
PLATFORM=$FAMILY-$CPU

# ---- the builder, verified before it is run --------------------------------------------------------
SPC_VERSION=$(awk '$1 == "version" { print $2 }' "$HERE/spc.pins")
SPC_SHA256=$(awk -v platform="$PLATFORM" '$1 == platform { print $2 }' "$HERE/spc.pins")
[ -n "$SPC_VERSION" ] && [ -n "$SPC_SHA256" ] || die "spc.pins has no entry for $PLATFORM"

[ -n "$WORK" ] || WORK=$(mktemp -d "${TMPDIR:-/tmp}/zelavis-php-build.XXXXXX")
mkdir -p "$WORK" "$OUT"
cleanup() { [ "$KEEP" = yes ] || rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'; else shasum -a 256 "$1" | awk '{ print $1 }'; fi
}

free_gb=$(df -Pk "$WORK" | awk 'NR == 2 { printf "%d", $4 / 1048576 }')
[ "$free_gb" -ge "$MIN_FREE_GB" ] || die "only ${free_gb} GB free where the work happens; a build needs about ${MIN_FREE_GB} GB (use --work on a bigger disk)"

printf 'Fetching static-php-cli %s for %s\n' "$SPC_VERSION" "$PLATFORM"
curl -fsSL --retry 3 -o "$WORK/spc.tar.gz" "https://github.com/crazywhalecc/static-php-cli/releases/download/$SPC_VERSION/spc-$PLATFORM.tar.gz"
[ "$(sha256_of "$WORK/spc.tar.gz")" = "$SPC_SHA256" ] || die "the downloaded builder does not match the digest pinned in spc.pins"
tar -xzf "$WORK/spc.tar.gz" -C "$WORK" spc
chmod +x "$WORK/spc"

# ---- the build description -------------------------------------------------------------------------
EXTENSIONS=$(sed 's/#.*//' "$HERE/extensions.txt" | awk 'NF { printf "%s%s", sep, $1; sep = "," }')
EXTENSIONS_SHA=$(sha256_of "$HERE/extensions.txt")
# The builder runs in two phases with a check between them: download, then build from exactly what the lock names.
write_craft() { # write_craft <doctor> <download> <build>
  cat > "$WORK/craft.yml" <<CRAFT
php-version: $VERSION
extensions: $EXTENSIONS
sapi: cli,fpm
debug: true
download-options:
  retry: 5
  prefer-pre-built: ${ZELAVIS_PHP_BUILD_PREBUILT_LIBS:-false}
craft-options:
  doctor: $1
  download: $2
  build: $3
CRAFT
  # The builder fetches many sources through GitHub's API, which allows 60 requests an hour without a token. A
  # token with no scopes (a fine-grained one for public data) lifts that; it is written only into this build's
  # craft.yml, which is deleted with the work directory.
  if [ -n "${ZELAVIS_PHP_BUILD_GITHUB_TOKEN:-}" ]; then
    printf 'extra-env:\n  GITHUB_TOKEN: %s\n' "$ZELAVIS_PHP_BUILD_GITHUB_TOKEN" >> "$WORK/craft.yml"
  fi
}
write_craft true true false

printf 'PHP %s for %s, extensions: %s\n' "$VERSION" "$PLATFORM" "$EXTENSIONS"
if [ "$DRY" = yes ]; then
  printf 'Dry run: the builder is verified; this is the craft.yml it would run, and nothing is built.\n'
  cat "$WORK/craft.yml"
  exit 0
fi

# ---- download, and check every source against the lock ---------------------------------------------
( cd "$WORK" && ./spc craft --debug ) || die "the download failed; rerun with --keep and read $WORK/log"

LOCK_KEY="php-$(printf '%s' "$VERSION" | cut -d. -f1,2)-$PLATFORM"
if [ "$UPDATE_LOCK" = yes ]; then MODE=update; else MODE=check; fi
sh "$HERE/sources-lock.sh" "$MODE" "$WORK/downloads" "$LOCK_KEY" "$HERE/sources.lock" || die "the sources do not match sources.lock"

if [ "$LOCK_ONLY" = yes ]; then printf 'Sources checked; not building.\n'; exit 0; fi

# ---- build, from exactly those sources -------------------------------------------------------------
write_craft false false true
( cd "$WORK" && ./spc craft --debug ) || die "the build failed; rerun with --keep and read $WORK/log"
BIN="$WORK/buildroot/bin"
[ -x "$BIN/php" ] && [ -x "$BIN/php-fpm" ] || die "the build did not produce php and php-fpm"

# ---- prove what was built is what was asked for ----------------------------------------------------
ACTUAL=$("$BIN/php" -r 'echo PHP_VERSION;')
[ "$ACTUAL" = "$VERSION" ] || die "built PHP $ACTUAL, not $VERSION"
LOADED=$("$BIN/php" -m | tr 'A-Z' 'a-z')
for extension in $(sed 's/#.*//' "$HERE/extensions.txt" | awk 'NF { print $1 }'); do
  case "$extension" in
    # mbregex is a feature of mbstring, not a module of its own.
    mbregex) "$BIN/php" -r 'exit(function_exists("mb_regex_encoding") ? 0 : 1);' || die "the build lacks mbregex"; continue ;;
    opcache) expected="zend opcache" ;;
    *) expected=$extension ;;
  esac
  printf '%s\n' "$LOADED" | grep -qx "$expected" || die "the build lacks the extension $extension"
done
"$BIN/php-fpm" -v >/dev/null || die "php-fpm does not run"

# ---- package and record ----------------------------------------------------------------------------
: > "$WORK/records"
for program in php php-fpm; do
  case "$program" in php) sapi=cli ;; php-fpm) sapi=fpm ;; esac
  # The extension set is part of the name, so a build with another set never reuses a URL a cache may hold.
  archive="php-$VERSION-$(printf '%s' "$EXTENSIONS_SHA" | cut -c1-8)-$sapi-$PLATFORM.tar.gz"
  # gzip -n leaves the clock out of the archive's header.
  tar -cf - -C "$BIN" "$program" | gzip -n -9 > "$OUT/$archive"
  digest=$(sha256_of "$OUT/$archive")
  bytes=$(wc -c < "$OUT/$archive" | tr -d ' ')
  printf '{"php":"%s","sapi":"%s","platform":"%s","file":"%s","sha256":"%s","bytes":%s,"executable":"%s","builder":"static-php-cli %s","extensionsSha256":"%s"}\n' \
    "$VERSION" "$sapi" "$PLATFORM" "$archive" "$digest" "$bytes" "$program" "$SPC_VERSION" "$EXTENSIONS_SHA" >> "$WORK/records"
done
cat "$WORK/records" >> "$OUT/builds.jsonl"
cat "$WORK/records"
printf 'Done: %s\n' "$OUT"
