import {
  ButtonItem,
  ConfirmModal,
  DropdownItem,
  PanelSection,
  PanelSectionRow,
  ProgressBarWithInfo,
  TextField,
  ToggleField,
  showModal,
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
  HeroicNativeMode,
  InstallPhase,
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
import {
  isRemoving,
  isSyncing,
  runRemoveAll,
  runSync,
  subscribeRemoving,
  subscribeSyncing,
} from "./sync";

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Installing",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const PHASE_LABEL: Record<InstallPhase, string> = {
  queued: "Queued",
  downloading: "Downloading",
  verifying: "Verifying",
  installing: "Installing",
  done: "Ready",
};

const isActive = (s: JobStatus) => s === "queued" || s === "running";

function formatBytes(n?: number | null): string | null {
  if (typeof n !== "number" || n <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i <= 1 ? 0 : 1)} ${units[i]}`;
}

function formatEta(s?: number | null): string | null {
  if (typeof s !== "number" || s <= 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

const pctOf = (progress?: number | null): number | null =>
  typeof progress === "number" ? Math.round(progress * 100) : null;

function Content() {
  const [settings, setLocalSettings] = useState<BridgeSettings | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [syncing, setSyncing] = useState(isSyncing());
  const [removing, setRemoving] = useState(isRemoving());

  const gamesRef = useRef<Record<string, HeroicGame>>({});
  const appIdRef = useRef<AppIdMap>({});
  const prevStatusRef = useRef<Record<string, InstallStatus>>({});
  const prevJobStatusRef = useRef<Record<string, JobStatus>>({});
  // Throttle live tile-capsule redraws to ~10% steps (plus phase changes) so we
  // don't repaint artwork on every 3s poll.
  const tileTagRef = useRef<Record<string, string>>({});

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
      if (appId && s.status === "installing") {
        const phase: InstallPhase = s.phase ?? "downloading";
        const pct = pctOf(s.progress);
        const label =
          pct !== null ? `${PHASE_LABEL[phase]} ${pct}%` : `${PHASE_LABEL[phase]}…`;
        // Only repaint on a phase change or a new 10% bucket (or the first tick).
        const bucket = pct === null ? -1 : Math.floor(pct / 10);
        const tag = `${phase}:${bucket}`;
        if (tileTagRef.current[key] !== tag) {
          tileTagRef.current[key] = tag;
          void markDownloading(appId, game?.artSquare ?? null, label);
        }
      }
      if (appId && s.status === "installed" && prev !== "installed") {
        if (game) void applyArtwork(appId, { ...game, installed: true });
        void writeGridArt(appId, s.runner, s.id).catch(() => undefined);
        void moveToInstalledCollection(appId);
        delete tileTagRef.current[key];
        toaster.toast({
          title: "Heroic Deck Bridge",
          body: `▶ ${game?.title ?? s.id} ready to play`,
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
          delete tileTagRef.current[key];
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
    // Reflect the module-level sync state so the button survives leaving and
    // returning to the Decky tab; refresh maps when a sync finishes.
    const unsubscribeSync = subscribeSyncing((state) => {
      setSyncing(state);
      if (!state) void refreshMaps();
    });
    const unsubscribeRemove = subscribeRemoving((state) => {
      setRemoving(state);
      if (!state) void refreshMaps();
    });
    return () => {
      removeEventListener("install_states", stateListener);
      removeEventListener("queue_state", queueListener);
      unsubscribeSync();
      unsubscribeRemove();
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

  const setHeroicNative = (mode: HeroicNativeMode) => {
    if (!settings) return;
    void persist({ ...settings, heroicNative: mode });
  };

  const onSync = async () => {
    try {
      await runSync();
      await refreshMaps();
    } catch {
      /* toast + logging handled by the sync controller */
    }
  };

  const onRemoveAll = () => {
    showModal(
      <ConfirmModal
        strTitle="Remove all Heroic cards?"
        strDescription={
          "This deletes every Steam card this plugin created, its artwork, and " +
          "the Heroic collections, and resets the appId map. Your Heroic " +
          "installs are untouched. You can re-create everything with Sync."
        }
        strOKButtonText="Remove all"
        strCancelButtonText="Cancel"
        onOK={() => {
          void (async () => {
            try {
              await runRemoveAll();
              await refreshMaps();
            } catch {
              /* toast + logging handled by the controller */
            }
          })();
        }}
      />
    );
  };

  return (
    <>
      <PanelSection title="Library">
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={onSync}
            disabled={syncing || removing}
          >
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

      <PanelSection title="Heroic 'Add to Steam' games">
        <PanelSectionRow>
          <DropdownItem
            label="If already added by Heroic"
            rgOptions={[
              { data: "remove", label: "Remove Heroic's copy" },
              { data: "keep", label: "Keep both" },
              { data: "skip", label: "Use Heroic's copy" },
            ]}
            selectedOption={settings?.heroicNative ?? "remove"}
            onChange={(opt: { data: HeroicNativeMode }) =>
              setHeroicNative(opt.data)
            }
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ fontSize: "0.75rem", opacity: 0.7 }}>
            For games you also added via Heroic's own "Add to Steam": remove
            Heroic's card so only ours remains, keep both, or defer to Heroic's
            card and skip managing that game.
          </div>
        </PanelSectionRow>
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
          {jobs.map((job) => {
            const phase: InstallPhase =
              job.phase ?? (job.status === "queued" ? "queued" : "downloading");
            const pct = pctOf(job.progress);
            const bytes =
              job.kind === "install"
                ? job.bytesTotal
                  ? `${formatBytes(job.bytesDone) ?? "…"} / ${formatBytes(job.bytesTotal)}`
                  : formatBytes(job.bytesDone)
                : null;
            const eta = formatEta(job.etaSeconds);
            // A running install with no numeric progress yet is honestly
            // indeterminate rather than pretending to be at 0%.
            const showBar = job.status === "running";
            const indeterminate = pct === null;
            const opText =
              job.kind === "uninstall"
                ? "Uninstalling…"
                : [PHASE_LABEL[phase], bytes].filter(Boolean).join(" · ");
            const rightLabel =
              job.status === "running"
                ? PHASE_LABEL[phase]
                : STATUS_LABEL[job.status];
            return (
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
                      {rightLabel}
                    </span>
                  </div>
                  {job.status === "done" && job.kind === "install" && (
                    <div
                      style={{ marginTop: 4, fontSize: "0.8rem", opacity: 0.9 }}
                    >
                      ▶ Ready to play
                    </div>
                  )}
                  {showBar && (
                    <div style={{ marginTop: 6 }}>
                      <ProgressBarWithInfo
                        nProgress={pct ?? 0}
                        indeterminate={indeterminate}
                        sOperationText={opText}
                        sTimeRemaining={eta ?? undefined}
                      />
                    </div>
                  )}
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
            );
          })}
          {jobs.some((j) => !isActive(j.status)) && (
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={() => void onClearFinished()}>
                Clear finished
              </ButtonItem>
            </PanelSectionRow>
          )}
        </PanelSection>
      )}

      <PanelSection title="Maintenance">
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={onRemoveAll}
            disabled={syncing || removing}
          >
            {removing ? "Removing..." : "Remove all Heroic cards"}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ fontSize: "0.75rem", opacity: 0.7 }}>
            Deletes every card this plugin created (plus its art and
            collections) for a clean slate. Your Heroic installs are untouched.
          </div>
        </PanelSectionRow>
      </PanelSection>

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
