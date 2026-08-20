#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DISTRIBUTION_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ARTIFACTS_DIR=${ZELAVIS_ARTIFACTS_DIR:-$DISTRIBUTION_DIR/artifacts}
REPOSITORY_DIR=${ZELAVIS_APT_OUTPUT:-$ARTIFACTS_DIR/apt}
SUITE=${ZELAVIS_APT_SUITE:-stable}
KEY_ID=${ZELAVIS_GPG_KEY_ID:-}

for command in dpkg-scanpackages apt-ftparchive gpg gzip; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command" >&2
    exit 1
  fi
done

if [ -z "$KEY_ID" ]; then
  echo "Set ZELAVIS_GPG_KEY_ID to the release signing key." >&2
  exit 1
fi

rm -rf "$REPOSITORY_DIR"
mkdir -p "$REPOSITORY_DIR/pool/main/z/zelavis"
found=0
for package in "$ARTIFACTS_DIR"/zelavis_[0-9]*_*.deb; do
  if [ ! -f "$package" ]; then
    continue
  fi
  cp "$package" "$REPOSITORY_DIR/pool/main/z/zelavis/"
  found=1
done
if [ "$found" -ne 1 ]; then
  echo "No Zelavis .deb artifacts found in $ARTIFACTS_DIR." >&2
  exit 1
fi

architectures=""
for package in "$REPOSITORY_DIR"/pool/main/z/zelavis/*.deb; do
  architecture=$(dpkg-deb -f "$package" Architecture)
  case " $architectures " in
    *" $architecture "*) ;;
    *) architectures="$architectures $architecture" ;;
  esac
done

for architecture in $architectures; do
  binary_dir="$REPOSITORY_DIR/dists/$SUITE/main/binary-$architecture"
  mkdir -p "$binary_dir"
  (
    cd "$REPOSITORY_DIR"
    dpkg-scanpackages --arch "$architecture" pool/main > "dists/$SUITE/main/binary-$architecture/Packages"
  )
  gzip -9 -c "$binary_dir/Packages" > "$binary_dir/Packages.gz"
done

(
  cd "$REPOSITORY_DIR"
  apt-ftparchive \
    -o "APT::FTPArchive::Release::Origin=Zelavis" \
    -o "APT::FTPArchive::Release::Label=Zelavis" \
    -o "APT::FTPArchive::Release::Suite=$SUITE" \
    -o "APT::FTPArchive::Release::Codename=$SUITE" \
    -o "APT::FTPArchive::Release::Architectures=${architectures# }" \
    -o "APT::FTPArchive::Release::Components=main" \
    release "dists/$SUITE" > "dists/$SUITE/Release"
  gpg --batch --yes --local-user "$KEY_ID" --clearsign \
    --output "dists/$SUITE/InRelease" "dists/$SUITE/Release"
  gpg --batch --yes --local-user "$KEY_ID" --armor --detach-sign \
    --output "dists/$SUITE/Release.gpg" "dists/$SUITE/Release"
  gpg --batch --yes --export "$KEY_ID" > zelavis-archive-keyring.gpg
)

echo "Built signed APT repository: $REPOSITORY_DIR"
