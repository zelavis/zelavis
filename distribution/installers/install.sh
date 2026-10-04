#!/bin/sh
# One authored bootstrap: served by the website and shipped as a generated
# asset by create. It only acquires what the installer runs on: the private
# Node from nodejs.org and the exact `zelavis` package from npm. Everything
# about the host is `zelavis install`. Trust is those two https origins, nothing
# else: npm verifies the package against its registry digest, and the Node
# archive is checked against nodejs.org's published SHA-256.
set -eu
INVOKING_PATH=$PATH
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH
# This may run as root: nothing from the invoking user's npm configuration applies.
for NAME in $(env | sed -n -e 's/^\(npm_config_[A-Za-z0-9_]*\)=.*/\1/p' -e 's/^\(NPM_CONFIG_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$NAME"; done
# Keep in step with distribution/release.json nodeVersion (a test enforces it).
NODE_VERSION=24.12.0
VERSION=
CHANNEL=latest
ENTRY=script
case "${1:-}" in
  --help|-h)
    echo 'Usage: install.sh [--version <exact> | --channel alpha|latest] [installer flags]'
    echo 'Installer flags: --user --instance <name> --port <port> --dry-run --public --force --allow-downgrade --json'
    echo 'Linux system mode requires root and systemd. macOS defaults to --user.'
    exit 0 ;;
  [0-9]*) VERSION=$1; ENTRY=create; shift ;;
  --version) VERSION=${2:-}; [ -n "$VERSION" ] || { echo '--version requires a value.' >&2; exit 1; }; shift 2 ;;
  --channel) CHANNEL=${2:-}; [ -n "$CHANNEL" ] || { echo "--channel requires a value." >&2; exit 1; }; shift 2 ;;
esac
case "$CHANNEL" in alpha|latest) ;; *) echo 'Choose --channel alpha or latest.' >&2; exit 1 ;; esac
case "$(uname -s)" in
  Darwin) set -- --user "$@" ;;
  Linux) ;;
  *) echo 'Unsupported operating system.' >&2; exit 1 ;;
esac
USER_MODE=0
for ARG in "$@"; do [ "$ARG" != --user ] || USER_MODE=1; done
if [ "$USER_MODE" = 0 ] && [ "$(id -u)" != 0 ]; then
  echo 'System installation requires root. Pipe to sudo sh, or pass --user.' >&2
  exit 1
fi
if [ -z "$VERSION" ]; then
  TAGS=$(curl --proto '=https' --proto-redir '=https' --fail --silent --show-error --max-time 30 \
    --max-filesize 4096 https://registry.npmjs.org/-/package/zelavis/dist-tags)
  VERSION=$(printf '%s' "$TAGS" | sed -n "s/.*\"$CHANNEL\"[[:space:]]*:[[:space:]]*\"\([0-9][0-9A-Za-z.+-]*\)\".*/\1/p")
fi
printf '%s\n' "$VERSION" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?(\+[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$' || {
  echo 'An exact Zelavis version is required.' >&2; exit 1;
}
set -- "$@" --installed-by "$ENTRY"
[ "$ENTRY" = create ] || set -- "$@" --invoking-path "$INVOKING_PATH"
# Root acquires its own tree; create passes this as literal shell code to sudo.
unset ZELAVIS_PREFIX ZELAVIS_BIN_DIR ZELAVIS_DATA_DIR ZELAVIS_UNINSTALL_ETC_DIR ZELAVIS_FORCE_BIN
case "$(uname -s)" in Linux) OS=linux ;; Darwin) OS=darwin ;; esac
case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo 'Unsupported architecture.' >&2; exit 1 ;; esac
echo "Installing Zelavis $VERSION with private Node $NODE_VERSION."
TEMPORARY=$(mktemp -d /tmp/zelavis-install.XXXXXX)
chmod 0700 "$TEMPORARY"
trap 'rm -rf "$TEMPORARY"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fetch() { curl --proto '=https' --proto-redir '=https' --fail --silent --show-error --location --max-time 600 --max-filesize "$3" "$1" -o "$2"; }

