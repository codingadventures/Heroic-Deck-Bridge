import { callable } from "@decky/api";
import {
  AppIdMap,
  BridgeSettings,
  HeroicGame,
  InstallState,
  Job,
  Runner,
  SteamShortcut,
} from "./contract";

export const getGames = callable<[], HeroicGame[]>("get_games");
export const getInstallStates = callable<[], InstallState[]>("get_install_states");

export const installGame = callable<[runner: Runner, id: string], Job>("install_game");
export const launchGame = callable<[runner: Runner, id: string], void>("launch_game");
export const uninstallGame = callable<[runner: Runner, id: string], Job>("uninstall_game");

// Background job queue.
export const enqueueInstall = callable<[runner: Runner, id: string], Job>("enqueue_install");
export const enqueueUninstall = callable<[runner: Runner, id: string], Job>("enqueue_uninstall");
export const getQueue = callable<[], Job[]>("get_queue");
export const cancelJob = callable<[jobId: string], boolean>("cancel_job");
export const clearFinishedJobs = callable<[], void>("clear_finished_jobs");

export const getAppIdMap = callable<[], AppIdMap>("get_appid_map");
export const saveAppIdMap = callable<[mapping: AppIdMap], void>("save_appid_map");

// Real non-Steam shortcuts from shortcuts.vdf, used to reconcile/dedup.
export const listShortcuts = callable<[], SteamShortcut[]>("list_shortcuts");

export const getSettings = callable<[], BridgeSettings>("get_settings");
export const setSettings = callable<[settings: BridgeSettings], void>("set_settings");

export const getWrapperPath = callable<[], string>("get_wrapper_path");
export const deployWrapper = callable<[], string>("deploy_wrapper");

export const fetchArt = callable<[url: string], string | null>("fetch_art");

// Persist grid-art files by the shortcut's Steam appId (survives restarts).
export const writeGridArt =
  callable<[appId: number, runner: Runner, id: string], Record<string, boolean>>(
    "write_grid_art"
  );

// Delete the grid-art files we wrote for the given appIds (used by "Remove all").
export const deleteGridArt =
  callable<[appIds: number[]], number>("delete_grid_art");
