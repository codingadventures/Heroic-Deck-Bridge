// Shared backend <-> frontend contract. Frozen first so the frontend can be
// built against mocks independently of the Python backend.

export type Runner = "legendary" | "gog" | "nile";

export interface HeroicGame {
  runner: Runner;
  id: string;
  title: string;
  artSquare?: string | null;
  artCover?: string | null;
  artHero?: string | null;
  installSize?: number | null;
  installed: boolean;
}

export type InstallStatus = "installing" | "installed" | "failed";

export interface InstallState {
  runner: Runner;
  id: string;
  status: InstallStatus;
  progress?: number | null; // 0..1, null when unknown
}

// How to treat games that already have Heroic's own "Add to Steam" shortcut
// (exe=flatpak, launched via heroic://) at sync time:
//   remove - delete Heroic's copy so only our managed card remains
//   keep   - leave Heroic's copy alone and also keep ours (game shows twice)
//   skip   - defer to Heroic: remove our copy and don't manage that game
export type HeroicNativeMode = "remove" | "keep" | "skip";

export interface BridgeSettings {
  installPath: string;
  stores: Record<Runner, boolean>;
  heroicNative: HeroicNativeMode;
}

export type JobKind = "install" | "uninstall";
export type JobStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export interface Job {
  id: string;
  kind: JobKind;
  runner: Runner;
  gameId: string;
  title: string;
  status: JobStatus;
  progress?: number | null; // 0..1, null when unknown
  error?: string | null;
  adopted?: boolean; // started by a tile press, folded into the queue
}

export type AppIdMap = Record<string, number>; // "runner:id" -> Steam appId

// A non-Steam shortcut as read from shortcuts.vdf by the backend. Used to
// reconcile against reality (dedup, adopt orphans) rather than trusting the
// stored appId map, which can drift when Steam churns shortcut appIds.
export interface SteamShortcut {
  appId: number;
  name: string;
  exe: string;
  launchOptions: string;
}

export const STORE_LABELS: Record<Runner, string> = {
  legendary: "Epic",
  gog: "GOG",
  nile: "Amazon",
};

export const RUNNERS: Runner[] = ["legendary", "gog", "nile"];

export const gameKey = (runner: Runner, id: string): string => `${runner}:${id}`;
