// Helpers around Steam's internal client objects. These globals exist in the
// Steam client context but are untyped, so we treat them as `any` and guard
// every call. Exact enum values / method names that can only be confirmed on
// hardware are marked VERIFY-ON-DEVICE.

import { fetchArt } from "./api";
import { HeroicGame, Runner, STORE_LABELS } from "./contract";

declare const SteamClient: any;
declare const collectionStore: any;
declare const appStore: any;

// SteamClient.Apps.SetCustomArtworkForApp asset types. VERIFY-ON-DEVICE.
export enum ELibraryAssetType {
  Capsule = 0, // vertical/portrait grid (600x900)
  Hero = 1,
  Logo = 2,
  Header = 3, // horizontal capsule (460x215)
  Icon = 4,
}

export function launchOptionsFor(runner: Runner, id: string): string {
  return `${runner} ${id}`;
}

export function shortcutExists(appId: number): boolean {
  try {
    return !!appStore?.GetAppOverviewByAppID?.(appId);
  } catch {
    return false;
  }
}

export async function addShortcut(
  title: string,
  wrapperPath: string,
  startDir: string,
  launchOptions: string
): Promise<number | null> {
  try {
    const appId: number = await SteamClient.Apps.AddShortcut(
      title,
      wrapperPath,
      startDir,
      launchOptions
    );
    if (appId) {
      SteamClient.Apps.SetShortcutLaunchOptions(appId, launchOptions);
      SteamClient.Apps.SetShortcutStartDir(appId, startDir);
    }
    return appId ?? null;
  } catch (e) {
    console.error("[HeroicDeckBridge] AddShortcut failed", e);
    return null;
  }
}

export function updateShortcut(
  appId: number,
  title: string,
  launchOptions: string
): void {
  try {
    SteamClient.Apps.SetShortcutName(appId, title);
    SteamClient.Apps.SetShortcutLaunchOptions(appId, launchOptions);
  } catch (e) {
    console.error("[HeroicDeckBridge] updateShortcut failed", e);
  }
}

export function removeShortcut(appId: number): void {
  try {
    SteamClient.Apps.RemoveShortcut(appId);
  } catch (e) {
    console.error("[HeroicDeckBridge] removeShortcut failed", e);
  }
}

async function setArt(
  appId: number,
  url: string | null | undefined,
  assetType: ELibraryAssetType
): Promise<void> {
  if (!url) return;
  try {
    const b64 = await fetchArt(url);
    if (!b64) return;
    const imageType = url.toLowerCase().endsWith(".png") ? "png" : "jpg";
    await SteamClient.Apps.SetCustomArtworkForApp(appId, b64, imageType, assetType);
  } catch (e) {
    console.error("[HeroicDeckBridge] setArt failed", e);
  }
}

export async function applyArtwork(appId: number, game: HeroicGame): Promise<void> {
  await setArt(appId, game.artSquare, ELibraryAssetType.Capsule);
  await setArt(appId, game.artHero, ELibraryAssetType.Hero);
  await setArt(appId, game.artCover, ELibraryAssetType.Header);
}

// --------------------------------------------------------------------------- //
// Collections. VERIFY-ON-DEVICE: collectionStore surface can shift between
// Steam client releases; every access is guarded.
// --------------------------------------------------------------------------- //

function findCollection(name: string): any | null {
  try {
    const list = collectionStore?.userCollections ?? [];
    return list.find((c: any) => c.displayName === name) ?? null;
  } catch {
    return null;
  }
}

async function getOrCreateCollection(name: string): Promise<any | null> {
  const existing = findCollection(name);
  if (existing) return existing;
  try {
    const col = collectionStore.NewUnsavedCollection(name, undefined, []);
    await col.Save();
    return findCollection(name) ?? col;
  } catch (e) {
    console.error("[HeroicDeckBridge] create collection failed", name, e);
    return null;
  }
}

async function addAppToCollection(appId: number, name: string): Promise<void> {
  const col = await getOrCreateCollection(name);
  if (!col) return;
  try {
    const overview = appStore.GetAppOverviewByAppID(appId);
    if (!overview) return;
    const ddc = col.AsDragDropCollection?.() ?? col;
    ddc.AddApps?.([overview]);
    await col.Save?.();
  } catch (e) {
    console.error("[HeroicDeckBridge] addAppToCollection failed", name, e);
  }
}

export async function assignCollections(appId: number, game: HeroicGame): Promise<void> {
  await addAppToCollection(appId, `Heroic - ${STORE_LABELS[game.runner]}`);
  await addAppToCollection(appId, game.installed ? "Heroic - Installed" : "Heroic - Available");
}

// Best-effort nudge so freshly added shortcuts show up without a full restart.
export function refreshLibrary(): void {
  try {
    SteamClient.Apps.RegisterForAppOverviewChanges?.();
  } catch {
    /* no-op */
  }
}
