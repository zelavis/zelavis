#!/bin/sh
# Invoked only inside the disposable systemd container by the harness.
set -eu
[ "${ZELAVIS_PROVISIONING_DISPOSABLE:-}" = 1 ] && [ -e /.dockerenv ] || exit 2
cd /opt
node_version=$(sed -n 's/.*"nodeVersion": "\([^"]*\)".*/\1/p' /workspace/distribution/release.json)
case "$(uname -m)" in aarch64) architecture=arm64 ;; x86_64) architecture=x64 ;; *) exit 2 ;; esac
archive="node-v$node_version-linux-$architecture.tar.gz"
mkdir -p /opt/prepared/runtime /opt/npm-project
curl -fsSL "https://nodejs.org/dist/v$node_version/$archive" -o "$archive"
curl -fsSL "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o SHASUMS256.txt
sed -n "/ $archive\$/p" SHASUMS256.txt > node.sha256
test -s node.sha256
sha256sum -c node.sha256
tar --no-same-owner -xzf "$archive" -C /opt/prepared/runtime
mv "/opt/prepared/runtime/node-v$node_version-linux-$architecture" /opt/prepared/runtime/node
NODE=/opt/prepared/runtime/node/bin/node
NPM=/opt/prepared/runtime/node/lib/node_modules/npm/bin/npm-cli.js
printf '{"private":true}\n' > /opt/npm-project/package.json
package=/input/zelavis.tgz
if [ -n "${ZELAVIS_PROVISIONING_FROM_NPM:-}" ]; then package="zelavis@$ZELAVIS_PROVISIONING_FROM_NPM"; fi
"$NODE" "$NPM" install --prefix /opt/npm-project --registry=https://registry.npmjs.org --ignore-scripts --omit=dev --no-audit --no-fund "$package"
mv /opt/npm-project/node_modules/zelavis /opt/prepared/platform
mv /opt/npm-project/node_modules /opt/prepared/platform/node_modules
ln -s .. /opt/prepared/platform/node_modules/zelavis
# The previous release is installed with explicitly public management access;
# the candidate fresh install must qualify the private default.
management_exposure=
if [ -n "${ZELAVIS_PROVISIONING_FROM_NPM:-}" ]; then management_exposure=--public; fi
"$NODE" /opt/prepared/platform/dist/cli.js install --from-npm /opt/prepared $management_exposure > /opt/installation.log 2>&1 || { sed '/First-run bootstrap token:/d' /opt/installation.log; exit 1; }
NODE=/opt/zelavis/current/runtime/node/bin/node
CHECK=/workspace/zelavis-services/wordpress/scripts/check-wordpress-provisioning.mjs
if [ -z "${ZELAVIS_PROVISIONING_FROM_NPM:-}" ]; then
  mkdir -p /etc/systemd/system/zelavis.service.d
  printf '[Service]\nEnvironment=ZELAVIS_OFFICIAL_SERVICES_DIR=/workspace/zelavis-services\n' > /etc/systemd/system/zelavis.service.d/qualification.conf
  systemctl daemon-reload
  systemctl restart zelavis.service
fi
for attempt in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/zelavis/api/v1/auth/bootstrap >/dev/null; then break; fi
  sleep 1
done
systemctl is-active zelavis-host-agent.service zelavis.service
if [ -z "${ZELAVIS_PROVISIONING_FROM_NPM:-}" ]; then
  systemctl is-active zelavis-traefik.service
  systemctl is-enabled zelavis-traefik.service
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 2 http://127.0.0.1/zelavis/ >/dev/null; then break; fi
    sleep 1
  done
  server_ip=$(hostname -I | awk '{print $1}')
  curl -fsS --noproxy '*' --max-time 10 "http://$server_ip/zelavis/" >/dev/null
  if curl -fsS --noproxy '*' --max-time 2 "http://$server_ip:3000/zelavis/" >/dev/null 2>&1; then
    printf 'FAIL: the default management listener must be private.\n'; exit 1
  fi
  printf 'PASS: production IP ingress via Traefik; default management listener stays private.\n'
