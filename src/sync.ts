import { toaster } from "@decky/api";

import {
  getAppIdMap,
  getGames,
  getWrapperPath,
  saveAppIdMap,
  writeGridArt,
} from "./api";
import { AppIdMap, gameKey } from "./contract";
import {
  addShortcut,
  applyArtwork,
  assignCollections,
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

function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : "/";
}

// Mirror the Heroic library into Steam as non-Steam shortcuts + collections.
// Keyed by "runner:id" -> appId so cards are stable across install state
// (the wrapper exe and title never change, so the appID never churns).
export async function syncLibrary(): Promise<SyncResult> {
  const [games, wrapper, map] = await Promise.all([
    getGames(),
    getWrapperPath(),
    getAppIdMap(),
  ]);

  const startDir = dirOf(wrapper);
  const newMap: AppIdMap = { ...map };
  const seen = new Set<string>();
  let added = 0;
  let updated = 0;
  let removed = 0;

  for (const game of games) {
    const key = gameKey(game.runner, game.id);
    seen.add(key);
    const launchOptions = launchOptionsFor(game.runner, game.id);

    let appId = map[key];
    if (!appId || !shortcutExists(appId)) {
      const created = await addShortcut(game.title, wrapper, startDir, launchOptions);
      if (!created) continue;
      appId = created;
      newMap[key] = appId;
      added += 1;
    } else {
      updateShortcut(appId, game.title, launchOptions);
      updated += 1;
    }

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

  // Prune shortcuts for games no longer owned/enabled.
  for (const key of Object.keys(map)) {
    if (!seen.has(key)) {
      removeShortcut(map[key]);
      delete newMap[key];
      removed += 1;
    }
  }

  await saveAppIdMap(newMap);
  refreshLibrary();
  return { added, updated, removed, total: games.length };
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
