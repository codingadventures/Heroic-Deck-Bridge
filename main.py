"""Heroic Deck Bridge - Decky backend.

Reads the Heroic library (Epic/legendary, GOG/gog, Amazon/nile), deploys the
install-or-launch wrapper, triggers reaper-safe installs via `systemd-run
--user`, and reports install progress to the frontend.

All compatibility (Proton, prefixes, dependencies) stays with Heroic. This
backend never touches Wine/Proton; it only mirrors the library and drives
Heroic's `heroic://` protocol.
"""

import asyncio
import base64
import json
import os
import re
import subprocess
import urllib.request
from typing import Any, Dict, List, Optional

import decky

RUNNERS = ("legendary", "gog", "nile")

# --------------------------------------------------------------------------- #
# User / environment helpers
# --------------------------------------------------------------------------- #

def _user() -> str:
    return getattr(decky, "DECKY_USER", None) or os.environ.get("USER") or "deck"


def _home() -> str:
    return (
        getattr(decky, "DECKY_USER_HOME", None)
        or os.environ.get("HOME")
        or os.path.expanduser("~")
    )


def _uid() -> Optional[int]:
    try:
        import pwd

        return pwd.getpwnam(_user()).pw_uid
    except Exception:
        return None


def _as_user(cmd: List[str]) -> List[str]:
    """Ensure a command runs as the target desktop user with a usable session
    bus. Decky runs plugin backends as the unprivileged user by default (no
    `_root` flag), in which case this is a no-op. The root path is a safety
    fallback only."""
    try:
        if os.geteuid() != 0:
            return cmd
    except AttributeError:
        return cmd
    uid = _uid()
    if uid is None:
        return cmd
    return [
        "sudo",
        "-u",
        _user(),
        "env",
        f"XDG_RUNTIME_DIR=/run/user/{uid}",
        f"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus",
        *cmd,
    ]


# --------------------------------------------------------------------------- #
# Heroic locations
# --------------------------------------------------------------------------- #

def _heroic_config_dir() -> str:
    flatpak = os.path.join(
        _home(), ".var", "app", "com.heroicgameslauncher.hgl", "config", "heroic"
    )
    if os.path.isdir(flatpak):
        return flatpak
    return os.path.join(_home(), ".config", "heroic")


def _is_flatpak() -> bool:
    return os.path.isdir(
        os.path.join(_home(), ".var", "app", "com.heroicgameslauncher.hgl")
    )


def _heroic_cmd() -> List[str]:
    if _is_flatpak():
        return ["flatpak", "run", "com.heroicgameslauncher.hgl", "--no-gui"]
    return ["heroic", "--no-gui"]


def _library_file(runner: str) -> str:
    cfg = _heroic_config_dir()
    return os.path.join(cfg, "store_cache", f"{runner}_library.json")


def _installed_file(runner: str) -> str:
    cfg = _heroic_config_dir()
    return {
        "legendary": os.path.join(cfg, "legendaryConfig", "legendary", "installed.json"),
        "gog": os.path.join(cfg, "gog_store", "installed.json"),
        "nile": os.path.join(cfg, "nile_config", "nile", "installed.json"),
    }[runner]


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #

def _load_json(path: str) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _library_entries(runner: str) -> List[Dict[str, Any]]:
    data = _load_json(_library_file(runner))
    if not isinstance(data, dict):
        return []
    # legendary/nile use `library`, gog uses `games`.
    entries = data.get("library")
    if not isinstance(entries, list):
        entries = data.get("games")
    return entries if isinstance(entries, list) else []


def _entry_id(entry: Dict[str, Any]) -> Optional[str]:
    return entry.get("app_name") or entry.get("appName") or entry.get("id")


def _installed_ids(runner: str) -> set:
    """Return the set of installed ids for a runner, tolerating the several
    shapes Heroic/its backends use (dict keyed by id, or {"installed": [...]})."""
    data = _load_json(_installed_file(runner))
    ids: set = set()
    if isinstance(data, dict):
        if isinstance(data.get("installed"), list):
            for item in data["installed"]:
                if isinstance(item, dict):
                    gid = item.get("appName") or item.get("app_name") or item.get("id")
                    if gid:
                        ids.add(gid)
        else:
            # Legendary/nile style: keyed by app_name.
            for key, val in data.items():
                ids.add(key)
                if isinstance(val, dict):
                    gid = val.get("app_name") or val.get("appName")
                    if gid:
                        ids.add(gid)
    elif isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                gid = item.get("appName") or item.get("app_name") or item.get("id")
                if gid:
                    ids.add(gid)
    return ids


def _installed_paths(runner: str) -> Dict[str, str]:
    """Map installed id -> install_path (used for progress estimation)."""
    data = _load_json(_installed_file(runner))
    out: Dict[str, str] = {}

    def add(gid: Optional[str], path: Optional[str]) -> None:
        if gid and path:
            out[gid] = path

    if isinstance(data, dict):
        if isinstance(data.get("installed"), list):
            for item in data["installed"]:
                if isinstance(item, dict):
                    add(
                        item.get("appName") or item.get("app_name"),
                        item.get("install_path") or item.get("installPath"),
                    )
        else:
            for key, val in data.items():
                if isinstance(val, dict):
                    add(key, val.get("install_path") or val.get("installPath"))
    return out