fi
stat -c '%U:%G %a %n' /opt/zelavis/host-agent/agent /opt/zelavis/host-agent/agent/token /opt/zelavis/host-agent/agent/agent.sock
"$NODE" "$CHECK" claim
chown zelavis:zelavis /var/lib/zelavis/qualification-session
printf 'deb [trusted=yes] http://127.0.0.1:9 unavailable main\n' > /etc/apt/sources.list.d/zelavis-cancel.list
runuser -u zelavis -- env ZELAVIS_PROVISIONING_DISPOSABLE=1 "$NODE" "$CHECK" cancel
rm /etc/apt/sources.list.d/zelavis-cancel.list
runuser -u zelavis -- env ZELAVIS_PROVISIONING_DISPOSABLE=1 "$NODE" "$CHECK" create
systemctl stop zelavis.service zelavis.socket
runuser -u zelavis -- env ZELAVIS_PROVISIONING_DISPOSABLE=1 "$NODE" "$CHECK" seed-upgrade
systemctl start zelavis.socket zelavis.service
for attempt in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/zelavis/api/v1/auth/bootstrap >/dev/null; then break; fi
  sleep 1
done
phase=upgrade
if [ -n "${ZELAVIS_QUALIFY_UPDATE:-}" ]; then phase=start-historical; fi
runuser -u zelavis -- env ZELAVIS_PROVISIONING_DISPOSABLE=1 "$NODE" "$CHECK" "$phase"
if [ -z "${ZELAVIS_QUALIFY_UPDATE:-}" ]; then
  # A running WordPress Project upgrades its recipe without stopping: only Nginx's configuration differs.
  runuser -u zelavis -- env ZELAVIS_PROVISIONING_DISPOSABLE=1 "$NODE" "$CHECK" stop
  systemctl stop zelavis.service zelavis.socket
  runuser -u zelavis -- env ZELAVIS_PROVISIONING_DISPOSABLE=1 "$NODE" "$CHECK" seed-live
  systemctl start zelavis.socket zelavis.service
  for attempt in $(seq 1 60); do
    if curl -fsS --max-time 2 http://127.0.0.1:3000/zelavis/api/v1/auth/bootstrap >/dev/null; then break; fi
    sleep 1
  done
  runuser -u zelavis -- env ZELAVIS_PROVISIONING_DISPOSABLE=1 "$NODE" "$CHECK" start-historical
  runuser -u zelavis -- env ZELAVIS_PROVISIONING_DISPOSABLE=1 "$NODE" "$CHECK" live-upgrade
  # The second managed recipe, a different shape (no database), through the same path.
  DOKUWIKI_CHECK=/workspace/zelavis-services/dokuwiki/scripts/check-dokuwiki-provisioning.mjs
  runuser -u zelavis -- env ZELAVIS_PROVISIONING_DISPOSABLE=1 "$NODE" "$DOKUWIKI_CHECK" create
  systemctl stop zelavis.service zelavis.socket
  runuser -u zelavis -- env ZELAVIS_PROVISIONING_DISPOSABLE=1 "$NODE" "$DOKUWIKI_CHECK" seed
  systemctl start zelavis.socket zelavis.service
  for attempt in $(seq 1 60); do
    if curl -fsS --max-time 2 http://127.0.0.1:3000/zelavis/api/v1/auth/bootstrap >/dev/null; then break; fi
    sleep 1
  done
  runuser -u zelavis -- env ZELAVIS_PROVISIONING_DISPOSABLE=1 "$NODE" "$DOKUWIKI_CHECK" live-upgrade
fi
if [ -n "${ZELAVIS_QUALIFY_UPDATE:-}" ]; then
  "$NODE" /workspace/distribution/scripts/qualify-installed-update.mjs
elif [ -z "${ZELAVIS_PROVISIONING_FROM_NPM:-}" ]; then
  "$NODE" /workspace/zelavis-services/wordpress/scripts/check-runtime-handover.mjs
fi
systemctl restart zelavis.service
for attempt in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/zelavis/api/v1/auth/bootstrap >/dev/null; then break; fi
  sleep 1
done
runuser -u zelavis -- env ZELAVIS_PROVISIONING_DISPOSABLE=1 "$NODE" "$CHECK" verify-preview
/opt/zelavis/current/bin/zelavis doctor --json
# Prove complete removal restores a policy that normal host maintenance can use.
/opt/zelavis/current/bin/zelavis uninstall --all --confirm DELETE-ALL-ZELAVIS-DATA
[ ! -e /usr/sbin/policy-rc.d.zelavis-owner ]
[ ! -e /usr/sbin/policy-rc.d.zelavis-original ]
[ ! -e /opt/zelavis ]
printf 'PASS: packaged installation, WordPress provisioning and complete uninstall.\n'
