#!/usr/bin/env bash
# Refreshes the vendored Effect source in repos/effect to one exact release tag.
#
#   scripts/update-effect-source.sh effect@4.0.0
#
# The source is read-only reference material for people and coding agents (see
# AGENTS.md); it is never imported. It is vendored at the tag that matches the
# `effect` version in package.json, so what an agent reads is what runs.
#
# This is a script and not `git subtree pull` on purpose: pull requests are
# squash-merged, which discards subtree's bookkeeping, and the next pull then
# fails with "was never added". Pass the tag, review the diff, commit it.
set -euo pipefail

tag="${1:?usage: scripts/update-effect-source.sh <tag>, e.g. effect@4.0.0}"
root="$(git rev-parse --show-toplevel)"
destination="$root/repos/effect"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone --quiet --depth 1 --branch "$tag" https://github.com/Effect-TS/effect.git "$work/source"
commit="$(git -C "$work/source" rev-parse HEAD)"

rm -rf "$destination"
mkdir -p "$destination"
# Left out: release machinery and CI that mean nothing here, and the AI packages,
# which nothing in this repository uses.
rsync -a \
  --exclude .git --exclude .github --exclude .changeset --exclude node_modules \
  --exclude packages/ai \
  "$work/source/" "$destination/"
printf '%s\n%s\n' "$tag" "$commit" > "$destination/VENDORED_FROM"

echo "Vendored $tag ($commit) into repos/effect."
