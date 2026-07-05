import {
  getAppIdMap,
  getGames,
  getWrapperPath,
  saveAppIdMap,
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
