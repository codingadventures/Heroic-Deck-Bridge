import { callable } from "@decky/api";
import {
  AppIdMap,
  BridgeSettings,
  HeroicGame,
  InstallState,
  Runner,
} from "./contract";

export const getGames = callable<[], HeroicGame[]>("get_games");
export const getInstallStates = callable<[], InstallState[]>("get_install_states");

export const installGame = callable<[runner: Runner, id: string], void>("install_game");
export const launchGame = callable<[runner: Runner, id: string], void>("launch_game");
export const uninstallGame = callable<[runner: Runner, id: string], void>("uninstall_game");

export const getAppIdMap = callable<[], AppIdMap>("get_appid_map");
export const saveAppIdMap = callable<[mapping: AppIdMap], void>("save_appid_map");

export const getSettings = callable<[], BridgeSettings>("get_settings");
export const setSettings = callable<[settings: BridgeSettings], void>("set_settings");

export const getWrapperPath = callable<[], string>("get_wrapper_path");
export const deployWrapper = callable<[], string>("deploy_wrapper");

export const fetchArt = callable<[url: string], string | null>("fetch_art");
