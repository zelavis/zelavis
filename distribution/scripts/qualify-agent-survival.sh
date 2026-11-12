#!/usr/bin/env bash
# Linux production recovery tests plus disposable systemd restart/cgroup proofs.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${ZELAVIS_QUALIFY_IMAGE:-zelavis-systemd-test}"
CONTAINER="zelavis-agent-survival-$$"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
if [[ -z "${ZELAVIS_QUALIFY_IMAGE:-}" ]]; then
  docker build -q -t "$IMAGE" -f "$REPO_ROOT/distribution/scripts/Dockerfile.systemd" "$REPO_ROOT/distribution/scripts" >/dev/null
fi
docker run -d --name "$CONTAINER" --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
  --mount "type=bind,source=$REPO_ROOT,target=/workspace,readonly" \
  -e ZELAVIS_QUALIFY_DISPOSABLE=1 "$IMAGE" /sbin/init >/dev/null
for attempt in $(seq 1 60); do
  state=$(docker exec "$CONTAINER" systemctl is-system-running 2>/dev/null || true)
  [[ "$state" == running || "$state" == degraded ]] && break
  sleep 1
done
docker exec -e ZELAVIS_QUALIFY_DISPOSABLE=1 "$CONTAINER" sh /workspace/distribution/scripts/agent-survival-host.sh

# Real production runner/daemon/client tests on the installer-pinned Node. The
# macOS workspace suite skips Linux procfs tests, so release qualification runs
# them explicitly here, against built files through a read-only mount.
NODE_VERSION=$(sed -n 's/.*"nodeVersion": "\([^"]*\)".*/\1/p' "$REPO_ROOT/distribution/release.json")
docker run --rm --init --mount "type=bind,source=$REPO_ROOT,target=/workspace,readonly" -w /workspace \
  "node:$NODE_VERSION-bookworm" node --test packages/zelavis/test/agent-survivable-runner.test.mjs
