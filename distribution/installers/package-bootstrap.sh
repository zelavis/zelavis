#!/bin/sh
# This program is passed as literal shell code to sudo, never executed from an
# npm/pnpm/Bun cache as root. Root acquires and verifies its own release.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
# sudo normally scrubs these; direct root invocations must also be clean.
unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH
unset ZELAVIS_PREFIX ZELAVIS_BIN_DIR ZELAVIS_DATA_DIR ZELAVIS_UNINSTALL_ETC_DIR ZELAVIS_FORCE_BIN ZELAVIS_ENABLE_AGENT
VERSION=$1
shift
case "$VERSION" in ''|*[!0-9A-Za-z.+-]*) echo 'An exact Zelavis version is required.' >&2; exit 1 ;; esac
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo 'Unsupported architecture.' >&2; exit 1 ;; esac
case "$OS" in linux|darwin) ;; *) echo 'Unsupported operating system.' >&2; exit 1 ;; esac
RELEASE_NAME="zelavis-$VERSION-$OS-$ARCH"
BASE="https://github.com/zelavis/zelavis/releases/download/zelavis@$VERSION"
TEMPORARY=$(mktemp -d /tmp/zelavis-package-install.XXXXXX)
chmod 0700 "$TEMPORARY"
trap 'rm -rf "$TEMPORARY"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Neither an invoking user's download nor their expected digest is trusted.
curl --proto '=https' --proto-redir '=https' --fail --silent --show-error --location --max-time 300 \
  --max-filesize 1048576 "https://registry.npmjs.org/zelavis/$VERSION" -o "$TEMPORARY/package.json"
curl --proto '=https' --proto-redir '=https' --fail --silent --show-error --location --max-time 300 \
  --max-filesize 1048576 "$BASE/SHA256SUMS" -o "$TEMPORARY/SHA256SUMS"
curl --proto '=https' --proto-redir '=https' --fail --silent --show-error --location --max-time 300 \
  --max-filesize 536870912 "$BASE/$RELEASE_NAME.tar.gz" -o "$TEMPORARY/release.tar.gz"
EXPECTED=$(awk -v name="$RELEASE_NAME.tar.gz" '$2 == name { print $1 }' "$TEMPORARY/SHA256SUMS")
case "$EXPECTED" in ''|*[!0-9a-fA-F]*) echo 'Missing or invalid release SHA-256.' >&2; exit 1 ;; esac
[ "${#EXPECTED}" -eq 64 ] || { echo 'Invalid release SHA-256 length.' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$TEMPORARY/release.tar.gz" | awk '{print $1}');
else ACTUAL=$(shasum -a 256 "$TEMPORARY/release.tar.gz" | awk '{print $1}'); fi
[ "$EXPECTED" = "$ACTUAL" ] || { echo 'Release checksum verification failed.' >&2; exit 1; }
tar -tzf "$TEMPORARY/release.tar.gz" > "$TEMPORARY/files"
# Bound every extracted member to the versioned archive root.
while IFS= read -r member; do
  case "$member" in "$RELEASE_NAME"|"$RELEASE_NAME/"*) ;; *) echo 'Unsafe release archive member.' >&2; exit 1 ;; esac
  case "$member" in */../*|*/..|*/./*|*/.) echo 'Unsafe release archive member.' >&2; exit 1 ;; esac
done < "$TEMPORARY/files"
tar --no-same-owner -xzf "$TEMPORARY/release.tar.gz" -C "$TEMPORARY"
RELEASE="$TEMPORARY/$RELEASE_NAME"
NODE="$RELEASE/runtime/node/bin/node"
[ -d "$RELEASE" ] && [ ! -L "$RELEASE" ] && [ ! -L "$RELEASE/runtime" ] && [ ! -L "$RELEASE/runtime/node" ] && [ ! -L "$RELEASE/runtime/node/bin" ] && [ -f "$NODE" ] && [ ! -L "$NODE" ] || { echo 'Release lacks its private Node binary.' >&2; exit 1; }
"$NODE" -e '
  const fs = require("node:fs");
  const [metadata, tree, version, platform, architecture] = process.argv.slice(1);
  const npm = JSON.parse(fs.readFileSync(metadata, "utf8"));
  const path = require("node:path");
  const root = fs.realpathSync(tree);
  function validateLinks(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        if (target !== root && !target.startsWith(root + "/")) throw Error("Release link escapes its verified tree.");
      } else if (entry.isDirectory()) validateLinks(file);
    }
  }
  validateLinks(tree);
  const release = JSON.parse(fs.readFileSync(tree + "/manifest.json", "utf8"));
  if (npm.name !== "zelavis" || npm.version !== version || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(npm.dist?.integrity ?? "")) throw Error("Invalid published package metadata.");
  if (release.name !== "zelavis" || release.version !== version || release.platform !== platform || release.architecture !== architecture) throw Error("Release identity does not match the published package and host.");
' "$TEMPORARY/package.json" "$RELEASE" "$VERSION" "$OS" "$ARCH"
"$NODE" "$RELEASE/platform/dist/cli.js" install --from-release "$RELEASE" --source package --installed-by create "$@"
