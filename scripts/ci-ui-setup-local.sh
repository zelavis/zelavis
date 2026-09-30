#!/usr/bin/env bash
# Runs the first-run wizard e2e against a Platform nobody has claimed: a fresh
# data directory and generated credentials that only exist for this run.
set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=lib/e2e-runtime.sh
source scripts/lib/e2e-runtime.sh
trap stop_e2e_runtime EXIT
start_e2e_runtime

pnpm --filter @zelavis/ui exec playwright test -c playwright.setup.config.ts