# 1. The private Node, verified against nodejs.org's published checksums.
NODE_NAME="node-v$NODE_VERSION-$OS-$ARCH"
fetch "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" "$TEMPORARY/SHASUMS256.txt" 1048576
fetch "https://nodejs.org/dist/v$NODE_VERSION/$NODE_NAME.tar.gz" "$TEMPORARY/node.tar.gz" 268435456
EXPECTED=$(awk -v name="$NODE_NAME.tar.gz" '$2 == name { print $1 }' "$TEMPORARY/SHASUMS256.txt")
case "$EXPECTED" in ''|*[!0-9a-fA-F]*) echo 'Missing or invalid Node SHA-256.' >&2; exit 1 ;; esac
[ "${#EXPECTED}" -eq 64 ] || { echo 'Invalid Node SHA-256 length.' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$TEMPORARY/node.tar.gz" | awk '{print $1}');
else ACTUAL=$(shasum -a 256 "$TEMPORARY/node.tar.gz" | awk '{print $1}'); fi
[ "$EXPECTED" = "$ACTUAL" ] || { echo 'Node checksum verification failed.' >&2; exit 1; }
tar -tzf "$TEMPORARY/node.tar.gz" > "$TEMPORARY/files"
# Bound every extracted member to the versioned archive root.
while IFS= read -r member; do
  case "$member" in "$NODE_NAME"|"$NODE_NAME/"*) ;; *) echo 'Unsafe Node archive member.' >&2; exit 1 ;; esac
  case "$member" in */../*|*/..|*/./*|*/.) echo 'Unsafe Node archive member.' >&2; exit 1 ;; esac
done < "$TEMPORARY/files"
TREE="$TEMPORARY/tree"
mkdir -p "$TREE/runtime" "$TEMPORARY/extract"
tar --no-same-owner -xzf "$TEMPORARY/node.tar.gz" -C "$TEMPORARY/extract"
mv "$TEMPORARY/extract/$NODE_NAME" "$TREE/runtime/node"
NODE="$TREE/runtime/node/bin/node"
NPM="$TREE/runtime/node/lib/node_modules/npm/bin/npm-cli.js"
[ -f "$NODE" ] && [ ! -L "$NODE" ] && [ -f "$NPM" ] || { echo 'The Node archive lacks node or npm.' >&2; exit 1; }

# 2. The exact package from npm. npm verifies it against the registry digest.
# Install scripts stay off for the whole tree: this may run as root and the
# dependencies are not ours. Nothing needs them: every dependency is plain
# JavaScript, so there is no compiler or native build on the host.
PROJECT="$TEMPORARY/project"
mkdir "$PROJECT"
printf '{"private":true}\n' > "$PROJECT/package.json"
# Empty, distinct config files: nothing of the invoking user's npm setup applies.
: > "$TEMPORARY/npmrc-user"
: > "$TEMPORARY/npmrc-global"
NPM_OPTIONS="--prefix $PROJECT --registry=https://registry.npmjs.org --userconfig=$TEMPORARY/npmrc-user --globalconfig=$TEMPORARY/npmrc-global --cache=$TEMPORARY/npm-cache --no-audit --no-fund --loglevel=error"
# shellcheck disable=SC2086
PATH="$TREE/runtime/node/bin:$PATH" "$NODE" "$NPM" install $NPM_OPTIONS --omit=dev --ignore-scripts --install-strategy=hoisted "zelavis@$VERSION"
"$NODE" -e '
  const manifest = JSON.parse(require("node:fs").readFileSync(process.argv[1] + "/node_modules/zelavis/package.json", "utf8"));
  if (manifest.name !== "zelavis" || manifest.version !== process.argv[2]) throw Error("Installed package identity does not match the requested version.");
' "$PROJECT" "$VERSION"
# The package becomes the release's platform directory, with its dependencies
# hoisted beside it and the self import npm expects.
mv "$PROJECT/node_modules/zelavis" "$TREE/platform"
mv "$PROJECT/node_modules" "$TREE/platform/node_modules"
ln -s .. "$TREE/platform/node_modules/zelavis"

# 3. Everything else is the shared installer, run by the private Node.
"$NODE" --disable-warning=ExperimentalWarning "$TREE/platform/dist/cli.js" install --from-npm "$TREE" "$@"
