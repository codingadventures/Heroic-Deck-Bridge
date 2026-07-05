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
import itertools
import json
import os
import re
import ssl
import subprocess
import urllib.request
from typing import Any, Dict, List, Optional

import decky

RUNNERS = ("legendary", "gog", "nile")

# Consistent prefix so backend logs (in ~/homebrew/logs/Heroic Deck Bridge/) and
# the CEF remote console can be filtered on a single token. See docs/REMOTE_DEBUG.md.
LOG_PREFIX = "[HeroicDeckBridge]"


def _log_info(msg: str) -> None:
    decky.logger.info(f"{LOG_PREFIX} {msg}")


def _log_warn(msg: str) -> None:
    decky.logger.warning(f"{LOG_PREFIX} {msg}")


def _log_error(msg: str) -> None:
    decky.logger.error(f"{LOG_PREFIX} {msg}")

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
# Steam userdata / grid artwork
#
# Grid-file writing is adapted from moraroy/NonSteamLaunchersDecky (MIT): the
# steamid3 resolution mirrors its game_tracker.get_steamid3, and the grid file
# naming matches the convention its scanner reads back
# ({appid}p.png portrait capsule, {appid}_hero.png, {appid}_logo.png,
# {appid}.png wide/header). Steam persists these across restarts, so writing
# them by the shortcut's own appId makes artwork robust and independent of the
# in-session SteamClient.Apps.SetCustomArtworkForApp call.
# --------------------------------------------------------------------------- #

_STEAMID64_BASE = 76561197960265728


def _steam_root() -> Optional[str]:
    for candidate in (
        os.path.join(_home(), ".steam", "root"),
        os.path.join(_home(), ".local", "share", "Steam"),
        os.path.join(_home(), ".steam", "steam"),
    ):
        if os.path.isdir(candidate):
            return candidate
    return None


def _steamid3() -> Optional[int]:
    """Resolve the active user's SteamID3 (the userdata folder name) by picking
    the most recently used account from loginusers.vdf. Adapted from NSL."""
    root = _steam_root()
    paths = []
    if root:
        paths.append(os.path.join(root, "config", "loginusers.vdf"))
    paths += [
        os.path.join(_home(), ".steam", "root", "config", "loginusers.vdf"),
        os.path.join(_home(), ".local", "share", "Steam", "config", "loginusers.vdf"),
    ]
    path = next((p for p in paths if os.path.isfile(p)), None)
    if not path:
        # Fall back to a single userdata subdir if there is exactly one.
        if root:
            udata = os.path.join(root, "userdata")
            try:
                ids = [d for d in os.listdir(udata) if d.isdigit() and d != "0"]
                if len(ids) == 1:
                    return int(ids[0])
            except OSError:
                pass
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            content = fh.read()
        users = re.findall(r'"(\d{17})"\s*\{([^}]+)\}', content, re.DOTALL)
        best_id: Optional[str] = None
        best_ts = -1
        for steamid, block in users:
            ts_match = re.search(r'"Timestamp"\s+"(\d+)"', block)
            ts = int(ts_match.group(1)) if ts_match else 0
            most_recent = re.search(r'"MostRecent"\s+"1"', block)
            score = ts + (1 << 62 if most_recent else 0)
            if score > best_ts:
                best_ts = score
                best_id = steamid
        if best_id:
            return int(best_id) - _STEAMID64_BASE
    except Exception as exc:  # noqa: BLE001
        _log_error(f"failed to resolve steamid3: {exc}")
    return None


def _grid_dir() -> Optional[str]:
    root = _steam_root()
    sid3 = _steamid3()
    if not root or sid3 is None:
        return None
    grid = os.path.join(root, "userdata", str(sid3), "config", "grid")
    try:
        os.makedirs(grid, exist_ok=True)
    except OSError as exc:
        _log_error(f"could not create grid dir {grid}: {exc}")
        return None
    return grid


def _grid_id(app_id: int) -> int:
    """Steam grid files are keyed by the unsigned 32-bit shortcut appId."""
    return int(app_id) & 0xFFFFFFFF


