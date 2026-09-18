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
  cp -R "$SOURCE_DIR/bin" "$SOURCE_DIR/platform" "$SOURCE_DIR/runtime" "$SOURCE_DIR/share" "$SOURCE_DIR/operations" "$SOURCE_DIR/manifest.json" "$RELEASE_DIR/"
fi
ln -sfn "$RELEASE_DIR" "$PREFIX/current"

# `npm install --global zelavis` writes a `zelavis` into npm's prefix, which is
# commonly this same directory. `ln -sfn` would replace it without a word, so
# an install would silently destroy an unrelated one. Refuse instead: a stopped
# install is recoverable, a deleted one is not.
EXISTING="$BIN_DIR/zelavis"
if [ -e "$EXISTING" ] || [ -L "$EXISTING" ]; then
  EXISTING_TARGET=$(readlink "$EXISTING" 2>/dev/null || echo "$EXISTING")
  case "$EXISTING_TARGET" in
    "$PREFIX"/*)
      # This installer's own link from an earlier release. Replacing it is the
      # upgrade path, not a conflict.
      ;;
    *)
      if [ "${ZELAVIS_FORCE_BIN:-0}" = "1" ]; then
        echo "Replacing $EXISTING as ZELAVIS_FORCE_BIN=1 was set." >&2
      else
        echo "Refusing to replace $EXISTING, which this installer did not create." >&2
        echo "  It currently resolves to: $EXISTING_TARGET" >&2
        echo "  That is usually a global npm install; remove it with" >&2
        echo "    npm uninstall --global zelavis" >&2
        echo "  or set ZELAVIS_BIN_DIR to a different directory," >&2
        echo "  or set ZELAVIS_FORCE_BIN=1 to replace it deliberately." >&2
        exit 1
      fi
      ;;
  esac
fi
ln -sfn "$PREFIX/current/bin/zelavis" "$BIN_DIR/zelavis"

# Refusing above cannot catch the other direction. A `.deb` owns
# /usr/bin/zelavis and nothing is overwritten, but /usr/local/bin precedes
# /usr/bin on Debian and Ubuntu, so another copy earlier on PATH wins with
# nothing overwritten and nothing to refuse. Say so rather than let the wrong
# binary answer silently.
RESOLVED=$(command -v zelavis 2>/dev/null || true)
if [ -n "$RESOLVED" ] && [ "$RESOLVED" != "$BIN_DIR/zelavis" ]; then
  echo "Warning: 'zelavis' on PATH resolves to $RESOLVED, not $BIN_DIR/zelavis." >&2
  echo "  That installation will answer instead of this one." >&2
  echo "  Run 'zelavis --version' to see which one is in use." >&2
fi

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
  # Installed, not enabled; see the distribution README to run Projects and
  # host operations through the Agent.
  sed \
    -e "s|/opt/zelavis/current|$PREFIX/current|g" \
    -e "s|/var/lib/zelavis|$DATA_DIR|g" \
    "$SOURCE_DIR/share/zelavis-agent.service" > /etc/systemd/system/zelavis-agent.service
  # Operator-owned: an existing trust store (added or revoked keys) is kept.
  if [ ! -f /etc/zelavis/operation-trust.json ]; then
    install -d -m 0755 /etc/zelavis
    install -m 0644 "$SOURCE_DIR/share/operation-trust.json" /etc/zelavis/operation-trust.json
  fi
  systemctl daemon-reload
  systemctl enable --now zelavis.service
fi

echo "Zelavis $VERSION installed."
echo "Dashboard: http://127.0.0.1:3000/zelavis"
