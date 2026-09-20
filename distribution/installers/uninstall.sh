#!/bin/sh
set -eu

CONFIRMATION=DELETE-ALL-ZELAVIS-DATA
PREFIX=${ZELAVIS_PREFIX:-/opt/zelavis}
DATA_DIR=${ZELAVIS_DATA_DIR:-/var/lib/zelavis}
ETC_DIR=${ZELAVIS_UNINSTALL_ETC_DIR:-/etc/zelavis}
BIN_DIR=${ZELAVIS_BIN_DIR:-/usr/local/bin}
SYSTEM_BIN=${ZELAVIS_UNINSTALL_SYSTEM_BIN:-/usr/bin/zelavis}
COMMAND_PATH=${ZELAVIS_UNINSTALL_COMMAND:-$BIN_DIR/zelavis}
SYSTEMD_ETC_DIR=${ZELAVIS_UNINSTALL_SYSTEMD_ETC_DIR:-/etc/systemd/system}
SYSTEMD_LIB_DIR=${ZELAVIS_UNINSTALL_SYSTEMD_LIB_DIR:-/lib/systemd/system}
SYSTEMD_USR_LIB_DIR=${ZELAVIS_UNINSTALL_SYSTEMD_USR_LIB_DIR:-/usr/lib/systemd/system}
APT_SOURCE=${ZELAVIS_UNINSTALL_APT_SOURCE:-/etc/apt/sources.list.d/zelavis.sources}
APT_KEYRING=${ZELAVIS_UNINSTALL_APT_KEYRING:-/usr/share/keyrings/zelavis-archive-keyring.gpg}
SKIP_HOST_COMMANDS=${ZELAVIS_UNINSTALL_SKIP_HOST_COMMANDS:-0}
OWNS_USER=${ZELAVIS_UNINSTALL_OWNS_USER:-0}
OWNS_GROUP=${ZELAVIS_UNINSTALL_OWNS_GROUP:-0}
DRY_RUN=0
ACKNOWLEDGEMENT=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --confirm)
      shift
      ACKNOWLEDGEMENT=${1:-}
      ;;
    --confirm=*)
      ACKNOWLEDGEMENT=${1#--confirm=}
      ;;
    *)
      echo "Unknown uninstall option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

safe_tree() {
  label=$1
  path=$2
  case "$path" in
    /*) ;;
    *) echo "Refusing non-absolute $label path: $path" >&2; exit 1 ;;
  esac
  case "$path" in
    *//*|*/../*|*/..|*/./*|*/.)
      echo "Refusing non-normalized $label path: $path" >&2
      exit 1
      ;;
  esac
  case "$path" in
    /|/Applications|/Library|/System|/Users|/bin|/dev|/etc|/home|/lib|/media|/mnt|/opt|/private|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var)
      echo "Refusing unsafe $label path: $path" >&2
      exit 1
      ;;
  esac
}

safe_named_file() {
  label=$1
  path=$2
  expected_name=$3
  case "$path" in
    /*) ;;
    *) echo "Refusing non-absolute $label path: $path" >&2; exit 1 ;;
  esac
  case "$path" in
    *//*|*/../*|*/..|*/./*|*/.)
      echo "Refusing non-normalized $label path: $path" >&2
      exit 1
      ;;
  esac
  if [ "${path##*/}" != "$expected_name" ]; then
    echo "Refusing $label path whose name is not $expected_name: $path" >&2
    exit 1
  fi
}

safe_tree "installation root" "$PREFIX"
safe_tree "data directory" "$DATA_DIR"
safe_tree "configuration directory" "$ETC_DIR"
safe_tree "systemd configuration directory" "$SYSTEMD_ETC_DIR"
safe_tree "systemd library directory" "$SYSTEMD_LIB_DIR"
safe_tree "systemd usr library directory" "$SYSTEMD_USR_LIB_DIR"
safe_named_file "command" "$COMMAND_PATH" zelavis
safe_named_file "system command" "$SYSTEM_BIN" zelavis
safe_named_file "APT source" "$APT_SOURCE" zelavis.sources
safe_named_file "APT keyring" "$APT_KEYRING" zelavis-archive-keyring.gpg
case "$OWNS_USER:$OWNS_GROUP" in
  0:0|0:1|1:0|1:1) ;;
  *) echo "Refusing invalid installer account ownership receipt." >&2; exit 1 ;;
esac

print_plan() {
  cat <<EOF
Complete Zelavis uninstall plan
  services:       zelavis.service, zelavis-agent.service, zelavis-traefik.service
  packages:       zelavis, zelavis-repository (when installed through dpkg)
  commands:       Zelavis-owned links at $COMMAND_PATH and $SYSTEM_BIN
  installation:   $PREFIX
  data:           $DATA_DIR
  configuration:  $ETC_DIR
  apt source:     $APT_SOURCE
  apt keyring:    $APT_KEYRING
  account:        zelavis user/group only when recorded as installer-created

Intentionally retained because ownership may be shared or operator-managed:
  - nginx, PHP, MariaDB and other host packages
  - systemd journal history
  - downloaded archives and backups outside the data directory
  - operator-managed reverse-proxy, firewall, DNS and TLS configuration
    (Zelavis-owned Traefik files under the installation paths are removed)
EOF
}

