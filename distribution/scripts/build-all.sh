#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"

node distribution/scripts/build-stage.mjs "$@"
node distribution/scripts/build-archives.mjs

if [ "$(uname -s)" = Linux ] && command -v dpkg-deb >/dev/null 2>&1; then
  node distribution/scripts/build-deb.mjs
else
  echo "Skipping .deb build: a Linux host with dpkg-deb is required."
fi

node distribution/scripts/build-checksums.mjs
