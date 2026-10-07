#!/bin/sh
# Invoked only inside the disposable systemd container by qualify-worker.sh.
# Installs the packed candidate as a worker with the real installer, and checks
# what the real host did: accounts, units, ownership, a real enrollment into a
# real Platform, an update, the refusals, and complete removal.
set -eu
[ "${ZELAVIS_QUALIFY_DISPOSABLE:-}" = 1 ] && [ -e /.dockerenv ] || exit 2

pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }
check() { description=$1; shift; if "$@" >/dev/null 2>&1; then pass "$description"; else fail "$description"; fi; }
refute() { description=$1; shift; if "$@" >/dev/null 2>&1; then fail "$description"; else pass "$description"; fi; }
wait_for() { description=$1; seconds=$2; shift 2; n=0; while ! "$@" >/dev/null 2>&1; do n=$((n + 1)); [ "$n" -le "$seconds" ] || fail "$description (timed out after ${seconds}s)"; sleep 1; done; pass "$description"; }

cd /opt
node_version=$(sed -n 's/.*"nodeVersion": "\([^"]*\)".*/\1/p' /workspace/distribution/release.json)
case "$(uname -m)" in aarch64) architecture=arm64 ;; x86_64) architecture=x64 ;; *) exit 2 ;; esac
archive="node-v$node_version-linux-$architecture.tar.gz"
mkdir -p /opt/prepared/runtime /opt/npm-project
curl -fsSL "https://nodejs.org/dist/v$node_version/$archive" -o "$archive"
curl -fsSL "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o SHASUMS256.txt
sed -n "/ $archive\$/p" SHASUMS256.txt > node.sha256
test -s node.sha256
sha256sum -c node.sha256 >/dev/null
tar --no-same-owner -xzf "$archive" -C /opt/prepared/runtime
mv "/opt/prepared/runtime/node-v$node_version-linux-$architecture" /opt/prepared/runtime/node
NODE=/opt/prepared/runtime/node/bin/node
NPM=/opt/prepared/runtime/node/lib/node_modules/npm/bin/npm-cli.js
printf '{"private":true}\n' > /opt/npm-project/package.json
"$NODE" "$NPM" install --prefix /opt/npm-project --registry=https://registry.npmjs.org --ignore-scripts --omit=dev --no-audit --no-fund /input/zelavis.tgz >/dev/null
mv /opt/npm-project/node_modules/zelavis /opt/prepared/platform
mv /opt/npm-project/node_modules /opt/prepared/platform/node_modules
ln -s .. /opt/prepared/platform/node_modules/zelavis
CLI="$NODE /opt/prepared/platform/dist/cli.js"

echo "== dry run changes nothing"
$CLI install --role worker --from-npm /opt/prepared --dry-run > /tmp/dry-run.txt
check "the dry run lists the worker units" grep -q 'zelavis-worker.service' /tmp/dry-run.txt
refute "the dry run created no prefix" test -e /opt/zelavis
refute "the dry run created no account" getent passwd zelavis-worker

echo "== Platform-only flags are refused by name"
refute "--port is refused for a worker" $CLI install --role worker --from-npm /opt/prepared --port 3100
refute "--user is refused for a worker" $CLI install --role worker --from-npm /opt/prepared --user

echo "== install"
$CLI install --role worker --from-npm /opt/prepared > /opt/worker-install.log 2>&1 || { cat /opt/worker-install.log; fail "the worker installs"; }
pass "the worker installs"
check "the dedicated user exists with the data directory as home and no login shell" sh -c 'getent passwd zelavis-worker | grep -q ":/var/lib/zelavis-worker:/usr/sbin/nologin$"'
check "the dedicated group exists" getent group zelavis-worker
check "the data directory is private and owned by the worker" sh -c '[ "$(stat -c "%a %U" /var/lib/zelavis-worker)" = "700 zelavis-worker" ]'
check "the receipt is private" sh -c '[ "$(stat -c "%a" /opt/zelavis/installation.json)" = "600" ]'
check "the receipt records the account as installer-owned" sh -c 'grep -q "\"ownsUser\": true" /opt/zelavis/installation.json && grep -q "\"ownsGroup\": true" /opt/zelavis/installation.json'
check "the release is owned by root" sh -c '[ "$(stat -c "%U" /opt/zelavis/releases/*)" = root ]'
check "the command link points into the prefix" sh -c 'readlink /usr/local/bin/zelavis | grep -q "^/opt/zelavis/"'
check "the path unit is enabled and waiting" sh -c 'systemctl is-enabled zelavis-worker.path && systemctl is-active zelavis-worker.path'
refute "the Agent is not running before the machine has joined" systemctl is-active zelavis-worker.service
refute "the unit ran nothing, so no Platform unit exists" test -e /etc/systemd/system/zelavis.service
check "the receipt records the worker role" grep -q '"role": "worker"' /opt/zelavis/installation.json
unit=/etc/systemd/system/zelavis-worker.service
check "the unit runs as the worker" grep -q '^User=zelavis-worker$' "$unit"
check "the unit points at the configuration join writes" grep -q 'remote-project-config /var/lib/zelavis-worker/worker/remote-project.json' "$unit"
# A positive control first: the same check must be able to find a fault in a unit that has one.
printf '[Service]\nExecStart=not-an-absolute-path\n' > /tmp/broken.service
check "the unit verifier can find a fault (control)" sh -c 'systemd-analyze verify /tmp/broken.service 2>&1 | grep -qi "absolute\|error\|bad\|unknown"'
refute "systemd finds nothing wrong with the worker unit" sh -c 'systemd-analyze verify /etc/systemd/system/zelavis-worker.service 2>&1 | grep -i "absolute\|error\|bad\|unknown"'

