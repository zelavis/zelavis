#!/usr/bin/env bash
#
# Runs the WordPress provisioning check on a host that has nothing installed.
#
# The check only means something where nginx, PHP and MariaDB are absent, and
# no developer machine or CI runner is in that state — so it runs in a Debian
# container. This script is what sets that container up, and it is committed
# rather than typed into a workflow file so the same command runs in CI and on
# a laptop.
#
# Usage: packages/zelavis/scripts/wordpress-provisioning-container.sh [repo-root]
set -euo pipefail

REPO_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
IMAGE="${ZELAVIS_PROVISIONING_IMAGE:-node:24-bookworm}"

# Which identity the Platform runs as. Both are real deployments and both broke
# in different ways, so both are checked: "user" is an operator's own account
# with package authority, "root" is Zelavis installed as a system service.
IDENTITY="${ZELAVIS_PROVISIONING_IDENTITY:-user}"
if [[ "${IDENTITY}" != "user" && "${IDENTITY}" != "root" ]]; then
  echo "ZELAVIS_PROVISIONING_IDENTITY must be \"user\" or \"root\"." >&2
  exit 2
fi

# The repository is mounted read-only and copied inside. A writable mount would
# have the container's `pnpm install` write Linux-built `node_modules` into the
# host's checkout, which breaks the host's own install until it is redone.
docker run --rm \
  -v "${REPO_ROOT}:/src:ro" \
  -e "IDENTITY=${IDENTITY}" \
  "${IMAGE}" \
  bash -euo pipefail -c '
    apt-get update -qq >/dev/null
    apt-get install -y --no-install-recommends sudo ca-certificates >/dev/null

    # Not root. MariaDB refuses to start as root unless it is told which user to
    # drop to, and there is no such account on a host that only installed the
    # server core — so an installation that provisions its own packages runs as
    # an ordinary user with package authority. That is the arrangement the
    # driver`s `sudo -n apt-get` path was written for, and the safer one.
    echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node
    chmod 440 /etc/sudoers.d/node

    # As root, so the shims land somewhere every user can reach.
    corepack enable >/dev/null

    mkdir -p /build
    tar -C /src -cf - \
      --exclude=node_modules --exclude=.git --exclude=dist --exclude=repos . \
      | tar -C /build -xf -
    chown -R node:node /build

    echo "Host before provisioning:"
    for binary in nginx php-fpm8.2 mariadbd; do
      if command -v "$binary" >/dev/null 2>&1; then
        echo "  $binary PRESENT — this host cannot prove anything" >&2
        exit 1
      fi
      echo "  $binary absent"
    done

    if [ "$IDENTITY" = "root" ]; then
      cd /build
      pnpm install --frozen-lockfile >/dev/null
      pnpm --filter zelavis build >/dev/null
      node packages/zelavis/scripts/check-wordpress-provisioning.mjs
    else
      su node -s /bin/bash -c "
        cd /build
        pnpm install --frozen-lockfile >/dev/null
        pnpm --filter zelavis build >/dev/null
        node packages/zelavis/scripts/check-wordpress-provisioning.mjs
      "
    fi
  '