if [ "$DRY_RUN" -eq 1 ]; then
  print_plan
  exit 0
fi

if [ "$ACKNOWLEDGEMENT" != "$CONFIRMATION" ]; then
  echo "Complete uninstall requires --confirm $CONFIRMATION" >&2
  exit 1
fi

# System paths and the packaged account require root. A custom installation
# whose every mutable path is redirected can still be removed by its owner;
# this is also how the destructive path is tested without touching a host.
if [ "$SKIP_HOST_COMMANDS" != 1 ] && [ "$(id -u)" -ne 0 ]; then
  for path in "$PREFIX" "$DATA_DIR" "$ETC_DIR" "$COMMAND_PATH" "$SYSTEM_BIN" "$SYSTEMD_ETC_DIR" "$SYSTEMD_LIB_DIR" "$SYSTEMD_USR_LIB_DIR" "$APT_SOURCE" "$APT_KEYRING"; do
    case "$path" in
      /etc/*|/usr/*|/var/*|/opt/*|/lib/*)
        echo "Complete uninstall of a system installation must run as root." >&2
        exit 1
        ;;
    esac
  done
fi

if [ "$SKIP_HOST_COMMANDS" != 1 ] && command -v systemctl >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
  systemctl stop zelavis.service zelavis-agent.service zelavis-traefik.service >/dev/null 2>&1 || true
  systemctl disable zelavis.service zelavis-agent.service zelavis-traefik.service >/dev/null 2>&1 || true
fi

# Purging package records first lets dpkg run its own lifecycle scripts. The
# rest of this file is already open, so removing the package containing it does
# not interrupt the cleanup that follows.
if [ "$SKIP_HOST_COMMANDS" != 1 ] && [ "$(id -u)" -eq 0 ] && command -v dpkg-query >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
  set --
  if dpkg-query -W -f='${db:Status-Abbrev}' zelavis 2>/dev/null | grep -q '^ii'; then
    set -- "$@" zelavis
  fi
  if dpkg-query -W -f='${db:Status-Abbrev}' zelavis-repository 2>/dev/null | grep -q '^ii'; then
    set -- "$@" zelavis-repository
  fi
  if [ "$#" -gt 0 ]; then
    DEBIAN_FRONTEND=noninteractive apt-get purge -y "$@"
  fi
fi

remove_owned_command() {
  command_path=$1
  if [ ! -L "$command_path" ]; then
    if [ -e "$command_path" ]; then
      echo "Retaining foreign command at $command_path" >&2
    fi
    return
  fi
  target=$(readlink "$command_path" 2>/dev/null || true)
  case "$target" in
    "$PREFIX"/*) rm -f "$command_path" ;;
    *) echo "Retaining foreign command link at $command_path -> $target" >&2 ;;
  esac
}

remove_owned_command "$COMMAND_PATH"
if [ "$COMMAND_PATH" != "$SYSTEM_BIN" ]; then
  remove_owned_command "$SYSTEM_BIN"
fi

for unit in zelavis.service zelavis-agent.service zelavis-traefik.service; do
  rm -f "$SYSTEMD_ETC_DIR/$unit"
  rm -f "$SYSTEMD_LIB_DIR/$unit"
  rm -f "$SYSTEMD_USR_LIB_DIR/$unit"
  rm -f "$SYSTEMD_ETC_DIR/multi-user.target.wants/$unit"
  rm -rf "$SYSTEMD_ETC_DIR/$unit.d"
done

rm -f "$APT_SOURCE" "$APT_KEYRING"
rm -rf "$ETC_DIR"
rm -rf "$DATA_DIR"
rm -rf "$PREFIX"

if [ "$SKIP_HOST_COMMANDS" != 1 ] && [ "$(id -u)" -eq 0 ] && command -v getent >/dev/null 2>&1; then
  account=$(getent passwd zelavis 2>/dev/null || true)
  if [ "$OWNS_USER" = 1 ] && [ -n "$account" ]; then
    old_ifs=$IFS
    IFS=:
    set -- $account
    IFS=$old_ifs
    account_home=${6:-}
    account_shell=${7:-}
    case "$account_shell" in
      */nologin|*/false)
        if [ "$account_home" = "$DATA_DIR" ]; then
          userdel zelavis >/dev/null 2>&1 || true
        else
          echo "Retaining zelavis account: home is $account_home, not $DATA_DIR" >&2
        fi
        ;;
      *) echo "Retaining zelavis account: shell is not a system-account shell" >&2 ;;
    esac
  elif [ -n "$account" ]; then
    echo "Retaining zelavis account: the installer did not record creating it." >&2
  fi
  if [ "$OWNS_GROUP" = 1 ] && getent group zelavis >/dev/null 2>&1; then
    groupdel zelavis >/dev/null 2>&1 || echo "Retaining zelavis group because another account still uses it." >&2
  elif getent group zelavis >/dev/null 2>&1; then
    echo "Retaining zelavis group: the installer did not record creating it." >&2
  fi
fi

if [ "$SKIP_HOST_COMMANDS" != 1 ] && command -v systemctl >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl reset-failed zelavis.service zelavis-agent.service zelavis-traefik.service >/dev/null 2>&1 || true
fi

echo "Zelavis installation, configuration and data removed."