echo "== a machine is a Platform or a worker"
if out=$($CLI install --from-npm /opt/prepared 2>&1); then fail "installing a Platform on a worker is refused"; fi
printf '%s' "$out" | grep -q 'machine is a Zelavis worker' && pass "installing a Platform on a worker is refused, and says why" || { printf '%s\n' "$out" >&2; fail "the Platform refusal explains itself"; }

echo "== join a real Platform, as the worker's own account"
ZELAVIS_QUALIFY_DISPOSABLE=1 $NODE /workspace/distribution/scripts/worker-platform-harness.mjs > /tmp/platform.log 2>&1 &
wait_for "the harness Platform is serving" 90 test -s /tmp/platform.json
url=$($NODE -p 'require("/tmp/platform.json").url')
fingerprint=$($NODE -p 'require("/tmp/platform.json").fingerprint')
token=$($NODE -p 'require("/tmp/platform.json").token')
refute "a wrong fingerprint is refused and the credential is not spent" runuser -u zelavis-worker -- /usr/local/bin/zelavis worker join --data-dir /var/lib/zelavis-worker --platform-url "$url" --platform-fingerprint 0000000000000000000000000000000000000000000000000000000000000000 --node-id worker-1 --enrollment-token "$token" --address 127.0.0.1
refute "still not running after a refused join" systemctl is-active zelavis-worker.service
runuser -u zelavis-worker -- /usr/local/bin/zelavis worker join --data-dir /var/lib/zelavis-worker --platform-url "$url" --platform-fingerprint "$fingerprint" --node-id worker-1 --enrollment-token "$token" --address 127.0.0.1 > /tmp/join.log 2>&1 || { cat /tmp/join.log; fail "the worker joins"; }
pass "the worker joins with the same credential after the refused attempt"
check "the Agent's key is private and its own" sh -c '[ "$(stat -c "%a %U" /var/lib/zelavis-worker/worker/agent.key)" = "600 zelavis-worker" ]'
check "the join output never contains the credential" sh -c '! grep -q "$0" /tmp/join.log' "$token"
wait_for "systemd starts the Agent by itself once the machine has joined" 60 systemctl is-active zelavis-worker.service
pid=$(systemctl show -p MainPID --value zelavis-worker.service)
[ "$(stat -c %U "/proc/$pid")" = zelavis-worker ] && pass "the Agent runs as the worker, not root" || fail "the Agent runs as the worker, not root"
wait_for "the Platform's own inventory reports the node ready" 90 sh -c '[ "$(cat /tmp/node-status 2>/dev/null)" = ready ]'

echo "== update: installing again swaps the release and restarts the running Agent"
before=$(systemctl show -p MainPID --value zelavis-worker.service)
$CLI install --role worker --from-npm /opt/prepared > /opt/worker-update.log 2>&1 || { cat /opt/worker-update.log; fail "the worker updates"; }
pass "the worker updates"
wait_for "the Agent is running again" 30 systemctl is-active zelavis-worker.service
after=$(systemctl show -p MainPID --value zelavis-worker.service)
[ "$before" != "$after" ] && pass "the Agent was restarted (pid $before -> $after)" || fail "the Agent was restarted"
check "the account is still recorded as installer-owned" grep -q '"ownsUser": true' /opt/zelavis/installation.json
wait_for "the node is ready again after the restart" 90 sh -c '[ "$(cat /tmp/node-status 2>/dev/null)" = ready ]'

echo "== complete removal"
/usr/local/bin/zelavis uninstall --all --dry-run > /tmp/uninstall-plan.txt 2>&1 || { cat /tmp/uninstall-plan.txt; fail "the removal plan is inspectable"; }
check "the plan names the worker's data" grep -q '/var/lib/zelavis-worker' /tmp/uninstall-plan.txt
check "the plan names the worker's units" grep -q 'zelavis-worker' /tmp/uninstall-plan.txt
check "a dry run removed nothing" test -e /var/lib/zelavis-worker/worker/agent.key
refute "removal without the acknowledgement is refused" /usr/local/bin/zelavis uninstall --all
check "the Agent is still running after the refusals" systemctl is-active zelavis-worker.service
/usr/local/bin/zelavis uninstall --all --confirm DELETE-ALL-ZELAVIS-DATA > /tmp/uninstall.log 2>&1 || { cat /tmp/uninstall.log; fail "complete removal"; }
pass "complete removal"
refute "the Agent is stopped" systemctl is-active zelavis-worker.service
refute "the path unit is stopped" systemctl is-active zelavis-worker.path
refute "no worker unit file remains" sh -c 'ls /etc/systemd/system /lib/systemd/system 2>/dev/null | grep -q zelavis-worker'
refute "no worker unit is known to systemd" sh -c 'systemctl list-unit-files 2>/dev/null | grep -q zelavis-worker'
refute "the data directory is gone" test -e /var/lib/zelavis-worker
refute "the prefix is gone" test -e /opt/zelavis
refute "the command link is gone" test -e /usr/local/bin/zelavis
refute "the installer-created user is gone" getent passwd zelavis-worker
refute "the installer-created group is gone" getent group zelavis-worker
check "the harness Platform was not disturbed" kill -0 "$(pgrep -f worker-platform-harness | head -1)"
printf 'PASS: worker install, real enrollment, update, refusals and complete removal.\n'
