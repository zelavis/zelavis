#!/usr/bin/env bash
# Qualifies the worker role end to end in a disposable Debian/systemd container: the real
# installer, real accounts, real systemd units, a real enrollment into a real Platform
# runtime, an update and complete removal. Builds must already have passed. Needs Docker
# and network (nodejs.org for the pinned Node, npm for dependencies).
set -euo pipefail
REPO_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
IMAGE="${ZELAVIS_QUALIFY_IMAGE:-zelavis-systemd-test}"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/zelavis-worker-qualification.XXXXXX")
CONTAINER="zelavis-worker-qualification-$(basename "$STAGE")"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$STAGE"; }
trap cleanup EXIT
if [[ -z "${ZELAVIS_QUALIFY_IMAGE:-}" ]]; then
  docker build -q -t "$IMAGE" -f "$REPO_ROOT/distribution/scripts/Dockerfile.systemd" "$REPO_ROOT/distribution/scripts" >/dev/null
fi
(cd "$REPO_ROOT" && pnpm --filter zelavis pack --pack-destination "$STAGE" >/dev/null)
mv "$STAGE"/zelavis-*.tgz "$STAGE/zelavis.tgz"
docker run -d --name "$CONTAINER" --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
  --mount "type=bind,source=$REPO_ROOT,target=/workspace,readonly" \
  --mount "type=bind,source=$STAGE,target=/input,readonly" \
  -e ZELAVIS_QUALIFY_DISPOSABLE=1 "$IMAGE" /sbin/init >/dev/null
for attempt in $(seq 1 60); do
  state=$(docker exec "$CONTAINER" systemctl is-system-running 2>/dev/null || true)
  [[ "$state" == running || "$state" == degraded ]] && break
  sleep 1
done
if ! docker exec -e ZELAVIS_QUALIFY_DISPOSABLE=1 "$CONTAINER" sh /workspace/distribution/scripts/worker-host.sh; then
  docker exec "$CONTAINER" journalctl -u zelavis-worker.service -u zelavis-worker.path -n 40 --no-pager || true
  docker exec "$CONTAINER" cat /tmp/platform.log 2>/dev/null | tail -20 || true
  exit 1
fi
