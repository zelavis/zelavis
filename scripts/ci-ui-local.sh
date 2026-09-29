#!/usr/bin/env bash
# Runs the dashboard smoke e2e locally the way CI does, against a throwaway
# Platform: a fresh data directory, a generated bootstrap token and a generated
# owner password. Nothing is read from or written to your own installation, and
# the credentials only exist for this run.
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
  [ -n "$runtime_pid" ] && kill "$runtime_pid" 2>/dev/null || true
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

curl --fail --silent --request POST \
  --header "content-type: application/json" \
  --data "{\"bootstrapToken\":\"$ZELAVIS_BOOTSTRAP_TOKEN\",\"provider\":\"password\",\"account\":{\"email\":\"ci@example.com\",\"displayName\":\"Zelavis E2E\"},\"credential\":{\"identifier\":\"ci@example.com\",\"password\":\"$ZELAVIS_E2E_OWNER_PASSWORD\"}}" \
  http://127.0.0.1:3000/zelavis/api/v1/auth/bootstrap >"$scratch/owner.json"

token="$(node -p "require('$scratch/owner.json').session.token")"
curl --fail --silent --request POST \
  --header "content-type: application/json" \
  --header "authorization: Bearer $token" \
  --data '{"id":"dashboard-e2e","name":"Zelavis Runtime","start":true}' \
  http://127.0.0.1:3000/zelavis/api/v1/runtime/projects >/dev/null

ZELAVIS_E2E_SESSION_TOKEN="$token" pnpm run ci:ui
