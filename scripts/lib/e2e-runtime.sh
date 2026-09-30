# Shared by the local e2e scripts. Sourced, not executed.
#
# These scripts only ever start and stop what they started themselves: they pick
# free ports instead of claiming 3000/3100, and stop their own process group
# rather than killing whatever is listening or matching a command line, so a
# development server you have running is never touched.

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

# start_e2e_runtime: fresh data directory, generated credentials, own ports.
# Sets scratch, runtime_pid, RUNTIME_PORT, UI_PORT and the ZELAVIS_* variables.
start_e2e_runtime() {
  scratch="$(mktemp -d)"
  runtime_pid=""
  RUNTIME_PORT="$(free_port)"
  UI_PORT="$(free_port)"
  export RUNTIME_PORT UI_PORT
  export PORT="$RUNTIME_PORT"
  export ZELAVIS_DEV_SERVER="http://127.0.0.1:$RUNTIME_PORT"
  export ZELAVIS_E2E_RUNTIME_ORIGIN="$ZELAVIS_DEV_SERVER"
  export ZELAVIS_E2E_UI_PORT="$UI_PORT"
  export ZELAVIS_BOOTSTRAP_TOKEN="$(openssl rand -hex 24)"
  export ZELAVIS_E2E_OWNER_PASSWORD="$(openssl rand -hex 12)"
  export ZELAVIS_DATA_DIR="$scratch/data"

  # Job control gives the runtime its own process group, so stopping it also
  # stops the pnpm and node children it spawned, and nothing else.
  set -m
  pnpm --filter @zelavis/example-nodejs dev >"$scratch/runtime.log" 2>&1 &
  runtime_pid=$!
  set +m

  for _ in $(seq 1 60); do
    curl -s -o /dev/null "$ZELAVIS_DEV_SERVER/zelavis" && return 0
    sleep 1
  done
  echo "The e2e runtime did not start; see $scratch/runtime.log" >&2
  return 1
}

stop_e2e_runtime() {
  if [ -n "${runtime_pid:-}" ]; then
    kill -TERM -- "-$runtime_pid" 2>/dev/null || kill -TERM "$runtime_pid" 2>/dev/null || true
  fi
  [ -n "${scratch:-}" ] && rm -rf "$scratch"
}
