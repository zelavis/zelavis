#!/usr/bin/env bash
# Real systemd qualification for every installer entry and ordered entry pair,
# followed by App-bearing instance isolation, live updates and both removal orders.
# Builds must already have passed. All installation mutations stay in owned guests.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/zelavis-installer-matrix.XXXXXX")
PROOFS="${ZELAVIS_QUALIFY_PROOF_DIR:-$REPO_ROOT/distribution/.tmp/installer-matrix/$(basename "$STAGE")}"
CONTAINER=
failed=yes
cleanup() {
  if [[ -n "$CONTAINER" ]]; then
    if [[ "$failed" == yes && "${ZELAVIS_HARNESS_KEEP:-0}" == 1 ]]; then
      printf 'Kept failed qualification guest: %s\n' "$CONTAINER" >&2
      printf 'Kept qualification inputs: %s\n' "$STAGE" >&2
      return
    else docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
  fi
  rm -rf "$STAGE"
}
trap cleanup EXIT
case "$(docker info --format '{{.Architecture}}')" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) printf 'Unsupported Docker host architecture.\n' >&2; exit 1 ;;
esac
mkdir -p "$PROOFS"
TARGET=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version)' "$REPO_ROOT/packages/zelavis/package.json")
BASELINE="${ZELAVIS_QUALIFY_BASELINE:-2.0.0-alpha.40}"
(cd "$REPO_ROOT" && pnpm --filter create-zelavis pack --pack-destination "$STAGE" > "$PROOFS/create-pack.log" 2>&1)
mv "$STAGE"/create-zelavis-*.tgz "$STAGE/create-zelavis.tgz"
(cd "$REPO_ROOT" && node --input-type=module - "$STAGE" "$ARCH" <<'JS'
import { installNodeRuntime } from './distribution/scripts/runtime-assets.mjs';
import { readFile } from 'node:fs/promises';
const [stage, architecture] = process.argv.slice(2);
const release = JSON.parse(await readFile('distribution/release.json', 'utf8'));
await installNodeRuntime(stage, release.nodeVersion, { platform: 'linux', architecture }, stage + '/cache');
JS
)
for DISTRO in ${ZELAVIS_QUALIFY_DISTROS:-debian ubuntu}; do
  case "$DISTRO" in
    debian) BASE=debian:bookworm-slim ;;
    ubuntu) BASE=ubuntu:24.04 ;;
    *) printf 'Choose debian and/or ubuntu.\n' >&2; exit 1 ;;
  esac
  IMAGE="zelavis-installer-matrix-$DISTRO-$ARCH"
  docker build -q --build-arg "SYSTEMD_BASE=$BASE" -t "$IMAGE" -f "$REPO_ROOT/distribution/scripts/Dockerfile.systemd" "$REPO_ROOT/distribution/scripts" > "$PROOFS/$DISTRO-build.log" 2>&1
  INPUT="$STAGE/$DISTRO"
  mkdir "$INPUT"
  cp "$STAGE/create-zelavis.tgz" "$INPUT/"
  cp "$REPO_ROOT/distribution/installers/install.sh" "$INPUT/install.sh"
  cp "$REPO_ROOT/distribution/scripts/build-deb.mjs" "$INPUT/"
  cp "$REPO_ROOT/distribution/scripts/qualify-installer-matrix.mjs" "$INPUT/"
  [[ ! -f "$STAGE/zelavis.deb" ]] || cp "$STAGE/zelavis.deb" "$INPUT/zelavis.deb"
  node - "$INPUT/qualification.json" "$TARGET" "$BASELINE" "$ARCH" <<'JS'
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { dirname, join } = require('node:path');
const [file, target, baseline, architecture] = process.argv.slice(2);
const deb = join(dirname(file), 'zelavis.deb');
const debSha256 = fs.existsSync(deb) ? createHash('sha256').update(fs.readFileSync(deb)).digest('hex') : undefined;
fs.writeFileSync(file, JSON.stringify({ target, baseline, architecture, debSha256, phase: process.env.ZELAVIS_QUALIFY_PHASE ?? 'all' }));
JS
  CONTAINER="zelavis-installer-matrix-$DISTRO-$(basename "$STAGE")"
  docker run -d --name "$CONTAINER" --cpus 2 --memory 3g --memory-swap 3g --pids-limit 2048 --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
    --mount "type=bind,source=$INPUT,target=/input,readonly" \
    --mount "type=bind,source=$STAGE/runtime/node,target=/seed-node,readonly" \
    -e ZELAVIS_QUALIFY_DISPOSABLE=1 "$IMAGE" /sbin/init >/dev/null
  for attempt in $(seq 1 60); do
    state=$(docker exec "$CONTAINER" systemctl is-system-running 2>/dev/null || true)
    [[ "$state" == running || "$state" == degraded ]] && break
    sleep 1
  done
  result=0
  docker exec "$CONTAINER" /seed-node/bin/node --disable-warning=ExperimentalWarning /input/qualify-installer-matrix.mjs > "$PROOFS/$DISTRO-$ARCH.log" 2>&1 || result=$?
  docker cp "$CONTAINER:/qualification/proof.json" "$PROOFS/$DISTRO-$ARCH.json" >/dev/null 2>&1 || true
  cat "$PROOFS/$DISTRO-$ARCH.log"
  [[ "$result" == 0 ]] || exit "$result"
  DEB=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).deb ?? "")' "$PROOFS/$DISTRO-$ARCH.json")
  [[ -z "$DEB" ]] || docker cp "$CONTAINER:$DEB" "$STAGE/zelavis.deb" >/dev/null
  docker rm -f "$CONTAINER" >/dev/null
  CONTAINER=
done
failed=no
printf 'Qualification proof: %s\n' "$PROOFS"
