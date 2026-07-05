// Helpers around Steam's internal client objects. These globals exist in the
// Steam client context but are untyped, so we treat them as `any` and guard
// every call. Exact enum values / method names that can only be confirmed on
// hardware are marked VERIFY-ON-DEVICE.

import { fetchArt } from "./api";
import { HeroicGame, Runner, STORE_LABELS } from "./contract";

declare const SteamClient: any;
declare const collectionStore: any;
declare const appStore: any;

// SteamClient.Apps.SetCustomArtworkForApp asset types. These values are
// cross-checked against moraroy/NonSteamLaunchersDecky's shipped createShortcut
// (Grid/portrait=0, Hero=1, Logo=2, WideGrid/header=3), so they are no longer a
// guess. Icon (4) remains unverified but is unused here.
export enum ELibraryAssetType {
  Capsule = 0, // vertical/portrait grid (600x900)
  Hero = 1,
  Logo = 2,
  Header = 3, // horizontal capsule / wide grid
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
      // AddShortcut does not reliably set these fields on all Steam builds
      // (it left every card named "heroic-run.sh"), so set them explicitly.
      SteamClient.Apps.SetShortcutName(appId, title);
      SteamClient.Apps.SetShortcutExe(appId, wrapperPath);
      SteamClient.Apps.SetShortcutStartDir(appId, startDir);
      SteamClient.Apps.SetShortcutLaunchOptions(appId, launchOptions);
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

// Render a dimmed capsule with a status overlay while a game installs. Steam
// has no native not-installed/greyed state for shortcuts, so we bake the state
// into the artwork and restore the real art on completion. The label is drawn
// live (e.g. "Downloading 45%") so the tile itself communicates progress
// without opening the QAM.
async function dimBase64(
  b64: string,
  mime: string,
  label: string
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = img.width || 600;
          canvas.height = img.height || 900;
          const ctx = canvas.getContext("2d");
          if (!ctx) return resolve(null);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          ctx.fillStyle = "rgba(0,0,0,0.6)";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = "#ffffff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.font = `bold ${Math.round(canvas.width / 11)}px sans-serif`;
          ctx.fillText(label, canvas.width / 2, canvas.height / 2);
          resolve(canvas.toDataURL("image/png").split(",")[1] ?? null);
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = `data:${mime};base64,${b64}`;
    } catch {
      resolve(null);
    }
  });
}

// Cache the fetched base capsule per art URL so redrawing the overlay on every
// progress step (see index.tsx throttling) does not re-download the image.
const baseArtCache = new Map<string, string>();

export async function markDownloading(
  appId: number,
  artUrl: string | null | undefined,
  label = "Downloading…"
): Promise<void> {
  if (!artUrl) return;
  try {
    let b64 = baseArtCache.get(artUrl);
    if (!b64) {
      const fetched = await fetchArt(artUrl);
      if (!fetched) return;
      b64 = fetched;
      baseArtCache.set(artUrl, b64);
    }
    const mime = artUrl.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    const dimmed = await dimBase64(b64, mime, label);
    if (!dimmed) return;
    await SteamClient.Apps.SetCustomArtworkForApp(
      appId,
      dimmed,
      "png",
      ELibraryAssetType.Capsule
    );
  } catch (e) {
    console.error("[HeroicDeckBridge] markDownloading failed", e);
  }
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

async function removeAppFromCollection(appId: number, name: string): Promise<void> {
  const col = findCollection(name);
  if (!col) return;
  try {
    const overview = appStore.GetAppOverviewByAppID(appId);
    if (!overview) return;
    const ddc = col.AsDragDropCollection?.() ?? col;
    ddc.RemoveApps?.([overview]);
    await col.Save?.();
  } catch (e) {
    console.error("[HeroicDeckBridge] removeAppFromCollection failed", name, e);
  }
}

export async function assignCollections(appId: number, game: HeroicGame): Promise<void> {
  await addAppToCollection(appId, `Heroic - ${STORE_LABELS[game.runner]}`);
  if (game.installed) {
    await addAppToCollection(appId, "Heroic - Installed");
    await removeAppFromCollection(appId, "Heroic - Available");
  } else {
    await addAppToCollection(appId, "Heroic - Available");
    await removeAppFromCollection(appId, "Heroic - Installed");
  }
}

// Called when an install completes: move the card from Available to Installed.
export async function moveToInstalledCollection(appId: number): Promise<void> {
  await addAppToCollection(appId, "Heroic - Installed");
  await removeAppFromCollection(appId, "Heroic - Available");
}

// Delete the "Heroic - *" collections we created (used by "Remove all").
// Removing the shortcuts already empties them, but this clears the now-empty
// collections too so nothing of ours is left behind.
export async function deleteHeroicCollections(): Promise<void> {
  try {
    const cols = (collectionStore?.userCollections ?? []).filter(
      (c: any) =>
        typeof c?.displayName === "string" &&
        c.displayName.startsWith("Heroic - ")
    );
    for (const col of cols) {
      try {
        await col.Delete?.();
      } catch (e) {
        console.error(
          "[HeroicDeckBridge] delete collection failed",
          col?.displayName,
          e
        );
      }
    }
  } catch (e) {
    console.error("[HeroicDeckBridge] deleteHeroicCollections failed", e);
  }
}

// Best-effort nudge so freshly added shortcuts show up without a full restart.
export function refreshLibrary(): void {
  try {
    SteamClient.Apps.RegisterForAppOverviewChanges?.();
  } catch {
    /* no-op */
  }
}
