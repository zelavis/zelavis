#!/bin/sh
# Checks, or records, what a build downloaded against sources.lock.
#
#   sources-lock.sh check  <downloads-dir> <key> <lock-file>   fails if any source differs from the lock
#   sources-lock.sh update <downloads-dir> <key> <lock-file>   records the sources under <key> (a change to review)
#
# static-php-cli keeps its own record of a download in `.lock.json`: each source's name, whether it is an
# archive (a file) or a git checkout (a directory), and where it is. This turns that into one line per source:
#   <key> <name> <file or directory> <archive|git> <sha256 or commit> <bytes or -> -
# An archive is pinned by the SHA-256 of its bytes, a git checkout by its commit (already content-addressed).
# A source that moved upstream (a new release of a library the builder looks up as "latest") changes its line,
# and the build stops until someone has read the difference and chosen to accept it.
set -eu
mode=${1:-}
downloads=${2:-}
key=${3:-}
lock=${4:-}
case "$mode" in check|update) ;; *) echo 'Usage: sources-lock.sh check|update <downloads-dir> <key> <lock-file>' >&2; exit 2 ;; esac
[ -d "$downloads" ] && [ -n "$key" ] && [ -n "$lock" ] || { echo 'Usage: sources-lock.sh check|update <downloads-dir> <key> <lock-file>' >&2; exit 2; }
[ -f "$downloads/.lock.json" ] || { echo 'The builder recorded no downloads.' >&2; exit 1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'; else shasum -a 256 "$1" | awk '{ print $1 }'; fi
}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
: > "$scratch/now"
: > "$scratch/err"

# The file may or may not end in a newline; one is always added so the last source is read like the rest.
{ tr -d '\n ' < "$downloads/.lock.json"; printf '\n'; } | sed 's/},"/}\n"/g; s/^{//; s/}}$/}/' > "$scratch/entries"
while IFS= read -r entry || [ -n "$entry" ]; do
  name=$(printf '%s' "$entry" | sed 's/^"\([^"]*\)".*/\1/')
  kind=$(printf '%s' "$entry" | sed 's/.*"source_type":"\([a-z]*\)".*/\1/')
  case "$name" in ''|*[!A-Za-z0-9._-]*) echo "an unusual source name: $name" >> "$scratch/err"; continue ;; esac
  case "$kind" in
    archive)
      file=$(printf '%s' "$entry" | sed 's/.*"filename":"\([^"]*\)".*/\1/')
      case "$file" in ''|*/*|*[!A-Za-z0-9._+-]*) echo "an unusual file name for $name: $file" >> "$scratch/err"; continue ;; esac
      [ -f "$downloads/$file" ] || { echo "the download of $name ($file) is missing" >> "$scratch/err"; continue; }
      printf '%s %s %s archive %s %s -\n' "$key" "$name" "$file" "$(sha256_of "$downloads/$file")" "$(wc -c < "$downloads/$file" | tr -d ' ')" >> "$scratch/now" ;;
    git)
      dir=$(printf '%s' "$entry" | sed 's/.*"dirname":"\([^"]*\)".*/\1/')
      case "$dir" in ''|*/*|*[!A-Za-z0-9._+-]*) echo "an unusual directory name for $name: $dir" >> "$scratch/err"; continue ;; esac
      commit=$(git -C "$downloads/$dir" rev-parse HEAD 2>/dev/null) || { echo "the checkout of $name ($dir) is not a git repository" >> "$scratch/err"; continue; }
      printf '%s %s %s git %s - -\n' "$key" "$name" "$dir" "$commit" >> "$scratch/now" ;;
    *) echo "the builder named a kind of source ($kind) this script does not know" >> "$scratch/err" ;;
  esac
done < "$scratch/entries"
[ ! -s "$scratch/err" ] || { cat "$scratch/err" >&2; exit 1; }
[ -s "$scratch/now" ] || { echo 'No downloaded source could be read.' >&2; exit 1; }
sort -o "$scratch/now" "$scratch/now"

if [ "$mode" = update ]; then
  # Replaces only this key's section, so the diff a reviewer reads is exactly what changed.
  { [ -f "$lock" ] && grep -v "^$key " "$lock" || true; cat "$scratch/now"; } | sort > "$scratch/next"
  cp "$scratch/next" "$lock"
  printf 'Recorded %s sources for %s in %s; review the change before committing it.\n' "$(wc -l < "$scratch/now" | tr -d ' ')" "$key" "$lock"
  exit 0
fi

[ -f "$lock" ] && grep -q "^$key " "$lock" || { echo "$lock has nothing for $key; build once with --update-lock and review what it records." >&2; exit 1; }
grep "^$key " "$lock" | sort > "$scratch/locked"
if ! diff "$scratch/locked" "$scratch/now" > "$scratch/diff"; then
  sed 's/^/  /' "$scratch/diff" | head -40 >&2
  echo "The downloaded sources differ from $lock (< locked, > downloaded). If an upstream moved on, review it and build with --update-lock." >&2
  exit 1
fi
printf 'All %s sources match the lock.\n' "$(wc -l < "$scratch/now" | tr -d ' ')"
