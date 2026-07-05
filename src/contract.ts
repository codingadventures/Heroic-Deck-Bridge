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

export interface BridgeSettings {
  installPath: string;
  stores: Record<Runner, boolean>;
}

export type AppIdMap = Record<string, number>; // "runner:id" -> Steam appId

export const STORE_LABELS: Record<Runner, string> = {
  legendary: "Epic",
  gog: "GOG",
  nile: "Amazon",
};

export const RUNNERS: Runner[] = ["legendary", "gog", "nile"];

export const gameKey = (runner: Runner, id: string): string => `${runner}:${id}`;
