# Heroic Deck Bridge

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin that
mirrors your [Heroic Games Launcher](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher)
library (Epic / GOG / Amazon) into Steam **Game Mode** as native carousel cards,
grouped into per-store collections. Press a not-installed card to install it via
Heroic; press an installed card to launch it. No trip to Desktop Mode.

Heroic remains the brain for **all compatibility** (Proton, prefixes,
dependencies). This plugin only mirrors your library, manages Steam shortcuts /
collections / artwork, and fires Heroic's `heroic://` protocol. That is why it is
far smaller than full Game-Mode storefronts: it contains **zero** compatibility
logic.

## How it works

- A stable wrapper script (`assets/heroic-run.sh`) backs every card. Steam derives
  a non-Steam shortcut's appID from `exe path + AppName`, so a constant wrapper +
  constant title keeps each card (and its artwork) stable regardless of install
  state. The runner/id ride in launch options, which do not affect the appID.
- Pressing a card runs the wrapper, which checks Heroic's `installed.json`:
  - installed -> `heroic://launch/<runner>/<id>` inside the Steam session.
  - not installed -> hands the download to a `systemd-run --user` transient unit
    (a different cgroup than Steam's `reaper` scope) so the download **survives
    launching or stopping another game**, and passes an explicit `?path=` so the
    headless `--no-gui` install does not stall on the path dialog.
- The Decky backend reads Heroic's library caches, runs installs/uninstalls
  through a background **job queue** (sequential, cancellable, with progress and
  toasts), and emits updates to the Quick Access Menu panel. Tile-press installs
  are folded into the same queue.
- Artwork is applied two ways for robustness: instantly via Steam's in-session
  artwork API, and persisted as **grid files** keyed by each shortcut's appId so
  it survives restarts.

```
Heroic library JSON ──> Decky backend ──> frontend
                                            │  AddShortcut / artwork / collections
                                            ▼
                                     Steam library (cards)
                                            │  press card
                                            ▼
                                     heroic-run.sh ──> Heroic (install/launch)
```

## Requirements

- Steam Deck / SteamOS Game Mode (also works on other Linux handhelds running
  Decky).
- [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) installed.
- Heroic installed as **Flatpak** (`com.heroicgameslauncher.hgl`) — native
  installs are auto-detected as a fallback.
- Log into each storefront inside Heroic at least once so its library cache is
  populated.

## Install

Download the latest `heroic-deck-bridge-*.zip` from
[Releases](https://github.com/codingadventures/Heroic-Deck-Bridge/releases) and
install it via Decky Loader (Developer -> Install from Zip), or point Decky at the
release URL.

## Usage

1. Open the plugin from the Decky menu, pick which stores to show and an install
   path, then press **Sync library to Steam**.
2. Your Heroic games appear as cards in `Heroic - Epic/GOG/Amazon` collections.
3. Press a card to install (if needed) or launch.

## Known limitations

These are the irreducible costs of surfacing a non-Steam library inside Game Mode:

- **No native download-progress bar / greyed tile.** Steam treats every shortcut
  as "installed", so state is shown via collections and the plugin panel instead.
- **Install must stay out of Steam's reaper.** Handled via `systemd-run --user` /
  the Heroic singleton; if that handoff is unavailable the plugin falls back to
  `setsid` detachment.
- **SteamOS single-app multitasking is inherently unstable** (zombie games,
  spinning-logo hangs). The plugin keeps downloads out of the reaper's reach, but
  cannot fix Game Mode multitasking generally.
- **Do not also enable Heroic's own "Add to Steam"** or you will get duplicate
  cards.
- New shortcuts may need a library refresh to appear.

> Several Steam-internal calls (artwork asset-type enum, `collectionStore`
> surface) are marked `VERIFY-ON-DEVICE` in the source and should be validated on
> real hardware, since they can shift between Steam client releases.

## Development

```bash
pnpm install
pnpm run build      # outputs dist/index.js
```

Deploy to a Deck with Decky's developer tooling (or copy the assembled plugin
folder into `~/homebrew/plugins`). The release workflow
(`.github/workflows/release.yml`) builds and publishes an installable zip on any
`v*` tag.

### Debugging on device

Game Mode has no visible console. See [docs/REMOTE_DEBUG.md](docs/REMOTE_DEBUG.md)
for the CEF remote-debugging workflow — enable remote debugging, attach a
browser to `http://<device-ip>:8081`, and filter the console on the
`[HeroicDeckBridge]` prefix. Backend logs live in
`~/homebrew/logs/Heroic Deck Bridge/`.

## Credits

This plugin adapts patterns (not verbatim code) from two other Decky projects:

- Deterministic grid-art file writing and Steam userdata resolution are modeled
  on [moraroy/NonSteamLaunchersDecky](https://github.com/moraroy/NonSteamLaunchersDecky)
  (MIT).
- The background job-queue design (sequential worker with progress/completion
  events) is modeled on
  [jurassicplayer/decky-autoflatpaks](https://github.com/jurassicplayer/decky-autoflatpaks)
  (BSD-3-Clause).

## License

BSD-3-Clause. See [LICENSE](LICENSE).
