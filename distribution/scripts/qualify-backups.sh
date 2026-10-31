#!/usr/bin/env bash
# Release gate: backups of a managed app and restore drills on a separate machine. A WordPress Project is made on
# the packed candidate with this checkout's recipes, backed up through its Project's backup schedule to an off-site
# target (a volume only the two machines share), drilled and restored there; then a second, fresh machine that has
# nothing of the first but the target and the recovery key drills the same run. All host mutations stay inside
# disposable Debian/systemd, each with 2 CPUs and 4 GiB.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${ZELAVIS_PROVISIONING_IMAGE:-zelavis-wordpress-systemd-test}"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/zelavis-backups.XXXXXX")
NAME="zelavis-backups-$(basename "$STAGE" | tr 'A-Z' 'a-z')"
OFFSITE="$NAME-offsite"
failed=yes
cleanup() {
  if [[ "$failed" == yes && -n "${ZELAVIS_HARNESS_KEEP:-}" ]]; then printf 'Kept the failed containers: %s-primary %s-elsewhere\n' "$NAME" "$NAME" >&2
  else docker rm -f "$NAME-primary" "$NAME-elsewhere" >/dev/null 2>&1 || true; docker volume rm "$OFFSITE" >/dev/null 2>&1 || true; fi
  rm -rf "$STAGE"
}
trap cleanup EXIT
docker build -q -t "$IMAGE" -f "$REPO_ROOT/zelavis-services/wordpress/scripts/Dockerfile.provisioning" "$REPO_ROOT/zelavis-services/wordpress/scripts" >/dev/null
(cd "$REPO_ROOT" && pnpm --filter zelavis pack --pack-destination "$STAGE" >/dev/null)
mv "$STAGE"/zelavis-*.tgz "$STAGE/zelavis.tgz"
docker volume create "$OFFSITE" >/dev/null
machine() {
  docker run -d --name "$NAME-$1" --cpus 2 --memory 4g --memory-swap 4g --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
    --mount "type=bind,source=$REPO_ROOT,target=/workspace,readonly" \
    --mount "type=bind,source=$STAGE,target=/input,readonly" \
    --mount "type=volume,source=$OFFSITE,target=/srv/offsite" \
    -e ZELAVIS_PROVISIONING_DISPOSABLE=1 "$IMAGE" /sbin/init >/dev/null
  for attempt in $(seq 1 60); do
    state=$(docker exec "$NAME-$1" systemctl is-system-running 2>/dev/null || true)
    [[ "$state" == running || "$state" == degraded ]] && break
    sleep 1
  done
  if ! docker exec "$NAME-$1" sh /workspace/distribution/scripts/qualify-backups-host.sh "$1"; then
    docker exec "$NAME-$1" sh -c 'journalctl -u zelavis.service -u zelavis-agent.service -u zelavis-host-agent.service -n 300 --no-pager | grep -v php_invoke | tail -80' || true
    exit 1
  fi
}
machine primary
# The recovery key leaves the first machine the way an operator keeps it: off that host, never at the target.
docker cp "$NAME-primary:/var/lib/zelavis/backup-handoff.json" "$STAGE/handoff.json"
# The first machine is gone before the second looks: nothing of it but the target remains.
docker rm -f "$NAME-primary" >/dev/null
machine elsewhere
failed=no
