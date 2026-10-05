#!/usr/bin/env bash
# Runs the dashboard smoke e2e locally the way CI does, against a throwaway
# Platform: a fresh data directory, a generated bootstrap token and a generated
# owner password. Nothing is read from or written to your own installation, and
# the credentials only exist for this run.
set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=lib/e2e-runtime.sh
source scripts/lib/e2e-runtime.sh
trap stop_e2e_runtime EXIT
start_e2e_runtime

curl --fail --silent --request POST \
  --header "content-type: application/json" \
  --data "{\"bootstrapToken\":\"$ZELAVIS_BOOTSTRAP_TOKEN\",\"provider\":\"password\",\"account\":{\"email\":\"ci@example.com\",\"displayName\":\"Zelavis E2E\"},\"credential\":{\"identifier\":\"ci@example.com\",\"password\":\"$ZELAVIS_E2E_OWNER_PASSWORD\"}}" \
  $ZELAVIS_DEV_SERVER/zelavis/api/v1/auth/bootstrap >"$scratch/owner.json"

token="$(node -p "require('$scratch/owner.json').session.token")"
curl --fail --silent --request POST \
  --header "content-type: application/json" \
  --header "authorization: Bearer $token" \
  --data '{"id":"dashboard-e2e","name":"Zelavis Runtime","start":true}' \
  $ZELAVIS_DEV_SERVER/zelavis/api/v1/runtime/projects >/dev/null

if [[ "${ZELAVIS_E2E_EMBEDDED:-}" == "1" ]]; then
  ZELAVIS_E2E_PROJECT_ID=dashboard-e2e ZELAVIS_UI_BASE_PATH=/zelavis/ \
    pnpm --filter @zelavis/ui exec playwright test --grep @embedded
else
  ZELAVIS_E2E_SESSION_TOKEN="$token" pnpm run ci:ui
fi
