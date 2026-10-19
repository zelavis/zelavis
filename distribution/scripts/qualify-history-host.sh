#!/bin/sh
# Invoked only inside the disposable systemd container by qualify-history.sh.
set -eu
[ "${ZELAVIS_PROVISIONING_DISPOSABLE:-}" = 1 ] && [ -e /.dockerenv ] || exit 2
HISTORY=/workspace/distribution/history.json
FROM=$(sed -n 's/.*"from": *"\([^"]*\)".*/\1/p' "$HISTORY")
VIA=$(sed -n 's/.*"via": *\[\(.*\)\].*/\1/p' "$HISTORY" | tr -d '" ' | tr ',' ' ')
TO=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' /workspace/packages/zelavis/package.json | head -1)
TO=${ZELAVIS_QUALIFY_CANDIDATE_VERSION:-$TO}
cd /opt
node_version=$(sed -n 's/.*"nodeVersion": "\([^"]*\)".*/\1/p' /workspace/distribution/release.json)
case "$(uname -m)" in aarch64) architecture=arm64 ;; x86_64) architecture=x64 ;; *) exit 2 ;; esac
archive="node-v$node_version-linux-$architecture.tar.gz"
mkdir -p /opt/prepared/runtime /opt/npm-project
curl -fsSL "https://nodejs.org/dist/v$node_version/$archive" -o "$archive"
curl -fsSL "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o SHASUMS256.txt
sed -n "/ $archive\$/p" SHASUMS256.txt > node.sha256
sha256sum -c node.sha256 >/dev/null
tar --no-same-owner -xzf "$archive" -C /opt/prepared/runtime
mv "/opt/prepared/runtime/node-v$node_version-linux-$architecture" /opt/prepared/runtime/node
NODE=/opt/prepared/runtime/node/bin/node
printf '{"private":true}\n' > /opt/npm-project/package.json
"$NODE" /opt/prepared/runtime/node/lib/node_modules/npm/bin/npm-cli.js install --prefix /opt/npm-project --registry=https://registry.npmjs.org --ignore-scripts --omit=dev --no-audit --no-fund "zelavis@$FROM" >/dev/null
mv /opt/npm-project/node_modules/zelavis /opt/prepared/platform
mv /opt/npm-project/node_modules /opt/prepared/platform/node_modules
ln -s .. /opt/prepared/platform/node_modules/zelavis
"$NODE" /opt/prepared/platform/dist/cli.js install --from-npm /opt/prepared --public > /opt/installation.log 2>&1 || { sed '/First-run bootstrap token:/d' /opt/installation.log; exit 1; }
NODE=/opt/zelavis/current/runtime/node/bin/node
ready() { for attempt in $(seq 1 120); do curl -fsS --max-time 2 http://127.0.0.1:3000/zelavis/api/v1/auth/bootstrap >/dev/null && return 0; sleep 1; done; return 1; }
ready
# Each release in the history keeps the allow-list it shipped with, as the servers that made these apps did.
# The list zelavis.com serves today names recipes an old release cannot run; entries carry no minimum Platform
# version yet (an open item), so a history fed from it would fail on that, not on what this gate proves.
systemctl stop zelavis.service zelavis.socket
mkdir -p /etc/systemd/system/zelavis.service.d
printf '[Service]\nEnvironment=ZELAVIS_ALLOWLIST_SOURCES=https://127.0.0.1:9/allowlist.json\n' > /etc/systemd/system/zelavis.service.d/history.conf
"$NODE" -e 'const { DatabaseSync } = require("node:sqlite"); const d = new DatabaseSync("/var/lib/zelavis/system/zelavis.sqlite"); d.prepare("DELETE FROM zelavis_system_records WHERE namespace = ?").run("marketplace-allowlist"); d.close();' 2>/dev/null
systemctl daemon-reload
systemctl start zelavis.socket zelavis.service
ready
"$NODE" /workspace/zelavis-services/wordpress/scripts/check-wordpress-provisioning.mjs claim
chown zelavis:zelavis /var/lib/zelavis/qualification-session
check() { runuser -u zelavis -- env ZELAVIS_PROVISIONING_DISPOSABLE=1 "$NODE" /workspace/distribution/scripts/qualify-history.mjs "$@"; }
check create-wordpress
printf 'PASS: %s made a WordPress site with its own runtime, and opened it.\n' "$FROM"
# Live updates, the way Update now moves a server: stage the release, then hand over to it. Never the
# installer, which restarts what a real server keeps running.
hop() {
  CURRENT=$(readlink -f /opt/zelavis/current)
  sh "$CURRENT/platform/dist/installation-assets/install.sh" --version "$1" --stage-only > "/opt/hop-$1.log" 2>&1 || { tail -20 "/opt/hop-$1.log"; exit 1; }
  "/opt/zelavis/releases/$1/runtime/node/bin/node" "/opt/zelavis/releases/$1/platform/dist/cli.js" install --from-release "/opt/zelavis/releases/$1" --installed-by script --live >> "/opt/hop-$1.log" 2>&1 || { tail -20 "/opt/hop-$1.log"; exit 1; }
  ready
  NODE=/opt/zelavis/current/runtime/node/bin/node
  check serving
  printf 'PASS: live update to %s; every site still serves.\n' "$1"
}
FIRST=yes
for VERSION in $VIA; do
  hop "$VERSION"
  if [ "$FIRST" = yes ]; then check create-dokuwiki; printf 'PASS: %s made a DokuWiki site in its layout, and opened it.\n' "$VERSION"; FIRST=no; fi
done
[ "$ZELAVIS_HISTORY_PREVIOUS" = "$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' /opt/zelavis/installation.json)" ] || hop "$ZELAVIS_HISTORY_PREVIOUS"
check open
# The candidate, through the installed release's own updater, as the update gate does.
env ZELAVIS_PROVISIONING_DISPOSABLE=1 ZELAVIS_HISTORY_TO="$TO" "$NODE" /workspace/distribution/scripts/qualify-history.mjs candidate
NODE=/opt/zelavis/current/runtime/node/bin/node
check serving
printf 'PASS: live update to the candidate %s; every site still serves.\n' "$TO"
# A server whose WordPress came with an earlier Platform holds it only as a Marketplace listing.
systemctl stop zelavis.service zelavis.socket
env ZELAVIS_PROVISIONING_DISPOSABLE=1 "$NODE" /workspace/distribution/scripts/qualify-history.mjs unlist
systemctl start zelavis.socket zelavis.service
ready
check upgrade
systemctl restart zelavis.service
ready
check serving
# The restarted Platform adopts what runs; it never starts a second copy of a process (a second Caddy shares its
# port, a second PHP-FPM fails on its socket and loops).
sleep 20
for PROJECT in blogger wiki; do
  for PROCESS in "caddy run --config /var/lib/zelavis/projects/$PROJECT/" "php-fpm: master process (/var/lib/zelavis/projects/$PROJECT/"; do
    COUNT=$(ps -eo args | grep -F "$PROCESS" | grep -vc grep || true)
    [ "$COUNT" = 1 ] || { printf 'FAIL: %s runs %s copies of "%s" after the restart.\n' "$PROJECT" "$COUNT" "$PROCESS"; exit 1; }
  done
done
printf 'PASS: after a Platform restart each site runs exactly one of each process.\n'
printf 'PASS: a server with a history (%s via %s and %s to %s) upgrades every recipe without a failed request.\n' "$FROM" "$VIA" "$ZELAVIS_HISTORY_PREVIOUS" "$TO"