def _int_or_none(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _game_dict(runner: str, entry: Dict[str, Any], installed_ids: set) -> Optional[Dict[str, Any]]:
    gid = _entry_id(entry)
    if not gid:
        return None
    title = entry.get("title") or entry.get("name") or gid
    install_meta = entry.get("install") if isinstance(entry.get("install"), dict) else {}
    return {
        "runner": runner,
        "id": gid,
        "title": title,
        "artSquare": entry.get("art_square") or entry.get("art_cover"),
        "artCover": entry.get("art_cover") or entry.get("art_square"),
        "artHero": entry.get("art_background") or entry.get("art_cover"),
        "installSize": _int_or_none(
            entry.get("install_size") or install_meta.get("install_size")
        ),
        "installed": gid in installed_ids,
    }


# --------------------------------------------------------------------------- #
# Persistent state (appid map + settings)
# --------------------------------------------------------------------------- #

def _state_dir() -> str:
    base = getattr(decky, "DECKY_PLUGIN_SETTINGS_DIR", None) or os.path.join(
        _home(), ".config", "heroic-deck-bridge"
    )
    os.makedirs(base, exist_ok=True)
    return base


def _state_path(name: str) -> str:
    return os.path.join(_state_dir(), name)


def _read_state(name: str, default: Any) -> Any:
    data = _load_json(_state_path(name))
    return data if data is not None else default


def _write_state(name: str, value: Any) -> None:
    tmp = _state_path(name) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(value, fh)
    os.replace(tmp, _state_path(name))


# --------------------------------------------------------------------------- #
# Wrapper deployment
# --------------------------------------------------------------------------- #

def _bridge_dir() -> str:
    d = os.path.join(_home(), ".local", "share", "heroic-deck-bridge")
    os.makedirs(d, exist_ok=True)
    return d


def _wrapper_path() -> str:
    return os.path.join(_bridge_dir(), "heroic-run.sh")


def _marker_dir() -> str:
    d = os.path.join(_bridge_dir(), "installing")
    os.makedirs(d, exist_ok=True)
    return d


def _marker_file(runner: str, gid: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", gid)
    return os.path.join(_marker_dir(), f"{runner}__{safe}.json")


def _write_marker(runner: str, gid: str, path: Optional[str]) -> None:
    try:
        with open(_marker_file(runner, gid), "w", encoding="utf-8") as fh:
            json.dump({"runner": runner, "id": gid, "path": path}, fh)
    except Exception:
        pass


def _target_size(runner: str, gid: str) -> Optional[int]:
    for entry in _library_entries(runner):
        if _entry_id(entry) == gid:
            install_meta = entry.get("install") if isinstance(entry.get("install"), dict) else {}
            return _int_or_none(
                entry.get("install_size") or install_meta.get("install_size")
            )
    return None


def _dir_size(path: str) -> int:
    total = 0
    try:
        for root, _dirs, files in os.walk(path):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
    except OSError:
        return 0
    return total


# --------------------------------------------------------------------------- #
# Plugin
# --------------------------------------------------------------------------- #

class Plugin:
    def __init__(self) -> None:
        self._poll_task: Optional[asyncio.Task] = None
        self._had_active = False

    # ----- library ---------------------------------------------------------- #

    async def get_games(self) -> List[Dict[str, Any]]:
        games: List[Dict[str, Any]] = []
        settings = await self.get_settings()
        enabled = settings.get("stores", {})
        for runner in RUNNERS:
            if enabled.get(runner, True) is False:
                continue
            installed_ids = _installed_ids(runner)
            for entry in _library_entries(runner):
                g = _game_dict(runner, entry, installed_ids)
                if g:
                    games.append(g)
        games.sort(key=lambda g: (g["runner"], g["title"].lower()))
        return games

    # ----- appid map -------------------------------------------------------- #

    async def get_appid_map(self) -> Dict[str, int]:
        return _read_state("appids.json", {})

    async def save_appid_map(self, mapping: Dict[str, int]) -> None:
        _write_state("appids.json", mapping)

    # ----- settings --------------------------------------------------------- #

    async def get_settings(self) -> Dict[str, Any]:
        defaults = {
            "installPath": os.path.join(_home(), "Games", "Heroic"),
            "stores": {"legendary": True, "gog": True, "nile": True},
        }
        stored = _read_state("settings.json", {})
        defaults.update(stored if isinstance(stored, dict) else {})
        return defaults

    async def set_settings(self, settings: Dict[str, Any]) -> None:
        _write_state("settings.json", settings)
        await self._deploy_wrapper_internal()

    # ----- wrapper ---------------------------------------------------------- #

    async def get_wrapper_path(self) -> str:
        return _wrapper_path()

    async def deploy_wrapper(self) -> str:
        return await self._deploy_wrapper_internal()

    async def _deploy_wrapper_internal(self) -> str:
        src = os.path.join(
            getattr(decky, "DECKY_PLUGIN_DIR", os.path.dirname(__file__)),
            "assets",
            "heroic-run.sh",
        )
        dst = _wrapper_path()
        try:
            with open(src, "r", encoding="utf-8") as fh:
                content = fh.read()
            with open(dst, "w", encoding="utf-8") as fh:
                fh.write(content)
            os.chmod(dst, 0o755)
        except Exception as exc:  # noqa: BLE001
            decky.logger.error(f"Failed to deploy wrapper: {exc}")

        # Write bridge.env with the configured install path.
        settings = await self.get_settings()
        env_path = os.path.join(_bridge_dir(), "bridge.env")
        try:
            with open(env_path, "w", encoding="utf-8") as fh:
                fh.write(f'INSTALL_PATH="{settings["installPath"]}"\n')
        except Exception as exc:  # noqa: BLE001
            decky.logger.error(f"Failed to write bridge.env: {exc}")
        return dst

    # ----- install / launch ------------------------------------------------- #

    def _protocol_cmd(self, action: str, runner: str, gid: str, path: Optional[str] = None) -> List[str]:
        url = f"heroic://{action}/{runner}/{gid}"
        if path and action == "install":
            url += f"?path={path}"
        return [*_heroic_cmd(), url]

    async def install_game(self, runner: str, gid: str) -> None:
        settings = await self.get_settings()
        path = settings.get("installPath")
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", gid)
        unit = f"heroic-install-{runner}-{safe}"
        proto = self._protocol_cmd("install", runner, gid, path)
        cmd = ["systemd-run", "--user", "--collect", f"--unit={unit}", *proto]
        # Track this install the same way tile-press installs are tracked.
        _write_marker(runner, gid, path)
        try:
            subprocess.Popen(_as_user(cmd))
        except FileNotFoundError:
            # No systemd-run available: detach so the reaper can't tree-kill it.
            subprocess.Popen(_as_user(proto), start_new_session=True)

    async def launch_game(self, runner: str, gid: str) -> None:
        subprocess.Popen(_as_user(self._protocol_cmd("launch", runner, gid)))

    async def uninstall_game(self, runner: str, gid: str) -> None:
        subprocess.Popen(_as_user(self._protocol_cmd("uninstall", runner, gid)))

    # ----- progress --------------------------------------------------------- #

    async def get_install_states(self) -> List[Dict[str, Any]]:
        return self._compute_states()

    def _read_markers(self) -> List[Dict[str, Any]]:
        markers: List[Dict[str, Any]] = []
        try:
            for name in os.listdir(_marker_dir()):
                if not name.endswith(".json"):
                    continue
                data = _load_json(os.path.join(_marker_dir(), name))
                if isinstance(data, dict) and data.get("runner") and data.get("id"):
                    markers.append(data)
        except OSError:
            pass
        return markers

    def _compute_states(self) -> List[Dict[str, Any]]:
        states: List[Dict[str, Any]] = []
        installed_cache: Dict[str, set] = {}
        for marker in self._read_markers():
            runner = marker["runner"]
            gid = marker["id"]
            if runner not in installed_cache:
                installed_cache[runner] = _installed_ids(runner)
            if gid in installed_cache[runner]:
                states.append({"runner": runner, "id": gid, "status": "installed", "progress": 1.0})
                try:
                    os.remove(_marker_file(runner, gid))
                except OSError:
                    pass
                continue
            progress = None
            target = _target_size(runner, gid)
            path = marker.get("path") or _installed_paths(runner).get(gid)
            if target and path:
                progress = min(0.99, _dir_size(path) / float(target))
            states.append(
                {"runner": runner, "id": gid, "status": "installing", "progress": progress}
            )
        return states

    async def _poll_loop(self) -> None:
        while True:
            try:
                states = self._compute_states()
                active = len(states) > 0
                # Emit while active, plus one final emit when the last completes
                # so the UI can clear itself and restore artwork.
                if active or self._had_active:
                    await decky.emit("install_states", states)
                self._had_active = active
            except Exception as exc:  # noqa: BLE001
                decky.logger.error(f"poll loop error: {exc}")
            await asyncio.sleep(3)

    # ----- artwork ---------------------------------------------------------- #

    async def fetch_art(self, url: str) -> Optional[str]:
        """Download an image URL and return base64 (frontend feeds this to
        SteamClient.Apps.SetCustomArtworkForApp, avoiding CEF CORS issues)."""
        if not url:
            return None
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "heroic-deck-bridge"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                return base64.b64encode(resp.read()).decode("ascii")
        except Exception as exc:  # noqa: BLE001
            decky.logger.warning(f"art fetch failed for {url}: {exc}")
            return None

    # ----- lifecycle -------------------------------------------------------- #

    async def _main(self) -> None:
        decky.logger.info("Heroic Deck Bridge starting")
        await self._deploy_wrapper_internal()
        self._poll_task = asyncio.get_event_loop().create_task(self._poll_loop())

    async def _unload(self) -> None:
        decky.logger.info("Heroic Deck Bridge unloading")
        if self._poll_task:
            self._poll_task.cancel()

    async def _uninstall(self) -> None:
        decky.logger.info("Heroic Deck Bridge uninstalled")