def _ext_for(url: str, default: str = "jpg") -> str:
    low = url.lower().split("?")[0]
    for ext in ("png", "jpg", "jpeg"):
        if low.endswith("." + ext):
            return "jpg" if ext == "jpeg" else ext
    return default


_SSL_CTX: Optional[ssl.SSLContext] = None


def _ca_file_candidates() -> List[str]:
    """CA-bundle files to try, most portable first. Decky ships its own Python
    whose built-in cert path often points at a non-existent build-time prefix,
    so we cannot trust the interpreter default. The vendored bundle
    (assets/cacert.pem, Mozilla's roots via certifi) makes this work on any
    device regardless of OS cert layout; OS/env paths are fallbacks."""
    out: List[str] = []
    plugin_dir = getattr(decky, "DECKY_PLUGIN_DIR", os.path.dirname(__file__))
    out.append(os.path.join(plugin_dir, "assets", "cacert.pem"))
    try:
        import certifi  # type: ignore

        out.append(certifi.where())
    except Exception:  # noqa: BLE001
        pass
    for env in ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
        val = os.environ.get(env)
        if val:
            out.append(val)
    try:
        dvp = ssl.get_default_verify_paths()
        for p in (dvp.cafile, dvp.openssl_cafile):
            if p:
                out.append(p)
    except Exception:  # noqa: BLE001
        pass
    out += [
        "/etc/ssl/certs/ca-certificates.crt",  # Arch/SteamOS, Debian/Ubuntu
        "/etc/pki/tls/certs/ca-bundle.crt",  # Fedora/RHEL/Bazzite
        "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",  # Fedora extracted
        "/etc/ssl/cert.pem",  # some minimal/BSD-ish layouts
        "/var/lib/ca-certificates/ca-bundle.pem",  # openSUSE
    ]
    return out


def _loaded_ok(ctx: ssl.SSLContext) -> bool:
    try:
        return ctx.cert_store_stats().get("x509_ca", 0) > 0
    except Exception:  # noqa: BLE001
        return True  # can't introspect; assume usable


def _ssl_context() -> ssl.SSLContext:
    """Build a verifying SSL context that works across devices, falling back to
    unverified only as a last resort (the only thing we fetch is public,
    non-sensitive game cover art)."""
    global _SSL_CTX
    if _SSL_CTX is not None:
        return _SSL_CTX
    seen: set = set()
    for ca in _ca_file_candidates():
        if not ca or ca in seen:
            continue
        seen.add(ca)
        if not os.path.isfile(ca):
            continue
        try:
            ctx = ssl.create_default_context(cafile=ca)
            if _loaded_ok(ctx):
                _log_info(f"using CA bundle: {ca}")
                _SSL_CTX = ctx
                return _SSL_CTX
        except Exception:  # noqa: BLE001
            continue
    # Hashed cert directory (capath) as a further fallback.
    for capath in ("/etc/ssl/certs", "/etc/pki/tls/certs"):
        if os.path.isdir(capath):
            try:
                ctx = ssl.create_default_context(capath=capath)
                if _loaded_ok(ctx):
                    _log_info(f"using CA path: {capath}")
                    _SSL_CTX = ctx
                    return _SSL_CTX
            except Exception:  # noqa: BLE001
                pass
    _log_warn("no CA bundle found; falling back to unverified TLS for art")
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    _SSL_CTX = ctx
    return ctx


def _download_bytes(url: str) -> Optional[bytes]:
    if not url:
        return None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "heroic-deck-bridge"})
        with urllib.request.urlopen(req, timeout=15, context=_ssl_context()) as resp:
            return resp.read()
    except Exception as exc:  # noqa: BLE001
        _log_warn(f"download failed for {url}: {exc}")
        return None


