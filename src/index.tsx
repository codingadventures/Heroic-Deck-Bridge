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
  cancelJob,
  clearFinishedJobs,
  getAppIdMap,
  getGames,
  getInstallStates,
  getQueue,
  getSettings,
  setSettings,
  writeGridArt,
} from "./api";
import {
  AppIdMap,
  BridgeSettings,
  gameKey,
  HeroicGame,
  InstallState,
  InstallStatus,
  Job,
  JobStatus,
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

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Installing",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const isActive = (s: JobStatus) => s === "queued" || s === "running";

function Content() {
  const [settings, setLocalSettings] = useState<BridgeSettings | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [syncing, setSyncing] = useState(false);

  const gamesRef = useRef<Record<string, HeroicGame>>({});
  const appIdRef = useRef<AppIdMap>({});
  const prevStatusRef = useRef<Record<string, InstallStatus>>({});
  const prevJobStatusRef = useRef<Record<string, JobStatus>>({});

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
        void writeGridArt(appId, s.runner, s.id).catch(() => undefined);
        void moveToInstalledCollection(appId);
        toaster.toast({
          title: "Heroic Deck Bridge",
          body: `${game?.title ?? s.id} installed`,
        });
      }
      prevStatusRef.current[key] = s.status;
    }
  };

  const handleQueue = (next: Job[]) => {
    setJobs(next);
    for (const job of next) {
      const prev = prevJobStatusRef.current[job.id];
      if (prev !== job.status) {
        // An install that fails or is cancelled leaves the tile showing the
        // dimmed "Downloading..." capsule; restore the real artwork.
        if (
          job.kind === "install" &&
          (job.status === "failed" || job.status === "cancelled")
        ) {
          const key = gameKey(job.runner, job.gameId);
          const appId = appIdRef.current[key];
          const game = gamesRef.current[key];
          if (appId && game) void applyArtwork(appId, game);
        }
        if (job.status === "done" && job.kind === "uninstall") {
          toaster.toast({
            title: "Heroic Deck Bridge",
            body: `${job.title} uninstalled`,
          });
        } else if (job.status === "failed") {
          toaster.toast({
            title: "Heroic Deck Bridge",
            body: `${job.title} ${job.kind} failed${job.error ? `: ${job.error}` : ""}`,
          });
        } else if (job.status === "cancelled") {
          toaster.toast({
            title: "Heroic Deck Bridge",
            body: `${job.title} ${job.kind} cancelled`,
          });
        }
      }
      prevJobStatusRef.current[job.id] = job.status;
    }
  };

  useEffect(() => {
    getSettings().then(setLocalSettings).catch(() => undefined);
    void refreshMaps();
    getInstallStates().then((s) => void handleStates(s)).catch(() => undefined);
    getQueue().then(handleQueue).catch(() => undefined);
    const stateListener = addEventListener<[states: InstallState[]]>(
      "install_states",
      (states) => void handleStates(states)
    );
    const queueListener = addEventListener<[queue: Job[]]>(
      "queue_state",
      (queue) => handleQueue(queue)
    );
    return () => {
      removeEventListener("install_states", stateListener);
      removeEventListener("queue_state", queueListener);
    };
  }, []);

  const onCancel = async (jobId: string) => {
    try {
      await cancelJob(jobId);
    } catch (e) {
      console.error("[HeroicDeckBridge] cancelJob failed", e);
    }
  };

  const onClearFinished = async () => {
    try {
      await clearFinishedJobs();
    } catch (e) {
      console.error("[HeroicDeckBridge] clearFinishedJobs failed", e);
    }
  };

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

      {jobs.length > 0 && (
        <PanelSection title="Queue">
          {jobs.map((job) => (
            <PanelSectionRow key={job.id}>
              <div style={{ width: "100%" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "0.85rem",
                  }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {job.title}
                  </span>
                  <span style={{ opacity: 0.7, flexShrink: 0, marginLeft: 8 }}>
                    {STATUS_LABEL[job.status]}
                    {job.status === "running" && typeof job.progress === "number"
                      ? ` ${Math.round(job.progress * 100)}%`
                      : ""}
                  </span>
                </div>
                {isActive(job.status) && (
                  <ButtonItem
                    layout="below"
                    onClick={() => void onCancel(job.id)}
                  >
                    Cancel
                  </ButtonItem>
                )}
              </div>
            </PanelSectionRow>
          ))}
          {jobs.some((j) => !isActive(j.status)) && (
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={() => void onClearFinished()}>
                Clear finished
              </ButtonItem>
            </PanelSectionRow>
          )}
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
