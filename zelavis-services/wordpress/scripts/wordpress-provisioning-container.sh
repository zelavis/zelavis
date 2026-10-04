#!/usr/bin/env bash
# Builds must already have passed. All host mutations happen inside disposable Debian/systemd.
set -euo pipefail
REPO_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
IMAGE="${ZELAVIS_PROVISIONING_IMAGE:-zelavis-wordpress-systemd-test}"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/zelavis-wordpress-qualification.XXXXXX")
CONTAINER="zelavis-wordpress-qualification-$(basename "$STAGE")"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$STAGE"; }
trap cleanup EXIT
if [[ -z "${ZELAVIS_PROVISIONING_IMAGE:-}" ]]; then
  docker build -t "$IMAGE" -f "$REPO_ROOT/zelavis-services/wordpress/scripts/Dockerfile.provisioning" "$REPO_ROOT/zelavis-services/wordpress/scripts"
fi
if [[ -z "${ZELAVIS_PROVISIONING_FROM_NPM:-}" || "${ZELAVIS_QUALIFY_UPDATE:-}" == local ]]; then
  (cd "$REPO_ROOT" && pnpm --filter zelavis pack --pack-destination "$STAGE")
  mv "$STAGE"/zelavis-*.tgz "$STAGE/zelavis.tgz"
fi
docker run -d --name "$CONTAINER" --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
  --mount "type=bind,source=$REPO_ROOT,target=/workspace,readonly" \
  --mount "type=bind,source=$STAGE,target=/input,readonly" \
  -e ZELAVIS_PROVISIONING_DISPOSABLE=1 -e "ZELAVIS_PROVISIONING_FROM_NPM=${ZELAVIS_PROVISIONING_FROM_NPM:-}" \
  -e "ZELAVIS_QUALIFY_UPDATE=${ZELAVIS_QUALIFY_UPDATE:-}" \
  "$IMAGE" /sbin/init >/dev/null
# Init needs a moment to establish its cgroup hierarchy. Bounded readiness, no host service changes.
for attempt in $(seq 1 60); do
  state=$(docker exec "$CONTAINER" systemctl is-system-running 2>/dev/null || true)
  [[ "$state" == running || "$state" == degraded ]] && break
  sleep 1
done
if ! docker exec "$CONTAINER" sh /workspace/zelavis-services/wordpress/scripts/provisioning-host.sh; then
  docker exec "$CONTAINER" journalctl -u zelavis.service -u zelavis-agent.service -u zelavis-host-agent.service -n 60 --no-pager || true
  exit 1
fi
if [[ -n "${ZELAVIS_UPDATE_PROOF:-}" ]]; then
  docker cp "$CONTAINER:/tmp/zelavis-update-proof.json" "$ZELAVIS_UPDATE_PROOF"
fi
