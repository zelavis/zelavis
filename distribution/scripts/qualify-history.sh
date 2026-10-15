#!/usr/bin/env bash
# Release gate: a server with a history. Apps made by old releases, opened in the dashboard, carried forward
# by live updates through distribution/history.json and the previous published release, then onto the packed
# candidate, where every recipe upgrade must answer every request. All host mutations stay inside disposable
# Debian/systemd.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${ZELAVIS_PROVISIONING_IMAGE:-zelavis-wordpress-systemd-test}"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/zelavis-history.XXXXXX")
CONTAINER="zelavis-history-$(basename "$STAGE")"
failed=yes
cleanup() {
  if [[ "$failed" == yes && -n "${ZELAVIS_HARNESS_KEEP:-}" ]]; then printf 'Kept the failed container: %s\n' "$CONTAINER" >&2; else docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
  rm -rf "$STAGE"
}
trap cleanup EXIT
PREVIOUS="${ZELAVIS_HISTORY_PREVIOUS:-$(node -e 'fetch("https://registry.npmjs.org/-/package/zelavis/dist-tags").then(r=>r.json()).then(v=>{if(!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v.alpha))throw Error("Invalid channel");process.stdout.write(v.alpha)})')}"
docker build -q -t "$IMAGE" -f "$REPO_ROOT/zelavis-services/wordpress/scripts/Dockerfile.provisioning" "$REPO_ROOT/zelavis-services/wordpress/scripts" >/dev/null
(cd "$REPO_ROOT" && pnpm --filter zelavis pack --pack-destination "$STAGE" >/dev/null)
mv "$STAGE"/zelavis-*.tgz "$STAGE/zelavis.tgz"
docker run -d --name "$CONTAINER" --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
  --mount "type=bind,source=$REPO_ROOT,target=/workspace,readonly" \
  --mount "type=bind,source=$STAGE,target=/input,readonly" \
  -e ZELAVIS_PROVISIONING_DISPOSABLE=1 -e "ZELAVIS_HISTORY_PREVIOUS=$PREVIOUS" \
  "$IMAGE" /sbin/init >/dev/null
for attempt in $(seq 1 60); do
  state=$(docker exec "$CONTAINER" systemctl is-system-running 2>/dev/null || true)
  [[ "$state" == running || "$state" == degraded ]] && break
  sleep 1
done
if ! docker exec "$CONTAINER" sh /workspace/distribution/scripts/qualify-history-host.sh; then
  docker exec "$CONTAINER" sh -c 'journalctl -u zelavis.service -u zelavis-agent.service -n 300 --no-pager | grep -v php_invoke | tail -80' || true
  exit 1
fi
failed=no
