#!/bin/sh
# Invoked only inside a disposable systemd container by qualify-backups.sh: `primary` makes, backs up, drills and
# restores a WordPress Project; `elsewhere` is a fresh machine that drills the same run from the target alone.
set -eu
[ "${ZELAVIS_PROVISIONING_DISPOSABLE:-}" = 1 ] && [ -e /.dockerenv ] || exit 2
ROLE=$1
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
"$NODE" /opt/prepared/runtime/node/lib/node_modules/npm/bin/npm-cli.js install --prefix /opt/npm-project --registry=https://registry.npmjs.org --ignore-scripts --omit=dev --no-audit --no-fund /input/zelavis.tgz >/dev/null
mv /opt/npm-project/node_modules/zelavis /opt/prepared/platform
mv /opt/npm-project/node_modules /opt/prepared/platform/node_modules
ln -s .. /opt/prepared/platform/node_modules/zelavis
"$NODE" /opt/prepared/platform/dist/cli.js install --from-npm /opt/prepared > /opt/installation.log 2>&1 || { sed '/First-run bootstrap token:/d' /opt/installation.log; exit 1; }
NODE=/opt/zelavis/current/runtime/node/bin/node
# This checkout's recipes, as the candidate will list them once they are published.
mkdir -p /etc/systemd/system/zelavis.service.d
printf '[Service]\nEnvironment=ZELAVIS_OFFICIAL_SERVICES_DIR=/workspace/zelavis-services\n' > /etc/systemd/system/zelavis.service.d/qualification.conf
systemctl daemon-reload
systemctl restart zelavis.service
for attempt in $(seq 1 60); do curl -fsS --max-time 2 http://127.0.0.1:3000/zelavis/api/v1/auth/bootstrap >/dev/null && break; sleep 1; done
"$NODE" /workspace/zelavis-services/wordpress/scripts/check-wordpress-provisioning.mjs claim
chown zelavis:zelavis /var/lib/zelavis/qualification-session
chown zelavis:zelavis /srv/offsite
runuser -u zelavis -- env ZELAVIS_PROVISIONING_DISPOSABLE=1 "$NODE" /workspace/distribution/scripts/qualify-backups.mjs "$ROLE"
