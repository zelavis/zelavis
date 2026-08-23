#!/bin/sh
set -eu

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VERSION=$("$SOURCE_DIR/runtime/node/bin/node" -e "const m=require(process.argv[1]); console.log(m.version)" "$SOURCE_DIR/manifest.json")
PREFIX=${ZELAVIS_PREFIX:-/opt/zelavis}
DATA_DIR=${ZELAVIS_DATA_DIR:-/var/lib/zelavis}
BIN_DIR=${ZELAVIS_BIN_DIR:-/usr/local/bin}
RELEASE_DIR="$PREFIX/releases/$VERSION"

if [ "$(id -u)" -ne 0 ] && [ "$PREFIX" = "/opt/zelavis" ]; then
  echo "Run this installer as root, or set ZELAVIS_PREFIX and ZELAVIS_BIN_DIR." >&2
  exit 1
fi

mkdir -p "$PREFIX/releases" "$DATA_DIR" "$BIN_DIR"
if [ ! -d "$RELEASE_DIR" ]; then
  mkdir -p "$RELEASE_DIR"
  cp -R "$SOURCE_DIR/bin" "$SOURCE_DIR/platform" "$SOURCE_DIR/runtime" "$SOURCE_DIR/share" "$SOURCE_DIR/manifest.json" "$RELEASE_DIR/"
fi
ln -sfn "$RELEASE_DIR" "$PREFIX/current"
ln -sfn "$PREFIX/current/bin/zelavis" "$BIN_DIR/zelavis"

if [ "$(id -u)" -eq 0 ] && command -v systemctl >/dev/null 2>&1; then
  if ! getent group zelavis >/dev/null 2>&1; then
    groupadd --system zelavis
  fi
  if ! id zelavis >/dev/null 2>&1; then
    useradd --system --gid zelavis --home-dir "$DATA_DIR" --shell /usr/sbin/nologin zelavis
  fi
  chown -R zelavis:zelavis "$DATA_DIR"
  sed \
    -e "s|/opt/zelavis/current|$PREFIX/current|g" \
    -e "s|/var/lib/zelavis|$DATA_DIR|g" \
    "$SOURCE_DIR/share/zelavis.service" > /etc/systemd/system/zelavis.service
  systemctl daemon-reload
  systemctl enable --now zelavis.service
fi

echo "Zelavis $VERSION installed."
echo "Dashboard: http://127.0.0.1:3000/zelavis"
