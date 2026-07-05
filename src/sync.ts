import { toaster } from "@decky/api";

import {
  deleteGridArt,
  getAppIdMap,
  getGames,
  getSettings,
  getWrapperPath,
  listShortcuts,
  saveAppIdMap,
  writeGridArt,
} from "./api";
import { AppIdMap, gameKey, HeroicNativeMode } from "./contract";
import {
  addShortcut,
  applyArtwork,
  assignCollections,
  deleteHeroicCollections,
  launchOptionsFor,
  refreshLibrary,
  removeShortcut,
  shortcutExists,
  updateShortcut,
} from "./steam";

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  total: number;
}

export interface RemoveResult {
  removed: number;
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : "/";
}

function baseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

// Mirror the Heroic library into Steam as non-Steam shortcuts + collections.
//
// Reconciliation is keyed by the launch options ("<runner> <id>"), which is the
// only attribute we fully control and that stays stable across install state.
// We reconcile against the *real* shortcut list (shortcuts.vdf via the backend)
// rather than trusting the stored appId map: Steam can hand back a fresh appId
// on a later AddShortcut, so a map-only check would silently re-add a second
// copy of every game each sync (the "everything is duplicated" bug). Reading
// the actual shortcuts lets us adopt an existing card for a game and remove any
// extra duplicates instead.
export async function syncLibrary(): Promise<SyncResult> {
  const [games, wrapper, map, shortcuts, settings] = await Promise.all([
    getGames(),
    getWrapperPath(),
    getAppIdMap(),
    listShortcuts().catch((e) => {
      console.error("[HeroicDeckBridge] listShortcuts failed", e);
      return [] as Awaited<ReturnType<typeof listShortcuts>>;
    }),
    getSettings().catch((e) => {
      console.error("[HeroicDeckBridge] getSettings failed", e);
      return null;
    }),
  ]);

  const heroicNativeMode: HeroicNativeMode = settings?.heroicNative ?? "remove";
  const startDir = dirOf(wrapper);
  const wrapperName = baseName(wrapper); // e.g. "heroic-run.sh"
  const newMap: AppIdMap = {};
  let added = 0;
  let updated = 0;
  let removed = 0;

  // Group every shortcut that runs our wrapper by its launch options. Multiple
  // appIds under one launch string are duplicates we created earlier.
  //
  // Separately, index Heroic's own "Add to Steam" shortcuts (they launch via
  // `heroic://launch?appName=<id>&runner=<runner>` rather than our wrapper) by
  // game key, so we can remove the ones that collide with a card we manage.
  const oursByLaunch = new Map<string, number[]>();
  const heroicNativeByKey = new Map<string, number[]>();
  for (const sc of shortcuts) {
    const exe = (sc.exe || "").replace(/^"|"$/g, "");
    const launch = sc.launchOptions || "";
    if (exe.endsWith(wrapperName) && launch) {
      const list = oursByLaunch.get(launch);
      if (list) list.push(sc.appId);
      else oursByLaunch.set(launch, [sc.appId]);
      continue;
    }
    if (/heroic:\/\/launch/i.test(launch)) {
      const appName = launch.match(/appName=([^&"'\s]+)/i)?.[1];
      const runner = launch.match(/runner=([^&"'\s]+)/i)?.[1];
      if (appName && runner) {
        const key = `${runner}:${appName}`;
        const list = heroicNativeByKey.get(key);
        if (list) list.push(sc.appId);
        else heroicNativeByKey.set(key, [sc.appId]);
      }
    }
  }

  const desired = new Set<string>();

  for (const game of games) {
    const key = gameKey(game.runner, game.id);
    const launchOptions = launchOptionsFor(game.runner, game.id);
    desired.add(launchOptions);

    // Candidate appIds for this game, preferring the mapped one, then any live
    // shortcut already pointing at this launch string.
    const candidates: number[] = [];
    const mapped = map[key];
    if (mapped) candidates.push(mapped);
    for (const id of oursByLaunch.get(launchOptions) ?? []) {
      if (!candidates.includes(id)) candidates.push(id);
    }

    // Handle games that also have Heroic's own "Add to Steam" shortcut per the
    // user's chosen mode.
    const nativeIds = heroicNativeByKey.get(key) ?? [];
    if (nativeIds.length > 0) {
      if (heroicNativeMode === "remove") {
        // Delete Heroic's copy so only our managed card remains.
        for (const nativeId of nativeIds) {
          removeShortcut(nativeId);
          removed += 1;
        }
      } else if (heroicNativeMode === "skip") {
        // Defer to Heroic: remove our copies and don't manage this game.
        for (const dupe of candidates) {
          if (dupe) {
            removeShortcut(dupe);
            removed += 1;
          }
        }
        continue;
      }
      // "keep": leave Heroic's copy and ours both in place.
    }

    let appId = candidates.find((c) => shortcutExists(c)) ?? candidates[0] ?? 0;

    if (!appId || !shortcutExists(appId)) {
      const created = await addShortcut(game.title, wrapper, startDir, launchOptions);
      if (!created) continue;
      appId = created;
      added += 1;
    } else {
      updateShortcut(appId, game.title, launchOptions);
      updated += 1;
    }

    // Remove any other copies of this exact game (dedup old duplicates).
    for (const dupe of candidates) {
      if (dupe && dupe !== appId) {
        removeShortcut(dupe);
        removed += 1;
      }
    }

    newMap[key] = appId;

    await applyArtwork(appId, game);
    await assignCollections(appId, game);
    // Persist the same art as grid files keyed by the appId Steam just handed
    // us, so artwork survives restarts and does not depend solely on the
    // in-session SetCustomArtworkForApp call.
    try {
      await writeGridArt(appId, game.runner, game.id);
    } catch (e) {
      console.error("[HeroicDeckBridge] writeGridArt failed", e);
    }
  }

  // Prune our wrapper shortcuts for games no longer owned/enabled, including any
  // orphans left over from before the appId map existed.
  for (const [launchOptions, ids] of oursByLaunch) {
    if (desired.has(launchOptions)) continue;
    for (const id of ids) {
      removeShortcut(id);
      removed += 1;
    }
  }
  // Belt and suspenders: drop stale map entries whose shortcut we did not keep.
  for (const key of Object.keys(map)) {
    if (!(key in newMap) && shortcutExists(map[key])) {
      removeShortcut(map[key]);
      removed += 1;
    }
  }

  await saveAppIdMap(newMap);
  refreshLibrary();
  return { added, updated, removed, total: games.length };
}

// Remove every shortcut this plugin created (wrapper cards), our grid art, and
// our "Heroic - *" collections, and reset the appId map. Gives a clean slate to
// re-sync from. Heroic's own "Add to Steam" shortcuts are left alone here (they
// are not ours); a subsequent Sync will fold those in per the collision rule.
export async function removeAllShortcuts(): Promise<RemoveResult> {
  const [wrapper, map, shortcuts] = await Promise.all([
    getWrapperPath(),
    getAppIdMap(),
    listShortcuts().catch((e) => {
      console.error("[HeroicDeckBridge] listShortcuts failed", e);
      return [] as Awaited<ReturnType<typeof listShortcuts>>;
    }),
  ]);

  const wrapperName = baseName(wrapper);
  const ids = new Set<number>();
  for (const sc of shortcuts) {
    const exe = (sc.exe || "").replace(/^"|"$/g, "");
    if (exe.endsWith(wrapperName) && sc.appId) ids.add(sc.appId);
  }
  // Include mapped appIds too, in case shortcuts.vdf is stale for this session.
  for (const id of Object.values(map)) if (id) ids.add(id);

  let removed = 0;
  for (const id of ids) {
    removeShortcut(id);
    removed += 1;
  }

  await deleteHeroicCollections();
  try {
    await deleteGridArt([...ids]);
  } catch (e) {
    console.error("[HeroicDeckBridge] deleteGridArt failed", e);
  }
  await saveAppIdMap({});
  refreshLibrary();
  return { removed };
}

// --------------------------------------------------------------------------- //
// Sync controller (module-level singleton)
//
// The QAM panel component unmounts whenever the user leaves the Decky tab, so a
// local `syncing` useState is lost on return even though the sync keeps running
// in the plugin's (persistent) JS context. Hoisting the in-flight state here
// lets the button re-derive "Syncing..." on remount, and guarantees the
// completion/failure toast fires regardless of whether the panel is open.
// --------------------------------------------------------------------------- //

type SyncListener = (syncing: boolean) => void;

let syncInFlight: Promise<SyncResult> | null = null;
const syncListeners = new Set<SyncListener>();

export function isSyncing(): boolean {
  return syncInFlight !== null;
}

export function subscribeSyncing(listener: SyncListener): () => void {
  syncListeners.add(listener);
  return () => {
    syncListeners.delete(listener);
  };
}

function notifySyncing(): void {
  const state = isSyncing();
  for (const listener of syncListeners) listener(state);
}

// Start a sync (or return the one already in progress, coalescing double-taps).
export function runSync(): Promise<SyncResult> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    try {
      const res = await syncLibrary();
      toaster.toast({
        title: "Heroic Deck Bridge",
        body: `Synced ${res.total} games (+${res.added}, -${res.removed}).`,
      });
      return res;
    } catch (e) {
      console.error("[HeroicDeckBridge] sync failed", e);
      toaster.toast({
        title: "Heroic Deck Bridge",
        body: "Sync failed - see logs.",
      });
      throw e;
    } finally {
      syncInFlight = null;
      notifySyncing();
    }
  })();
  notifySyncing();
  return syncInFlight;
}

// --------------------------------------------------------------------------- //
// Remove-all controller (module-level singleton, mirrors the sync controller so
// the button state survives leaving/returning to the Decky tab).
// --------------------------------------------------------------------------- //

type RemoveListener = (removing: boolean) => void;

let removeInFlight: Promise<RemoveResult> | null = null;
const removeListeners = new Set<RemoveListener>();

export function isRemoving(): boolean {
  return removeInFlight !== null;
}

export function subscribeRemoving(listener: RemoveListener): () => void {
  removeListeners.add(listener);
  return () => {
    removeListeners.delete(listener);
  };
}

function notifyRemoving(): void {
  const state = isRemoving();
  for (const listener of removeListeners) listener(state);
}

export function runRemoveAll(): Promise<RemoveResult> {
  if (removeInFlight) return removeInFlight;
  removeInFlight = (async () => {
    try {
      const res = await removeAllShortcuts();
      toaster.toast({
        title: "Heroic Deck Bridge",
        body: `Removed ${res.removed} cards.`,
      });
      return res;
    } catch (e) {
      console.error("[HeroicDeckBridge] remove all failed", e);
      toaster.toast({
        title: "Heroic Deck Bridge",
        body: "Remove all failed - see logs.",
      });
      throw e;
    } finally {
      removeInFlight = null;
      notifyRemoving();
    }
  })();
  notifyRemoving();
  return removeInFlight;
}
