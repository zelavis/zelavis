#!/usr/bin/env bash
# Runs the first-run wizard e2e against a Platform nobody has claimed: a fresh
# data directory and generated credentials that only exist for this run.
set -euo pipefail

cd "$(dirname "$0")/.."

for port in 3000 3100; do
  if lsof -ti ":$port" >/dev/null 2>&1; then
    echo "Port $port is in use; stop what is listening there first." >&2
    exit 1
  fi
done

scratch="$(mktemp -d)"
runtime_pid=""
cleanup() {
  [ -n "$runtime_pid" ] && pkill -P "$runtime_pid" 2>/dev/null || true
  [ -n "$runtime_pid" ] && kill "$runtime_pid" 2>/dev/null || true
  lsof -ti :3000 2>/dev/null | xargs kill 2>/dev/null || true
  pkill -f "react-router dev --host 127.0.0.1 --port 3100" 2>/dev/null || true
  rm -rf "$scratch"
}
trap cleanup EXIT

export ZELAVIS_BOOTSTRAP_TOKEN="$(openssl rand -hex 24)"
export ZELAVIS_E2E_OWNER_PASSWORD="$(openssl rand -hex 12)"
export ZELAVIS_DATA_DIR="$scratch/data"

pnpm --filter @zelavis/example-nodejs dev >"$scratch/runtime.log" 2>&1 &
runtime_pid=$!

for _ in $(seq 1 60); do
  curl -s -o /dev/null http://127.0.0.1:3000/zelavis && break
  sleep 1
done

pnpm --filter @zelavis/ui exec playwright test -c playwright.setup.config.ts
