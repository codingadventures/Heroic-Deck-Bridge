# Remote debugging Heroic Deck Bridge

Game Mode has no visible console, so the reliable way to see what the plugin is
doing on a real Steam Deck is Steam's built-in CEF (Chromium) remote debugger
plus the plugin's own backend log. Both are filtered on a single token:
`[HeroicDeckBridge]`.

This workflow mirrors the one documented by
[decky-autoflatpaks](https://github.com/jurassicplayer/decky-autoflatpaks).

## 1. Enable CEF remote debugging

1. On the Deck, open Steam **Settings → System**.
2. Turn on **Enable Steam Remote Debugging** (a.k.a. "Allow Remote CEF
   Debugging").
3. Restart Steam so it opens the debugging port (`8081`).

> Enabling remote debugging opens a local, unauthenticated port. Only use it on
> a trusted network and turn it back off when you are done.

## 2. Attach from a desktop browser

1. Put the Deck and your computer on the same network and note the Deck's IP
   (Settings → Internet, or `ip addr` in a terminal).
2. In a Chromium-based browser on your computer, browse to
   `http://<device-ip>:8081`.
3. Pick the **SharedJSContext** target (this is where Steam UI + Decky plugins
   run), then open **Console**.

You can also browse `http://localhost:8081` directly on the Deck in Desktop
Mode.

## 3. Filter for this plugin

In the console filter box, type:

```
[HeroicDeckBridge]
```

Every frontend log this plugin emits is prefixed with that token, so the filter
isolates our logging from the rest of the very noisy Steam console. Useful
things to watch:

- `AddShortcut` / `writeGridArt` / `applyArtwork` results during **Sync**.
- `queue_state` / `install_states` driven UI updates during installs.
- Any `... failed` lines (collections, artwork, cancel, sync).

To capture a verbose log for a bug report, right-click in the console → **Save
as...**, or enable "Preserve log" before reproducing the issue.

## 4. Backend logs

The Python backend logs to Decky's per-plugin log file on the device:

```
~/homebrew/logs/Heroic Deck Bridge/
```

Backend lines are prefixed the same way (`[HeroicDeckBridge] ...`) so you can
`grep` them:

```bash
grep '\[HeroicDeckBridge\]' ~/homebrew/logs/Heroic\ Deck\ Bridge/*.log
```

The backend log is the place to look for install-queue transitions, grid-art
paths, `systemd-run --user` handoffs, and Heroic library-parsing problems.

## 5. Handy things to reproduce with the console open

- **Sync library to Steam** — verifies shortcut creation, artwork, grid-file
  writing, and collection assignment.
- **Press a not-installed card** — the wrapper fires a `systemd-run --user`
  install; the backend adopts it into the queue and reports progress.
- **Cancel a queued/running job** — confirms `cancel_job` stops the transient
  unit and updates the queue.
