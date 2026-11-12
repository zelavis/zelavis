#!/bin/sh
# Called by the disposable systemd harnesses before starting the baseline host.
set -eu
[ "${ZELAVIS_PROVISIONING_DISPOSABLE:-}" = 1 ] && [ -e /.dockerenv ] || exit 2
[ -f /input/candidate-registry/index.json ] || exit 0
directory=/opt/zelavis-qualification-registry
mkdir -p "$directory" /etc/systemd/system/zelavis.service.d
cp /input/candidate-registry/index.json /input/candidate-registry/*.tgz "$directory/"
chmod 755 "$directory"
chmod 644 "$directory"/*
printf '[Service]\nEnvironment=NODE_OPTIONS=--import=/workspace/distribution/scripts/lib/candidate-registry.mjs\nEnvironment=ZELAVIS_PROVISIONING_DISPOSABLE=1\nEnvironment=ZELAVIS_QUALIFICATION_REGISTRY=%s\n' "$directory" > /etc/systemd/system/zelavis.service.d/candidate-registry.conf
