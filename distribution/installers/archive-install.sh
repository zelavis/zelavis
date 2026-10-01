#!/bin/sh
set -eu
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$SOURCE_DIR/runtime/node/bin/node" "$SOURCE_DIR/platform/dist/cli.js" install --from-release "$SOURCE_DIR" "$@"
