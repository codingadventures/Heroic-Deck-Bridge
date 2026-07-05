#!/usr/bin/env bash
# Heroic Deck Bridge - stable install-or-launch wrapper.
#
# One fixed executable backs every Steam shortcut card. Steam derives a
# non-Steam shortcut's appID from (exe path + AppName), so keeping this exe and
# the game title constant keeps the card (and its artwork) stable for the life
# of the game, regardless of install state. The runner/id are passed as launch
# options (which do NOT affect the appID).
#
# Usage (from the Steam shortcut LaunchOptions): heroic-run.sh <runner> <id>
#   runner: legendary | gog | nile
#   id:     Heroic app_name / id for the game
set -euo pipefail

runner="${1:-}"
id="${2:-}"
if [ -z "$runner" ] || [ -z "$id" ]; then
  echo "usage: heroic-run.sh <legendary|gog|nile> <id>" >&2
  exit 2
fi

self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Optional overrides (INSTALL_PATH, HEROIC_CMD) live next to the wrapper.
cfg_env="$self_dir/bridge.env"
# shellcheck disable=SC1090
[ -f "$cfg_env" ] && . "$cfg_env"

# Locate Heroic config (flatpak first, then native).
cfg="$HOME/.var/app/com.heroicgameslauncher.hgl/config/heroic"
if [ ! -d "$cfg" ]; then
  cfg="$HOME/.config/heroic"
fi

case "$runner" in
  legendary) inst="$cfg/legendaryConfig/legendary/installed.json" ;;
  gog)       inst="$cfg/gog_store/installed.json" ;;
  nile)      inst="$cfg/nile_config/nile/installed.json" ;;
  *) echo "unknown runner: $runner" >&2; exit 2 ;;
esac

# How to invoke Heroic. Flatpak by default; override with HEROIC_CMD in bridge.env.
if [ -n "${HEROIC_CMD:-}" ]; then
  # shellcheck disable=SC2206
  hero=($HEROIC_CMD --no-gui)
elif command -v flatpak >/dev/null 2>&1 && \
     flatpak info com.heroicgameslauncher.hgl >/dev/null 2>&1; then
  hero=(flatpak run com.heroicgameslauncher.hgl --no-gui)
else
  hero=(heroic --no-gui)
fi

is_installed() {
  [ -f "$inst" ] && grep -q "\"$id\"" "$inst"
}

if is_installed; then
  # Installed -> launch inside this Steam game session (normal reaper path).
  exec "${hero[@]}" "heroic://launch/$runner/$id"
fi

# Not installed -> hand the download to a transient systemd --user unit so it
# lives in the user slice (a different cgroup than Steam's reaper scope) and
# survives launching/stopping other games. Pass an explicit ?path= so the
# headless --no-gui install does not stall waiting on the install-path dialog.
install_path="${INSTALL_PATH:-$HOME/Games/Heroic}"
safe_id="$(printf '%s' "$id" | tr -c 'A-Za-z0-9_.-' '_')"
unit="heroic-install-${runner}-${safe_id}"

# Drop a marker so the Decky backend can track this install (progress + dimmed
# artwork) even though it was started by a tile press, not the backend. The
# backend removes the marker once the game appears in installed.json.
marker_dir="$self_dir/installing"
mkdir -p "$marker_dir"
printf '{"runner":"%s","id":"%s","path":"%s"}\n' "$runner" "$id" "$install_path" \
  > "$marker_dir/${runner}__${safe_id}.json"

if command -v systemd-run >/dev/null 2>&1; then
  systemd-run --user --collect --unit="$unit" \
    "${hero[@]}" "heroic://install/$runner/$id?path=$install_path" || \
  setsid "${hero[@]}" "heroic://install/$runner/$id?path=$install_path" &
else
  # Fallback: detach with setsid so the reaper cannot tree-kill the download.
  setsid "${hero[@]}" "heroic://install/$runner/$id?path=$install_path" &
fi

# Return immediately; Steam sees this "game" stop while the download continues
# out-of-session. Heroic Deck Bridge tracks progress from the Decky side.
exit 0
