#!/usr/bin/env bash
# Release gate: actual published code -> packed candidate; npm mode proves Update now after publication.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export ZELAVIS_QUALIFY_UPDATE="${ZELAVIS_QUALIFY_UPDATE:-local}"
if [[ -z "${ZELAVIS_PROVISIONING_FROM_NPM:-}" ]]; then
  export ZELAVIS_PROVISIONING_FROM_NPM="$(node -e 'fetch("https://registry.npmjs.org/-/package/zelavis/dist-tags").then(r=>r.json()).then(v=>{if(!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v.alpha))throw Error("Invalid channel");process.stdout.write(v.alpha)})')"
fi
bash "$REPO_ROOT/zelavis-services/wordpress/scripts/wordpress-provisioning-container.sh" "$REPO_ROOT"
