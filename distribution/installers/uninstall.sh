#!/bin/sh
set -eu
RELEASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$RELEASE_DIR/runtime/node/bin/node" "$RELEASE_DIR/platform/dist/cli.js" uninstall --all "$@"