def _write_grid_file(grid: str, app_id: int, suffix: str, url: Optional[str]) -> bool:
    """Write one grid asset. `suffix` is the filename part after the appId, e.g.
    'p' (portrait capsule), '_hero', '_logo', or '' (wide/header)."""
    if not url:
        return False
    data = _download_bytes(url)
    if not data:
        return False
    gid = _grid_id(app_id)
    ext = _ext_for(url)
    dst = os.path.join(grid, f"{gid}{suffix}.{ext}")
    try:
        tmp = dst + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, dst)
        # Remove a stale copy written with the other common extension so Steam
        # does not pick up an outdated asset.
        other = "png" if ext == "jpg" else "jpg"
        stale = os.path.join(grid, f"{gid}{suffix}.{other}")
        if os.path.exists(stale):
            try:
                os.remove(stale)
            except OSError:
                pass
        return True
    except OSError as exc:
        _log_error(f"failed to write grid file {dst}: {exc}")
        return False


# --------------------------------------------------------------------------- #
# Plugin
# --------------------------------------------------------------------------- #

class Plugin:
    def __init__(self) -> None:
        self._poll_task: Optional[asyncio.Task] = None
        self._had_active = False
        # Background job queue (install/uninstall). Adapted from the sequential
        # worker + per-item progress/completion pattern in
        # jurassicplayer/decky-autoflatpaks (BSD-3-Clause).
        self._jobs: List[Dict[str, Any]] = []
        self._job_seq = itertools.count(1)
        self._queue_task: Optional[asyncio.Task] = None
        self._queue_wake: Optional[asyncio.Event] = None
        self._cancelled_ids: set = set()

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
            _log_error(f"Failed to deploy wrapper: {exc}")

        # Write bridge.env with the configured install path.
        settings = await self.get_settings()
        env_path = os.path.join(_bridge_dir(), "bridge.env")
        try:
            with open(env_path, "w", encoding="utf-8") as fh:
                fh.write(f'INSTALL_PATH="{settings["installPath"]}"\n')
        except Exception as exc:  # noqa: BLE001
            _log_error(f"Failed to write bridge.env: {exc}")
        return dst

    # ----- install / launch ------------------------------------------------- #

    def _protocol_cmd(self, action: str, runner: str, gid: str, path: Optional[str] = None) -> List[str]:
        url = f"heroic://{action}/{runner}/{gid}"
        if path and action == "install":
            url += f"?path={path}"
        return [*_heroic_cmd(), url]

    def _fire_install(self, runner: str, gid: str, path: Optional[str]) -> None:
        """Fire the reaper-safe install handoff via a transient user unit."""
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", gid)
        unit = f"heroic-install-{runner}-{safe}"
        proto = self._protocol_cmd("install", runner, gid, path)
        cmd = ["systemd-run", "--user", "--collect", f"--unit={unit}", *proto]
        # Track this install the same way tile-press installs are tracked, so the
        # marker-driven _poll_loop keeps dimming/undimming artwork.
        _write_marker(runner, gid, path)
        try:
            subprocess.Popen(_as_user(cmd))
        except FileNotFoundError:
            # No systemd-run available: detach so the reaper can't tree-kill it.
            subprocess.Popen(_as_user(proto), start_new_session=True)

    def _stop_install_unit(self, runner: str, gid: str) -> None:
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", gid)
        unit = f"heroic-install-{runner}-{safe}"
        for action in ("stop", "reset-failed"):
            try:
                subprocess.Popen(
                    _as_user(["systemctl", "--user", action, unit]),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except FileNotFoundError:
                break
        try:
            os.remove(_marker_file(runner, gid))
        except OSError:
            pass

    # Backwards-compatible callable: installs now flow through the queue.
    async def install_game(self, runner: str, gid: str) -> Dict[str, Any]:
        return await self.enqueue_install(runner, gid)

    async def launch_game(self, runner: str, gid: str) -> None:
        subprocess.Popen(_as_user(self._protocol_cmd("launch", runner, gid)))

    async def uninstall_game(self, runner: str, gid: str) -> Dict[str, Any]:
        return await self.enqueue_uninstall(runner, gid)

    # ----- job queue -------------------------------------------------------- #

    def _public_jobs(self) -> List[Dict[str, Any]]:
        # Return active + recently-finished jobs; prune old terminal jobs.
        return [dict(j) for j in self._jobs]

    async def _emit_queue(self) -> None:
        try:
            await decky.emit("queue_state", self._public_jobs())
        except Exception as exc:  # noqa: BLE001
            _log_error(f"emit queue_state failed: {exc}")

    def _game_title(self, runner: str, gid: str) -> str:
        for entry in _library_entries(runner):
            if _entry_id(entry) == gid:
                return entry.get("title") or entry.get("name") or gid
        return gid

    async def _enqueue(self, kind: str, runner: str, gid: str) -> Dict[str, Any]:
        # De-dupe: if an active job for this game/kind exists, return it.
        for j in self._jobs:
            if (
                j["kind"] == kind
                and j["runner"] == runner
                and j["gameId"] == gid
                and j["status"] in ("queued", "running")
            ):
                return dict(j)
        job = {
            "id": f"job-{next(self._job_seq)}",
            "kind": kind,
            "runner": runner,
            "gameId": gid,
            "title": self._game_title(runner, gid),
            "status": "queued",
            "progress": None,
            "error": None,
        }
        self._jobs.append(job)
        await self._emit_queue()
        if self._queue_wake is not None:
            self._queue_wake.set()
        return dict(job)

    async def enqueue_install(self, runner: str, gid: str) -> Dict[str, Any]:
        return await self._enqueue("install", runner, gid)

    async def enqueue_uninstall(self, runner: str, gid: str) -> Dict[str, Any]:
        return await self._enqueue("uninstall", runner, gid)

    async def get_queue(self) -> List[Dict[str, Any]]:
        return self._public_jobs()

    async def cancel_job(self, job_id: str) -> bool:
        for job in self._jobs:
            if job["id"] != job_id:
                continue
            if job["status"] == "queued":
                job["status"] = "cancelled"
                await self._emit_queue()
                return True
            if job["status"] == "running":
                # Signal the worker; it stops the unit and marks the job.
                self._cancelled_ids.add(job_id)
                if job["kind"] == "install":
                    self._stop_install_unit(job["runner"], job["gameId"])
                return True
            return False
        return False

    async def clear_finished_jobs(self) -> None:
        self._jobs = [
            j for j in self._jobs if j["status"] in ("queued", "running")
        ]
        await self._emit_queue()

    def _next_queued_job(self) -> Optional[Dict[str, Any]]:
        for job in self._jobs:
            if job["status"] == "queued":
                return job
        return None

    async def _queue_worker(self) -> None:
        assert self._queue_wake is not None
        while True:
            job = self._next_queued_job()
            if job is None:
                self._queue_wake.clear()
                await self._queue_wake.wait()
                continue
            try:
                await self._run_job(job)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                job["status"] = "failed"
                job["error"] = str(exc)
                _log_error(f"job {job['id']} crashed: {exc}")
                await self._emit_queue()

    async def _run_job(self, job: Dict[str, Any]) -> None:
        job_id = job["id"]
        runner = job["runner"]
        gid = job["gameId"]
        if job_id in self._cancelled_ids:
            self._cancelled_ids.discard(job_id)
            job["status"] = "cancelled"
            await self._emit_queue()
            return
        job["status"] = "running"
        job["progress"] = 0.0
        await self._emit_queue()
        _log_info(f"job {job_id} running: {job['kind']} {runner}:{gid}")
        if job["kind"] == "install":
            await self._run_install_job(job)
        else:
            await self._run_uninstall_job(job)

    async def _run_install_job(self, job: Dict[str, Any]) -> None:
        runner = job["runner"]
        gid = job["gameId"]
        job_id = job["id"]
        settings = await self.get_settings()
        path = settings.get("installPath")
        self._fire_install(runner, gid, path)
        target = _target_size(runner, gid)
        # No-growth detection: a launch that never starts downloading (or a
        # failed unit) should not hang the queue forever.
        STALL_LIMIT = 60  # * 3s poll ≈ 3 min with zero progress
        stalled = 0
        last_size = -1
        while True:
            await asyncio.sleep(3)
            if job_id in self._cancelled_ids:
                self._cancelled_ids.discard(job_id)
                self._stop_install_unit(runner, gid)
                job["status"] = "cancelled"
                await self._emit_queue()
                return
            if gid in _installed_ids(runner):
                job["status"] = "done"
                job["progress"] = 1.0
                # Leave the marker in place: the poll loop's _compute_states
                # emits the "installed" install_states event (which restores
                # artwork + moves collections) and removes the marker itself.
                await self._emit_queue()
                _log_info(f"job {job_id} install complete: {runner}:{gid}")
                return
            cur = 0
            gpath = _installed_paths(runner).get(gid) or path
            if gpath:
                cur = _dir_size(gpath)
            if target:
                job["progress"] = min(0.99, cur / float(target)) if target else None
            if cur <= last_size:
                stalled += 1
            else:
                stalled = 0
            last_size = cur
            await self._emit_queue()
            if stalled >= STALL_LIMIT:
                if self._install_unit_failed(runner, gid):
                    job["status"] = "failed"
                    job["error"] = "install unit failed"
                elif cur == 0:
                    job["status"] = "failed"
                    job["error"] = "no download progress detected"
                else:
                    # Some data landed but we lost the signal; treat as done-ish
                    # so the queue does not wedge. installed.json is the real
                    # completion signal; if it never arrives we surface failure.
                    job["status"] = "failed"
                    job["error"] = "install stalled"
                self._stop_install_unit(runner, gid)
                await self._emit_queue()
                _log_warn(f"job {job_id} install failed/stalled: {runner}:{gid}")
                return

    def _install_unit_failed(self, runner: str, gid: str) -> bool:
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", gid)
        unit = f"heroic-install-{runner}-{safe}"
        try:
            out = subprocess.run(
                _as_user(["systemctl", "--user", "show", "-p", "ActiveState,Result", unit]),
                capture_output=True,
                text=True,
                timeout=5,
            ).stdout
        except Exception:  # noqa: BLE001
            return False
        return "ActiveState=failed" in out or "Result=exit-code" in out

    async def _run_uninstall_job(self, job: Dict[str, Any]) -> None:
        runner = job["runner"]
        gid = job["gameId"]
        job_id = job["id"]
        subprocess.Popen(_as_user(self._protocol_cmd("uninstall", runner, gid)))
        for _ in range(40):  # ~2 min
            await asyncio.sleep(3)
            if job_id in self._cancelled_ids:
                self._cancelled_ids.discard(job_id)
                job["status"] = "cancelled"
                await self._emit_queue()
                return
            if gid not in _installed_ids(runner):
                job["status"] = "done"
                job["progress"] = 1.0
                await self._emit_queue()
                _log_info(f"job {job_id} uninstall complete: {runner}:{gid}")
                return
        job["status"] = "failed"
        job["error"] = "uninstall not confirmed"
        await self._emit_queue()

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

    def _active_job(self, runner: str, gid: str, kind: str) -> Optional[Dict[str, Any]]:
        for j in self._jobs:
            if (
                j["kind"] == kind
                and j["runner"] == runner
                and j["gameId"] == gid
                and j["status"] in ("queued", "running")
            ):
                return j
        return None

    async def _adopt_and_monitor_markers(self) -> bool:
        """Fold tile-press installs (started by the wrapper, tracked via markers)
        into the job queue so the queue view reflects every in-flight install,
        not just backend-initiated ones. The queue worker never touches these
        'adopted' jobs because they are created already-running."""
        changed = False
        markers = self._read_markers()
        marker_set = {(m["runner"], m["id"]): m for m in markers}
        installed_cache: Dict[str, set] = {}

        def installed(runner: str) -> set:
            if runner not in installed_cache:
                installed_cache[runner] = _installed_ids(runner)
            return installed_cache[runner]

        for m in markers:
            runner, gid = m["runner"], m["id"]
            if gid in installed(runner):
                continue
            if self._active_job(runner, gid, "install"):
                continue
            self._jobs.append({
                "id": f"job-{next(self._job_seq)}",
                "kind": "install",
                "runner": runner,
                "gameId": gid,
                "title": self._game_title(runner, gid),
                "status": "running",
                "progress": None,
                "error": None,
                "adopted": True,
            })
            changed = True

        for job in self._jobs:
            if not job.get("adopted") or job["status"] != "running":
                continue
            runner, gid = job["runner"], job["gameId"]
            if gid in installed(runner):
                job["status"] = "done"
                job["progress"] = 1.0
                changed = True
                continue
            m = marker_set.get((runner, gid))
            if m is None:
                job["status"] = "failed"
                job["error"] = "install ended before completion"
                changed = True
                continue
            target = _target_size(runner, gid)
            path = m.get("path") or _installed_paths(runner).get(gid)
            if target and path:
                job["progress"] = min(0.99, _dir_size(path) / float(target))
                changed = True
        return changed

    async def _poll_loop(self) -> None:
        while True:
            try:
                changed = await self._adopt_and_monitor_markers()
                states = self._compute_states()
                active = len(states) > 0
                # Emit while active, plus one final emit when the last completes
                # so the UI can clear itself and restore artwork.
                if active or self._had_active:
                    await decky.emit("install_states", states)
                self._had_active = active
                if changed:
                    await self._emit_queue()
            except Exception as exc:  # noqa: BLE001
                _log_error(f"poll loop error: {exc}")
            await asyncio.sleep(3)

    # ----- artwork ---------------------------------------------------------- #

    async def fetch_art(self, url: str) -> Optional[str]:
        """Download an image URL and return base64 (frontend feeds this to
        SteamClient.Apps.SetCustomArtworkForApp, avoiding CEF CORS issues)."""
        data = _download_bytes(url)
        return base64.b64encode(data).decode("ascii") if data else None

    async def write_grid_art(self, app_id: int, runner: str, gid: str) -> Dict[str, bool]:
        """Write persistent grid-art files for a shortcut by its Steam appId,
        using the art URLs already present in Heroic's library JSON. This makes
        artwork survive restarts and does not depend on the in-session
        SteamClient artwork call. See the NSL-derived helpers above."""
        grid = _grid_dir()
        if not grid:
            _log_warn("grid dir unavailable; skipping grid-art write")
            return {}
        entry = None
        for e in _library_entries(runner):
            if _entry_id(e) == gid:
                entry = e
                break
        if entry is None:
            return {}
        art_square = entry.get("art_square") or entry.get("art_cover")
        art_hero = entry.get("art_background") or entry.get("art_cover")
        art_cover = entry.get("art_cover") or entry.get("art_square")
        art_logo = entry.get("art_logo")
        results = {
            "capsule": _write_grid_file(grid, app_id, "p", art_square),
            "hero": _write_grid_file(grid, app_id, "_hero", art_hero),
            "wide": _write_grid_file(grid, app_id, "", art_cover),
        }
        if art_logo:
            results["logo"] = _write_grid_file(grid, app_id, "_logo", art_logo)
        _log_info(f"grid art for {runner}:{gid} appId={app_id} -> {results}")
        return results

    # ----- lifecycle -------------------------------------------------------- #

    async def _main(self) -> None:
        _log_info("starting")
        await self._deploy_wrapper_internal()
        loop = asyncio.get_event_loop()
        self._queue_wake = asyncio.Event()
        self._poll_task = loop.create_task(self._poll_loop())
        self._queue_task = loop.create_task(self._queue_worker())

    async def _unload(self) -> None:
        _log_info("unloading")
        if self._poll_task:
            self._poll_task.cancel()
        if self._queue_task:
            self._queue_task.cancel()

    async def _uninstall(self) -> None:
        _log_info("uninstalled")
