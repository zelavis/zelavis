#!/bin/sh
set -eu

APT_REPOSITORY=${ZELAVIS_APT_REPOSITORY:-https://apt.zelavis.com}
APT_SUITE=${ZELAVIS_APT_SUITE:-stable}
DOWNLOADS=${ZELAVIS_DOWNLOADS:-https://downloads.zelavis.com/latest}
KEYRING=/usr/share/keyrings/zelavis-archive-keyring.gpg
SOURCE_FILE=/etc/apt/sources.list.d/zelavis.sources

if [ "$(id -u)" -ne 0 ]; then
  echo "The quick installer must run as root. Pipe it to sudo sh." >&2
  exit 1
fi

install_with_apt() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl
  install -d -m 0755 /usr/share/keyrings /etc/apt/sources.list.d
  curl -fsSL "$APT_REPOSITORY/zelavis-archive-keyring.gpg" -o "$KEYRING"
  chmod 0644 "$KEYRING"
  cat > "$SOURCE_FILE" <<EOF
Types: deb
URIs: $APT_REPOSITORY
Suites: $APT_SUITE
Components: main
Signed-By: $KEYRING
EOF
  apt-get update
  apt-get install -y zelavis
}

install_with_archive() {
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$(uname -m)" in
    x86_64|amd64) architecture=x64 ;;
    aarch64|arm64) architecture=arm64 ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  case "$os" in
    linux|darwin) ;;
    *) echo "Unsupported operating system: $os" >&2; exit 1 ;;
  esac

  temporary=$(mktemp -d)
  trap 'rm -rf "$temporary"' EXIT INT TERM
  archive="$temporary/zelavis.tar.gz"
  checksum="$temporary/zelavis.tar.gz.sha256"
  url="$DOWNLOADS/zelavis-$os-$architecture.tar.gz"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$archive"
    curl -fsSL "$url.sha256" -o "$checksum"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$archive" "$url"
    wget -qO "$checksum" "$url.sha256"
  else
    echo "Install curl or wget, then run the installer again." >&2
    exit 1
  fi
  expected=$(awk 'NR == 1 { print $1 }' "$checksum")
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$archive" | awk '{ print $1 }')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$archive" | awk '{ print $1 }')
  else
    echo "A SHA-256 checksum utility is required." >&2
    exit 1
  fi
  if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
    echo "Zelavis archive checksum verification failed." >&2
    exit 1
  fi
  tar -xzf "$archive" -C "$temporary"
  extracted=$(find "$temporary" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  "$extracted/install.sh"
}

if [ -f /etc/os-release ]; then
  . /etc/os-release
fi

case "${ID:-}" in
  debian|ubuntu) install_with_apt ;;
  *) install_with_archive ;;
esac

echo "Zelavis installed. Packaged Linux installs are started through systemd."
echo "Dashboard: http://127.0.0.1:3000/zelavis"
