import {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  TextField,
  ToggleField,
  staticClasses,
} from "@decky/ui";
import {
  addEventListener,
  removeEventListener,
  definePlugin,
  toaster,
} from "@decky/api";
import { useEffect, useRef, useState } from "react";
import { FaGamepad } from "react-icons/fa";

import {
  getAppIdMap,
  getGames,
  getInstallStates,
  getSettings,
  setSettings,
} from "./api";
import {
  AppIdMap,
  BridgeSettings,
  gameKey,
  HeroicGame,
  InstallState,
  InstallStatus,
  Runner,
  RUNNERS,
  STORE_LABELS,
} from "./contract";
import {
  applyArtwork,
  markDownloading,
  moveToInstalledCollection,
} from "./steam";
import { syncLibrary } from "./sync";

function Content() {
  const [settings, setLocalSettings] = useState<BridgeSettings | null>(null);
  const [installs, setInstalls] = useState<InstallState[]>([]);
  const [syncing, setSyncing] = useState(false);

  const gamesRef = useRef<Record<string, HeroicGame>>({});
  const appIdRef = useRef<AppIdMap>({});
  const prevStatusRef = useRef<Record<string, InstallStatus>>({});

  const refreshMaps = async () => {
    try {
      const [games, map] = await Promise.all([getGames(), getAppIdMap()]);
      const byKey: Record<string, HeroicGame> = {};
      for (const g of games) byKey[gameKey(g.runner, g.id)] = g;
      gamesRef.current = byKey;
      appIdRef.current = map;
    } catch {
      /* keep previous maps */
    }
  };

  const handleStates = async (states: InstallState[]) => {
    setInstalls(states);
    for (const s of states) {
      const key = gameKey(s.runner, s.id);
      const prev = prevStatusRef.current[key];
      const appId = appIdRef.current[key];
      const game = gamesRef.current[key];
      if (appId && s.status === "installing" && prev !== "installing") {
        void markDownloading(appId, game?.artSquare ?? null);
      }
      if (appId && s.status === "installed" && prev !== "installed") {
        if (game) void applyArtwork(appId, { ...game, installed: true });
        void moveToInstalledCollection(appId);
        toaster.toast({
          title: "Heroic Deck Bridge",
          body: `${game?.title ?? s.id} installed`,
        });
      }
      prevStatusRef.current[key] = s.status;
    }
  };

  useEffect(() => {
    getSettings().then(setLocalSettings).catch(() => undefined);
    void refreshMaps();
    getInstallStates().then((s) => void handleStates(s)).catch(() => undefined);
    const listener = addEventListener<[states: InstallState[]]>(
      "install_states",
      (states) => void handleStates(states)
    );
    return () => removeEventListener("install_states", listener);
  }, []);

  const persist = async (next: BridgeSettings) => {
    setLocalSettings(next);
    try {
      await setSettings(next);
    } catch (e) {
      console.error("[HeroicDeckBridge] setSettings failed", e);
    }
  };

  const toggleStore = (runner: Runner, checked: boolean) => {
    if (!settings) return;
    void persist({ ...settings, stores: { ...settings.stores, [runner]: checked } });
  };

  const onSync = async () => {
    setSyncing(true);
    try {
      const res = await syncLibrary();
      await refreshMaps();
      toaster.toast({
        title: "Heroic Deck Bridge",
        body: `Synced ${res.total} games (+${res.added}, -${res.removed}).`,
      });
    } catch (e) {
      console.error("[HeroicDeckBridge] sync failed", e);
      toaster.toast({ title: "Heroic Deck Bridge", body: "Sync failed - see logs." });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <PanelSection title="Library">
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={onSync} disabled={syncing}>
            {syncing ? "Syncing..." : "Sync library to Steam"}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ fontSize: "0.8rem", opacity: 0.7 }}>
            Creates a card for every owned game grouped into Heroic collections.
            Press a not-installed card to install it via Heroic.
          </div>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Stores">
        {RUNNERS.map((runner) => (
          <PanelSectionRow key={runner}>
            <ToggleField
              label={STORE_LABELS[runner]}
              checked={settings?.stores?.[runner] ?? true}
              onChange={(checked: boolean) => toggleStore(runner, checked)}
            />
          </PanelSectionRow>
        ))}
      </PanelSection>

      <PanelSection title="Install location">
        <PanelSectionRow>
          <TextField
            label="Install path"
            value={settings?.installPath ?? ""}
            onChange={(e: any) =>
              settings && setLocalSettings({ ...settings, installPath: e.target.value })
            }
            onBlur={() => settings && void persist(settings)}
          />
        </PanelSectionRow>
      </PanelSection>

      {installs.length > 0 && (
        <PanelSection title="Installing">
          {installs.map((s) => (
            <PanelSectionRow key={`${s.runner}:${s.id}`}>
              <div style={{ fontSize: "0.85rem" }}>
                {s.id} - {s.status}
                {typeof s.progress === "number"
                  ? ` (${Math.round(s.progress * 100)}%)`
                  : ""}
              </div>
            </PanelSectionRow>
          ))}
        </PanelSection>
      )}

      <PanelSection title="Notes">
        <PanelSectionRow>
          <div style={{ fontSize: "0.75rem", opacity: 0.7 }}>
            Disable Heroic's own "Add to Steam" to avoid duplicate cards.
            Installs run outside Steam's game session so they survive launching
            another game.
          </div>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}

export default definePlugin(() => {
  return {
    name: "Heroic Deck Bridge",
    titleView: <div className={staticClasses.Title}>Heroic Deck Bridge</div>,
    content: <Content />,
    icon: <FaGamepad />,
    onDismount() {
      /* per-panel listeners clean up themselves */
    },
  };
});
