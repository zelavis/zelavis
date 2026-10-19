#!/bin/sh
# Primitive systemd/cgroup proof, deliberately separate from release qualification.
set -eu
[ "${ZELAVIS_QUALIFY_DISPOSABLE:-}" = 1 ] && [ "$(id -u)" = 0 ] && [ -f /.dockerenv ] || exit 1
root=/run/zelavis-agent-survival
unit=zelavis-agent-survival.service
mkdir -m 700 "$root"
chown nobody:nogroup "$root"
cat > "$root/agent.sh" <<'AGENT'
#!/bin/sh
set -eu
root=/run/zelavis-agent-survival
base="/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)"
base=${base%/agent}
if [ -f "$root/controllers" ]; then
  mkdir -p "$base/agent" "$base/operations"
  echo $$ > "$base/agent/cgroup.procs"
  echo '+memory +pids' > "$base/cgroup.subtree_control"
fi
if [ -f "$root/child.pid" ] && kill -0 "$(cat "$root/child.pid")" 2>/dev/null; then
  child=$(cat "$root/child.pid")
else
  setsid sh -c 'while :; do echo alive; sleep 0.1; done' >> "$root/output" 2>> "$root/errors" &
  child=$!
  echo "$child" > "$root/child.pid"
fi
stop() {
  kill "$idle" 2>/dev/null || true
  if [ -f "$root/handover" ]; then rm "$root/handover"
  else /bin/kill -TERM -- "-$child" 2>/dev/null || true; fi
  exit 0
}
trap stop TERM INT
echo $$ > "$root/agent.pid"
sleep infinity &
idle=$!
wait "$idle"
AGENT
# Use the authored Project unit with test-only paths, account and KillMode.
# Survivable runner integration will switch the authored KillMode later.
sed -e 's/^User=.*/User=nobody/' -e 's/^Group=.*/Group=nogroup/' \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=$root|" \
  -e "s|^ExecStart=.*|ExecStart=/bin/sh $root/agent.sh|" \
  -e 's/^KillMode=.*/KillMode=process/' -e 's/^RestartSec=.*/RestartSec=0.2/' \
  /workspace/distribution/runtime/zelavis-agent.service > "/etc/systemd/system/$unit"
cat >> "/etc/systemd/system/$unit" <<EOF
[Service]
MemoryMax=128M
TasksMax=64
TimeoutStopSec=5
# Only the negative control enables delegation and subtree controllers.
Delegate=yes
EOF
# Match the Platform's dependency policy: Agent replacement must not stop it.
cat > /etc/systemd/system/zelavis-agent-survival-platform.service <<EOF
[Unit]
After=$unit
Wants=$unit
[Service]
ExecStart=/bin/sleep infinity
EOF
systemctl daemon-reload
systemctl start "$unit" zelavis-agent-survival-platform.service
platform=$(systemctl show zelavis-agent-survival-platform.service -p MainPID --value)
wait_for() {
  attempt=0
  until "$@"; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 100 ] || {
      echo "FAIL condition: $*"
      systemctl --version | head -1
      uname -r
      systemctl show "$unit" -p Result -p ExecMainStatus -p ActiveState
      journalctl -u "$unit" --no-pager -n 25
      exit 1
    }
    sleep 0.1
  done
}
live() { state=$(ps -o stat= -p "$1"); [ -n "$state" ] && [ "${state#Z}" = "$state" ]; }
growing() { [ "$(wc -l < "$root/output")" -gt "$1" ]; }
new_agent() { [ -f "$root/agent.pid" ] && [ "$(cat "$root/agent.pid")" != "$1" ] && systemctl is-active --quiet "$unit"; }
wait_for test -s "$root/agent.pid"
child=$(cat "$root/child.pid")
initial_start=$(awk '{print $22}' "/proc/$child/stat")
initial_cgroup=$(cat "/proc/$child/cgroup")
case "$initial_cgroup" in */zelavis-agent-survival.service) ;; *) echo 'Process-only child escaped its unit'; exit 1;; esac
for operation in restart crash; do
  parent=$(cat "$root/agent.pid")
  before=$(wc -l < "$root/output")
  if [ "$operation" = restart ]; then touch "$root/handover"; systemctl restart "$unit"
  else kill -KILL "$parent"; fi
  wait_for new_agent "$parent"
  wait_for growing "$before"
  live "$child"
  live "$platform"
  [ "$(systemctl show zelavis-agent-survival-platform.service -p MainPID --value)" = "$platform" ]
  [ "$(cat "$root/child.pid")" = "$child" ]
  [ "$(awk '{print $22}' "/proc/$child/stat")" = "$initial_start" ]
  [ "$(cat "/proc/$child/cgroup")" = "$initial_cgroup" ]
  [ "$(systemctl show "$unit" -p MemoryMax --value)" = 134217728 ]
  [ "$(systemctl show "$unit" -p TasksMax --value)" = 64 ]
  group=$(systemctl show "$unit" -p ControlGroup --value)
  [ "$(cat "/sys/fs/cgroup$group/memory.max")" = 134217728 ]
  [ "$(cat "/sys/fs/cgroup$group/pids.max")" = 64 ]
  echo "PASS $operation: child $child and Platform retain PID, start time, output and unit limits"
done
# A marker-less stop must rely on the Agent, not KillMode, for cleanup.
systemctl stop "$unit"
wait_for sh -c '! ps -o stat= -p "$1" | grep -q "^[^Z ]"' sh "$child"
echo 'PASS marker-less stop: workload stopped by Agent trap'
# Test the proposed uninstall ordering too: systemctl kill after stop may fail.
rm "$root/child.pid"
systemctl start "$unit"
wait_for new_agent 0
child=$(cat "$root/child.pid")
touch "$root/handover"
systemctl stop "$unit"
live "$child"
if systemctl kill --kill-who=all "$unit" 2> "$root/kill-error"; then
  wait_for sh -c '! ps -o stat= -p "$1" | grep -q "^[^Z ]"' sh "$child"
  echo 'PASS post-stop systemctl kill removes survivor'
else
  echo "FINDING post-stop systemctl kill refused: $(cat "$root/kill-error")"
  # Kill the cgroup while the unit is active, as a candidate corrected order.
  systemctl start "$unit"
  wait_for new_agent 0
  systemctl kill --kill-who=all --signal=SIGKILL "$unit"
  systemctl stop "$unit"
  wait_for sh -c '! ps -o stat= -p "$1" | grep -q "^[^Z ]"' sh "$child"
  echo 'PASS kill while active, then stop: survivor removed'
fi
# Repeat with the controllers enabled by prepareDelegatedCgroupLayout today.
# A failure here is evidence against the proposal, not a passing release gate.
systemctl stop "$unit"
rm -f "$root/child.pid" "$root/agent.pid"
touch "$root/controllers"
systemctl reset-failed
systemctl start "$unit"
wait_for test -s "$root/agent.pid"
child=$(cat "$root/child.pid")
parent=$(cat "$root/agent.pid")
before=$(wc -l < "$root/output")
touch "$root/handover"
systemctl restart "$unit"
attempt=0
while [ "$(systemctl show "$unit" -p ExecMainStatus --value)" != 219 ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 100 ] || { echo 'Negative control did not reproduce 219/CGROUP'; exit 1; }
  sleep 0.1
done
live "$child"
wait_for growing "$before"
echo 'PASS negative control: enabled subtree controllers reproduce 219/CGROUP with live survivor' 
echo "systemd $(systemctl --version | head -1); kernel $(uname -r)"
