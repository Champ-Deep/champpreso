import {
  Excalidraw,
  convertToExcalidrawElements,
  exportToBlob,
} from "@excalidraw/excalidraw";
import React from "react";
import { createRoot } from "react-dom/client";

import { STARTER_ELEMENTS } from "./starter-elements.js";
import {
  getConfig as apiGetConfig,
  saveSettings as apiSaveSettings,
  startSession as apiStartSession,
  backToSetup as apiBackToSetup,
  pauseSession as apiPauseSession,
  resumeSession as apiResumeSession,
  undoTurn as apiUndoTurn,
  interruptTurn as apiInterruptTurn,
  pinElement as apiPinElement,
  clearPins as apiClearPins,
  answerQuestion as apiAnswerQuestion,
  sendScopedEdit as apiSendScopedEdit,
  sendTypedTurn as apiSendTypedTurn,
  resetSession as apiResetSession,
} from "./api-client.js";
import { createWsClient } from "./ws-client.js";
import { startMicCapture } from "./mic-capture.js";
import {
  createExcalidrawSync,
  nativeElementsToSkeletonForSync,
} from "./excalidraw-sync.js";
import { SetupScreen } from "./screens/setup-screen.js";
import { ListeningScreen } from "./screens/listening-screen.js";
import { ReviewScreen } from "./screens/review-screen.js";

// v0.5.0: Mermaid integration. Loaded lazily on first render_mermaid call so
// the ~200KB Mermaid bundle doesn't slow first paint. The import promise is
// cached so subsequent calls are instant.
let mermaidToExcalidrawPromise = null;
async function getMermaidToExcalidraw() {
  if (!mermaidToExcalidrawPromise) {
    mermaidToExcalidrawPromise = import("@excalidraw/mermaid-to-excalidraw").catch((err) => {
      console.error("Failed to load mermaid-to-excalidraw:", err);
      mermaidToExcalidrawPromise = null;
      throw err;
    });
  }
  return mermaidToExcalidrawPromise;
}

// Model / option catalogs now live in public/model-catalog.js and are imported
// above so the legacy status-card editors and the redesigned Setup settings
// sheet share one source of truth.
// Cap the Live Transcript History so long presos don't grow the array unbounded.
// Mirrors the server-side turnHistory cap in whiteboard-session.js.
const TRANSCRIPT_HISTORY_LIMIT = 50;
const MIC_STORAGE_KEY = "champpreso.mic";
const PANEL_HIDDEN_STORAGE_KEY = "champpreso.panelHidden";

const STARTER_STAGING_ELEMENTS = [];

function fullscreenIcon(isFullscreen) {
  const paths = isFullscreen
    ? ["M3 6 H6 V3", "M10 3 V6 H13", "M13 10 H10 V13", "M6 13 V10 H3"]
    : ["M3 6 V3 H6", "M10 3 H13 V6", "M13 10 V13 H10", "M6 13 H3 V10"];
  return React.createElement(
    "svg",
    {
      width: "1em",
      height: "1em",
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.8,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    },
    ...paths.map((d, i) => React.createElement("path", { key: i, d })),
  );
}

function loadStoredMic() {
  try {
    const raw = localStorage.getItem(MIC_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { deviceId: "", label: "" };
  } catch {
    return { deviceId: "", label: "" };
  }
}

function saveStoredMic(mic) {
  localStorage.setItem(MIC_STORAGE_KEY, JSON.stringify(mic));
}

function loadStoredPanelHidden() {
  try {
    return localStorage.getItem(PANEL_HIDDEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function useExcalidrawThemeSync(apiRef, panelTheme) {
  React.useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const theme = panelTheme === "dark" ? "dark" : "light";
    const viewBackgroundColor = panelTheme === "dark" ? "#14171F" : "#fffdf8";
    api.updateScene({
      appState: {
        theme,
        viewBackgroundColor,
      },
    });
  }, [panelTheme, apiRef]);
}

// v0.15.0: turn timing for the Live Transcript History. Derive a turn's
// end-to-end duration from the turn-start / turn-end timestamps the server
// broadcasts, and format it compactly for display.
function turnDurationMs(startedAt, endedAt) {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function formatDuration(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function App() {
  const apiRef = React.useRef(null);
  const [api, setApi] = React.useState(null);
  const [mode, setMode] = React.useState("staging");
  const isLive = mode === "live";
  // Redesign vocabulary: "setup"/"listening" mirror the server's
  // toWireMode(state.mode) mapping, sent as `lifecycleMode` on the "mode"
  // WS message. `phase` additionally folds in capture:paused to produce a
  // 4th value; "review" is a client-only phase introduced by a later task
  // (never sent by the server).
  const [lifecycleMode, setLifecycleMode] = React.useState("setup");
  const [listening, setListening] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [presoStarting, setPresoStarting] = React.useState(false);
  const [agentStatus, setAgentStatus] = React.useState("idle");
  const [transcriptionEngine, setTranscriptionEngine] =
    React.useState("loading");
  const [settings, setSettings] = React.useState(null);
  const [captionText, setCaptionText] = React.useState("");
  // v0.15.0: scoped editing. Track the live Excalidraw selection so the
  // "Edit selected" bar can appear, and hold the typed instruction.
  const [selectedCount, setSelectedCount] = React.useState(0);
  const selectedIdsRef = React.useRef([]);
  const [scopedEditText, setScopedEditText] = React.useState("");
  const [scopedEditSending, setScopedEditSending] = React.useState(false);
  // v0.15.0: typed turn ("type a point to add to the board").
  const [sayText, setSayText] = React.useState("");
  const [saySending, setSaySending] = React.useState(false);
  const [error, setError] = React.useState("");
  const [micError, setMicError] = React.useState(false);
  const [agentError, setAgentError] = React.useState(false);
  const [sttError, setSttError] = React.useState(false);
  const [expandedRow, setExpandedRow] = React.useState(null);
  const [mic, setMic] = React.useState(loadStoredMic);
  const [panelHidden, setPanelHidden] = React.useState(loadStoredPanelHidden);
  const [analyser, setAnalyser] = React.useState(null);
  const [resetConfirming, setResetConfirming] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  // warmupState: { state: "idle"|"running"|"confirmed"|"exhausted"|"cancelled", attempt, maxAttempts }
  const [warmupState, setWarmupState] = React.useState({
    state: "idle",
    attempt: 0,
    maxAttempts: 8,
  });
  const [agentInstructions, setAgentInstructionsValue] = React.useState("");
  const [notesAndTranscripts, setNotesAndTranscriptsValue] = React.useState("");
  // v0.2.0 state: queue backlog, paused capture, pending clarifying question.
  const [queueStats, setQueueStats] = React.useState(null);
  const [capturePaused, setCapturePaused] = React.useState(false);
  // Redesign "halo" live surface. `endedSession` is a client-only flag the End
  // button sets to flip `phase` to "review" (Task 10 owns the Review screen and
  // the actual /review call). `nudgeSignal` carries the latest steer result so
  // the steer bar can show its applied/failed state; the bumped nonce lets the
  // ListeningScreen re-trigger the banner even on repeat outcomes.
  const [endedSession, setEndedSession] = React.useState(false);
  const [nudgeSignal, setNudgeSignal] = React.useState(null);
  const nudgeNonceRef = React.useRef(0);
  // Wall-clock timestamp of when the preso last went live. Used by the Review
  // screen to show a real session duration in its meta line.
  const sessionStartedAtRef = React.useRef(null);
  // Derived lifecycle phase: "setup" | "listening" | "paused" | "review".
  // Paused is only meaningful once listening has started; capture:paused
  // messages received before then (there shouldn't be any) are ignored.
  // "review" is a client-only phase the End button sets via `endedSession`.
  const phase = endedSession
    ? "review"
    : lifecycleMode === "listening" && capturePaused
      ? "paused"
      : lifecycleMode;
  const [pendingQuestion, setPendingQuestion] = React.useState(null);
  // v0.3.0 Aegis UI prefs. Local copy of settings.ui so UI feels instant; saves
  // debounced like agentInstructions. Defaults mirror DEFAULT_SETTINGS.ui on
  // the server.
  const [uiPrefs, setUiPrefs] = React.useState({
    themePrimary: "#FF6B35",
    backlogPosition: "below",
    statusDensity: "expand",
    captionsOn: true,
    captionMode: "presentation",
    questionPos: "top",
    paletteRow: true,
    activePalette: "champions",
    toggleBreathe: true,
    onboarding: true,
    panelTheme: "dark",
  });
  const [uiDrawerOpen, setUiDrawerOpen] = React.useState(false);
  const [statusMiniOpen, setStatusMiniOpen] = React.useState(false);
  const uiPrefsSaveTimerRef = React.useRef(null);
  // v0.7.0: agent-declared canvas zone (sketches/structured/notes). Updated
  // via the agent:zone WS event when the agent calls declare_zone.
  const [activeZone, setActiveZone] = React.useState("structured");
  // v0.12.0: toast stack for ephemeral action feedback. Each toast auto-
  // dismisses after a few seconds. Cap at 4 visible to avoid stacking forever.
  const [toasts, setToasts] = React.useState([]);
  const toastIdRef = React.useRef(0);
  // Push an ephemeral toast onto the stack. Caps at 4 visible (drops the
  // oldest) and auto-dismisses after 4s. `variant` drives the toast-<variant>
  // class (info | success | warn | error). Referenced from the WS onMessage
  // handler (interrupt / undo / pin / nudge events).
  function showToast(text, { variant = "info" } = {}) {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, text, variant }].slice(-4));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }
  function dismissToast(id) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }
  const [transcriptHistory, setTranscriptHistory] = React.useState([]);
  const transcriptHistoryEndRef = React.useRef(null);
  React.useEffect(() => {
    if (transcriptHistoryEndRef.current) {
      transcriptHistoryEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [transcriptHistory]);
  // v0.12.0: agent thinking status text. Updated from agent tool start/end
  // events so the user can see what the agent is doing in real-time.
  const [agentThinking, setAgentThinking] = React.useState("");
  // v0.13.0: re-skin Excalidraw appearance whenever panel theme flips
  useExcalidrawThemeSync(apiRef, uiPrefs.panelTheme);
  const [notesDragActive, setNotesDragActive] = React.useState(false);
  const [notesAttachFlash, setNotesAttachFlash] = React.useState("");
  const [cost, setCost] = React.useState(null);
  const audioSessionRef = React.useRef(null);
  const wsRef = React.useRef(null);
  const modeRef = React.useRef("staging");
  const stagingSceneRef = React.useRef(null);
  const screenshotTimerRef = React.useRef(null);
  const captionTimerRef = React.useRef(null);
  const resetConfirmTimerRef = React.useRef(null);
  const canvasWrapRef = React.useRef(null);
  const shellRef = React.useRef(null);
  const userElementsSyncTimerRef = React.useRef(null);
  const lastSyncedElementsHashRef = React.useRef("");
  const listeningRef = React.useRef(false);
  const agentStatusRef = React.useRef("idle");
  agentStatusRef.current = agentStatus;
  // Seed the textarea once from settings, then let the user own it locally so
  // their keystrokes don't fight the WS settings broadcast we trigger on save.
  const agentInstructionsSeededRef = React.useRef(false);
  const agentInstructionsSaveTimerRef = React.useRef(null);
  const agentInstructionsSavePromiseRef = React.useRef(Promise.resolve());
  // Same pattern for the Notes & Transcripts pane.
  const notesAndTranscriptsSeededRef = React.useRef(false);
  const notesAndTranscriptsSaveTimerRef = React.useRef(null);
  const notesAndTranscriptsSavePromiseRef = React.useRef(Promise.resolve());
  const notesAttachFlashTimerRef = React.useRef(null);

  React.useEffect(() => {
    listeningRef.current = listening;
  }, [listening]);

  React.useEffect(() => {
    try {
      localStorage.setItem(PANEL_HIDDEN_STORAGE_KEY, panelHidden ? "1" : "0");
    } catch {}
  }, [panelHidden]);
  const [isFullscreen, setIsFullscreen] = React.useState(false);

  React.useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      shellRef.current?.requestFullscreen?.();
    }
  }

  React.useEffect(() => {
    apiRef.current = api;
  }, [api]);

  React.useEffect(() => {
    return () => {
      clearTimeout(screenshotTimerRef.current);
      clearTimeout(captionTimerRef.current);
      clearTimeout(resetConfirmTimerRef.current);
      clearTimeout(userElementsSyncTimerRef.current);
      clearTimeout(agentInstructionsSaveTimerRef.current);
      clearTimeout(notesAndTranscriptsSaveTimerRef.current);
      clearTimeout(notesAttachFlashTimerRef.current);
    };
  }, []);

  React.useEffect(() => {
    if (agentInstructionsSeededRef.current) return;
    if (!settings || typeof settings.agentInstructions !== "string") return;
    setAgentInstructionsValue(settings.agentInstructions);
    agentInstructionsSeededRef.current = true;
  }, [settings]);

  React.useEffect(() => {
    if (notesAndTranscriptsSeededRef.current) return;
    if (!settings || typeof settings.notesAndTranscripts !== "string") return;
    setNotesAndTranscriptsValue(settings.notesAndTranscripts);
    notesAndTranscriptsSeededRef.current = true;
  }, [settings]);

  // Seed UI prefs from server settings on first arrival. After that the user
  // owns local state and writes back through saveSettings on change.
  const uiPrefsSeededRef = React.useRef(false);
  React.useEffect(() => {
    if (uiPrefsSeededRef.current) return;
    if (!settings || !settings.ui || typeof settings.ui !== "object") return;
    setUiPrefs((prev) => ({ ...prev, ...settings.ui }));
    uiPrefsSeededRef.current = true;
  }, [settings]);

  function patchUiPref(key, value) {
    setUiPrefs((prev) => {
      const next = { ...prev, [key]: value };
      // Debounced persist. Same pattern as agentInstructions: 400ms quiet
      // window so toggling a slider doesn't spam PUT /api/settings.
      clearTimeout(uiPrefsSaveTimerRef.current);
      uiPrefsSaveTimerRef.current = setTimeout(() => {
        uiPrefsSaveTimerRef.current = null;
        saveSettings({ ui: next }).catch((err) => setError(err.message));
      }, 400);
      return next;
    });
  }

  function handleAgentInstructionsChange(value) {
    setAgentInstructionsValue(value);
    clearTimeout(agentInstructionsSaveTimerRef.current);
    agentInstructionsSaveTimerRef.current = setTimeout(() => {
      agentInstructionsSaveTimerRef.current = null;
      agentInstructionsSavePromiseRef.current = saveSettings({
        agentInstructions: value,
      }).catch((err) => setError(err.message));
    }, 600);
  }

  async function flushAgentInstructionsSave() {
    clearTimeout(agentInstructionsSaveTimerRef.current);
    agentInstructionsSaveTimerRef.current = null;
    await agentInstructionsSavePromiseRef.current;
    agentInstructionsSavePromiseRef.current = saveSettings({
      agentInstructions,
    });
    await agentInstructionsSavePromiseRef.current;
  }

  // Cap notes/transcripts at 200K chars. That's roughly a 50-page transcript
  // and a generous ceiling for working sessions.
  const NOTES_MAX_CHARS = 200_000;
  function handleNotesAndTranscriptsChange(value) {
    const clipped = value.length > NOTES_MAX_CHARS ? value.slice(0, NOTES_MAX_CHARS) : value;
    setNotesAndTranscriptsValue(clipped);
    clearTimeout(notesAndTranscriptsSaveTimerRef.current);
    notesAndTranscriptsSaveTimerRef.current = setTimeout(() => {
      notesAndTranscriptsSaveTimerRef.current = null;
      notesAndTranscriptsSavePromiseRef.current = saveSettings({
        notesAndTranscripts: clipped,
      }).catch((err) => setError(err.message));
    }, 600);
  }

  async function flushNotesAndTranscriptsSave() {
    clearTimeout(notesAndTranscriptsSaveTimerRef.current);
    notesAndTranscriptsSaveTimerRef.current = null;
    await notesAndTranscriptsSavePromiseRef.current;
    notesAndTranscriptsSavePromiseRef.current = saveSettings({
      notesAndTranscripts,
    });
    await notesAndTranscriptsSavePromiseRef.current;
  }

  function flashNotesAttachment(message) {
    setNotesAttachFlash(message);
    clearTimeout(notesAttachFlashTimerRef.current);
    notesAttachFlashTimerRef.current = setTimeout(() => {
      notesAttachFlashTimerRef.current = null;
      setNotesAttachFlash("");
    }, 2500);
  }

  async function handleNotesDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setNotesDragActive(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    const accepted = files.filter((f) =>
      /\.(txt|md|markdown|vtt|srt|log|json|csv|html)$/i.test(f.name),
    );
    if (accepted.length === 0) {
      flashNotesAttachment("Unsupported file. Try .txt, .md, .vtt, .srt, .log, .json, .csv, .html.");
      return;
    }
    let appended = "";
    let attachedCount = 0;
    for (const file of accepted) {
      try {
        const text = await file.text();
        const stamp = `\n\n---\n# ${file.name}\n---\n\n${text.trim()}\n`;
        appended += stamp;
        attachedCount += 1;
      } catch (err) {
        flashNotesAttachment(`Failed to read ${file.name}: ${err.message}`);
      }
    }
    if (!appended) return;
    const next = (notesAndTranscripts + appended).slice(0, NOTES_MAX_CHARS);
    handleNotesAndTranscriptsChange(next);
    flashNotesAttachment(
      `Attached ${attachedCount} ${attachedCount === 1 ? "file" : "files"}.`,
    );
  }

  function clearNotesAndTranscripts() {
    if (!notesAndTranscripts) return;
    if (!confirm("Clear all notes and transcripts? This cannot be undone.")) return;
    handleNotesAndTranscriptsChange("");
  }

  // v0.8.0: Interrupt the in-flight agent turn. Server-side, this trips
  // state.interruptSignal.aborted; the next tool execute bails immediately.
  // v0.9.0: undo the last agent turn server-side. Pops the turn history
  // snapshot taken just before runAgent and restores state.elements.
  async function handleUndoTurn() {
    try {
      await apiUndoTurn();
    } catch (e) {
      setError(e.message || "Undo failed.");
    }
  }

  async function handleInterrupt() {
    try {
      await apiInterruptTurn();
    } catch (e) {
      setError(e.message || "Interrupt failed.");
    }
  }

  // v0.8.0: Pin / unpin the currently selected Excalidraw element(s). Reads
  // selection state via the Excalidraw API; pings POST /api/preso/pin for each.
  async function pinSelection() {
    const api = apiRef.current;
    if (!api) return;
    const appState = api.getAppState?.() || {};
    const sel = appState.selectedElementIds || {};
    const ids = Object.keys(sel).filter((id) => sel[id]);
    if (ids.length === 0) {
      setError("Select one or more elements first, then pin.");
      return;
    }
    try {
      for (const id of ids) {
        await apiPinElement(id);
      }
    } catch (e) {
      setError(e.message || "Pin failed.");
    }
  }

  async function clearAllPins() {
    try {
      await apiClearPins();
    } catch (e) {
      setError(e.message || "Clear pins failed.");
    }
  }

  // v0.15.0: scoped edit. Send the current selection + a typed instruction so
  // the agent edits ONLY those elements. Reads the live selection via the
  // Excalidraw API (authoritative at click time, not the throttled ref).
  async function sendScopedEditCommand(instruction) {
    const text = String(instruction ?? "").trim();
    if (!text) return;
    const api = apiRef.current;
    const appState = api?.getAppState?.() || {};
    const sel = appState.selectedElementIds || {};
    const selectedIds = Object.keys(sel).filter((id) => sel[id]);
    if (selectedIds.length === 0) {
      setError("Select one or more elements first, then describe the edit.");
      return;
    }
    setScopedEditSending(true);
    try {
      await apiSendScopedEdit({ selectedIds, instruction: text });
      setScopedEditText("");
    } catch (e) {
      setError(e.message || "Scoped edit failed.");
    } finally {
      setScopedEditSending(false);
    }
  }

  // v0.15.0: typed turn. Send a typed point as a normal transcript turn so the
  // agent diagrams it - a no-voice path to capture ideas into the canvas.
  async function sendTypedTurn(text) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return;
    setSaySending(true);
    try {
      await apiSendTypedTurn(trimmed);
      setSayText("");
    } catch (e) {
      setError(e.message || "Could not add that to the board.");
    } finally {
      setSaySending(false);
    }
  }

  // v0.8.0: Export the canvas. Three formats. Each pulls from the Excalidraw
  // scene and triggers a download in the user's browser.
  async function exportCanvas(format) {
    const api = apiRef.current;
    if (!api) return;
    const elements = api.getSceneElements?.() || [];
    const files = api.getFiles?.() || {};
    const appState = api.getAppState?.() || {};
    const filename = `champpreso-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
    try {
      if (format === "png" || format === "svg") {
        const blob = await exportToBlob({
          elements,
          appState: { ...appState, exportBackground: true, exportWithDarkMode: false },
          files,
          mimeType: format === "png" ? "image/png" : "image/svg+xml",
          getDimensions: (w, h) => ({ width: w, height: h, scale: 2 }),
        });
        downloadBlob(blob, `${filename}.${format}`);
      } else if (format === "excalidraw") {
        const scene = {
          type: "excalidraw",
          version: 2,
          source: "ChampPreso",
          elements,
          appState: { gridSize: appState.gridSize ?? null, viewBackgroundColor: appState.viewBackgroundColor ?? "#fffdf8" },
          files,
        };
        const blob = new Blob([JSON.stringify(scene, null, 2)], { type: "application/json" });
        downloadBlob(blob, `${filename}.excalidraw`);
      }
    } catch (e) {
      setError(`Export failed: ${e.message}`);
    }
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // v0.8.0: Auto-save scene + agent history to localStorage every 10s. On
  // launch a "Resume last session?" toast surfaces if a snapshot exists.
  const autoSaveTimerRef = React.useRef(null);
  React.useEffect(() => {
    if (!isLive) return;
    autoSaveTimerRef.current = setInterval(() => {
      const api = apiRef.current;
      if (!api) return;
      try {
        const elements = api.getSceneElements?.() || [];
        const snapshot = {
          savedAt: Date.now(),
          elements,
          mode: "live",
        };
        localStorage.setItem("champpreso.autosave", JSON.stringify(snapshot));
      } catch {}
    }, 10000);
    return () => {
      if (autoSaveTimerRef.current) clearInterval(autoSaveTimerRef.current);
    };
  }, [isLive]);

  // v0.9.0: Resume toast. On initial load (in STAGING), check for a recent
  // autosave snapshot. If found and < 24h old, surface the resume option.
  const [resumeOffer, setResumeOffer] = React.useState(null);
  const resumeCheckedRef = React.useRef(false);
  React.useEffect(() => {
    if (resumeCheckedRef.current) return;
    if (mode !== "staging") return;
    resumeCheckedRef.current = true;
    try {
      const raw = localStorage.getItem("champpreso.autosave");
      if (!raw) return;
      const snap = JSON.parse(raw);
      const age = Date.now() - (snap.savedAt || 0);
      const oneDayMs = 24 * 60 * 60 * 1000;
      if (age > oneDayMs) return;
      const count = Array.isArray(snap.elements) ? snap.elements.length : 0;
      if (count === 0) return;
      setResumeOffer({
        ageMin: Math.round(age / 60000),
        count,
        elements: snap.elements,
      });
    } catch {}
  }, [mode]);

  function resumeLastSession() {
    if (!resumeOffer) return;
    const api = apiRef.current;
    if (!api) {
      setError("Excalidraw not ready yet, try again in a moment.");
      return;
    }
    try {
      api.updateScene({
        elements: resumeOffer.elements,
        commitToHistory: true,
      });
      setResumeOffer(null);
    } catch (e) {
      setError(`Resume failed: ${e.message}`);
    }
  }
  function discardResumeOffer() {
    try { localStorage.removeItem("champpreso.autosave"); } catch {}
    setResumeOffer(null);
  }

  async function handlePauseToggle() {
    const next = !capturePaused;
    setCapturePaused(next); // optimistic
    try {
      await (next ? apiPauseSession() : apiResumeSession());
    } catch (e) {
      setCapturePaused(!next); // rollback
      setError(e.message || "Failed to toggle capture pause.");
    }
  }

  // End the live session from the halo's End button. Client-side only: stop mic
  // capture (matching pauseSession's audio teardown) and flip `phase` to
  // "review". The Review screen (Task 10) owns the actual POST /review so it can
  // show a loading state while the summary generates.
  async function endToReview() {
    if (listening) await stopListening();
    setEndedSession(true);
  }

  // "New session" from the Review screen. Review is client-side-only and the
  // server's state.mode is still "live". We use back-to-staging (not reset)
  // here on purpose: only back-to-staging broadcasts a "mode" WS message
  // (mode: "staging"), which the mode handler above turns into
  // setEndedSession(false) + lifecycleMode "setup" + a cleared transcript,
  // returning the user to a clean Setup screen. POST /api/session/reset clears
  // the board mid-session but stays in live mode, so it would leave the UI
  // stuck in Review. Session cost is reset by the next Start Preso.
  async function newSessionFromReview() {
    try {
      await apiBackToSetup();
    } catch (e) {
      setError(e.message || "Couldn't start a new session.");
    }
  }

  // Auto-start mic capture when the session goes live (phase "listening"). The
  // redesign has no manual "Start talking" button — the halo is live the moment
  // Setup hands off. Resuming from "paused" doesn't re-fire (listening is still
  // true because pause is server-side capture pause, not a client mic stop).
  React.useEffect(() => {
    if (phase === "listening" && !listening && !starting && !endedSession) {
      startListening();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function answerPendingQuestion(text) {
    if (!pendingQuestion) return;
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return;
    try {
      await apiAnswerQuestion({ id: pendingQuestion.id, text: trimmed });
      setPendingQuestion(null);
    } catch (e) {
      setError(e.message || "Failed to send answer.");
    }
  }

  function dismissPendingQuestion() {
    if (!pendingQuestion) return;
    answerPendingQuestion("(Skipped by user. Use your best judgment.)");
  }

  // Handle a mermaid:render event. Loads mermaid-to-excalidraw lazily,
  // parses the syntax into Excalidraw skeleton elements, converts them to
  // real elements, offsets them to the anchor position, and adds to the
  // scene via the Excalidraw API.
  async function handleMermaidRender({ syntax, anchor, scale = 1 }) {
    const api = apiRef.current;
    if (!api) {
      console.warn("Mermaid render arrived before Excalidraw API ready; skipping");
      return;
    }
    const mod = await getMermaidToExcalidraw();
    const parsed = await mod.parseMermaidToExcalidraw(syntax);
    if (!parsed || !Array.isArray(parsed.elements)) {
      throw new Error("Mermaid parse returned no elements");
    }
    // Convert skeleton → real Excalidraw elements.
    const newElements = convertToExcalidrawElements(parsed.elements, {
      regenerateIds: true,
    });
    // Offset to the anchor. mermaid-to-excalidraw produces elements anchored
    // at the origin; shift by (anchor.x, anchor.y) and apply scale.
    const ax = Number(anchor?.x) || 0;
    const ay = Number(anchor?.y) || 0;
    const s = Math.max(0.4, Math.min(3, Number(scale) || 1));
    const placed = newElements.map((el) => ({
      ...el,
      x: ((Number(el.x) || 0) * s) + ax,
      y: ((Number(el.y) || 0) * s) + ay,
      width: (Number(el.width) || 0) * s,
      height: (Number(el.height) || 0) * s,
      fontSize: el.fontSize ? Math.round(el.fontSize * s) : el.fontSize,
    }));
    // Merge into the live scene.
    const current = api.getSceneElements();
    const files = parsed.files ?? {};
    if (files && Object.keys(files).length > 0) {
      try { api.addFiles(Object.values(files)); } catch (e) { console.warn("addFiles failed:", e); }
    }
    api.updateScene({
      elements: [...current, ...placed],
      commitToHistory: true,
    });
    // Recenter on the new diagram so the speaker can see what just appeared.
    try {
      api.scrollToContent(placed, { fitToContent: true, animate: true });
    } catch {}
  }

  // Mode/status-aware canvas <-> server sync contract, extracted into
  // public/excalidraw-sync.js. Recreated each render (cheap - just closures
  // over stable refs/setters), matching the previous per-render function
  // declarations. See that module for the guard rationale.
  const {
    applyScene,
    handleExcalidrawChange,
    applyWhiteboardViewportCommand,
  } = createExcalidrawSync({
    getExcalidrawApi: () => apiRef.current,
    getMode: () => modeRef.current,
    getAgentStatus: () => agentStatusRef.current,
    getWs: () => wsRef.current,
    selectedIdsRef,
    setSelectedCount,
    userElementsSyncTimerRef,
    lastSyncedElementsHashRef,
    scheduleScreenshot: () => scheduleWhiteboardScreenshot(),
    getZoom: () => currentWhiteboardZoom(),
    setZoom: (zoom) => setWhiteboardZoom(zoom),
  });

  // Persistent WebSocket connection for the lifetime of the app.
  React.useEffect(() => {
    const wsClient = createWsClient({
      onMessage: (message) => {
        if (message.type === "config")
          setTranscriptionEngine(message.transcriptionEngine);
        if (message.type === "settings") setSettings(message.settings);
        if (message.type === "transcript:partial") {
          const text = (message.text ?? "").trim();
          if (text) {
            clearTimeout(captionTimerRef.current);
            setCaptionText(text);
          }
        }
        if (message.type === "transcript:committed") {
          const text = (message.text ?? "").trim();
          if (text) {
            clearTimeout(captionTimerRef.current);
            setCaptionText(text);
            captionTimerRef.current = setTimeout(() => setCaptionText(""), 3500);
            setTranscriptHistory((prev) => {
              if (prev.length > 0 && prev[prev.length - 1].status === "queued" && prev[prev.length - 1].text === text) {
                return prev;
              }
              return [
                ...prev,
                {
                  id: `temp-${Date.now()}-${Math.random()}`,
                  text,
                  status: "queued",
                  timestamp: new Date().toISOString()
                }
              ].slice(-TRANSCRIPT_HISTORY_LIMIT);
            });
          }
        }
        if (message.type === "agent:turn-start") {
          setTranscriptHistory((prev) => {
            const filtered = prev.filter((item) => item.status !== "queued");
            return [
              ...filtered,
              {
                id: message.turnId,
                text: message.transcript,
                status: "processing",
                timestamp: message.timestamp,
                startedAt: message.timestamp
              }
            ].slice(-TRANSCRIPT_HISTORY_LIMIT);
          });
        }
        if (message.type === "agent:turn-end") {
          setTranscriptHistory((prev) => {
            return prev.map((item) => {
              if (item.id === message.turnId) {
                return { ...item, status: "completed", durationMs: turnDurationMs(item.startedAt, message.timestamp) };
              }
              return item;
            });
          });
        }
        if (message.type === "agent:turn-error") {
          setTranscriptHistory((prev) => {
            return prev.map((item) => {
              if (item.id === message.turnId) {
                return { ...item, status: "failed", error: message.error, durationMs: turnDurationMs(item.startedAt, message.timestamp) };
              }
              return item;
            });
          });
        }
        if (message.type === "agent:status") {
          setAgentStatus(message.status);
          if (message.status === "thinking") setAgentError(false);
        }
        if (message.type === "warmup") {
          setWarmupState({
            state: message.state,
            attempt: message.attempt ?? 0,
            maxAttempts: message.maxAttempts ?? 8,
          });
        }
        if (message.type === "cost") {
          setCost({ agent: message.agent, transcription: message.transcription });
        }
        if (message.type === "mode") {
          const previousMode = modeRef.current;
          modeRef.current = message.mode;
          setMode(message.mode);
          setLifecycleMode(
            message.lifecycleMode ?? (message.mode === "live" ? "listening" : "setup"),
          );
          if (message.mode === "staging") {
            setTranscriptHistory([]);
            setEndedSession(false);
            if (previousMode === "live") {
              // Returning from live: restore the staged canvas the user was last working on.
              applyScene(stagingSceneRef.current, { recenter: true });
            }
          }
        }
        if (message.type === "whiteboard:update") {
          // Recenter when the live canvas resets to a fresh starter (Start preso, Reset session).
          const isFreshStarter =
            Array.isArray(message.elements) &&
            message.elements.length <= STARTER_ELEMENTS.length + 1;
          const cleaned = nativeElementsToSkeletonForSync(message.elements ?? []);
          lastSyncedElementsHashRef.current = JSON.stringify(cleaned);
          applyScene(message.elements, { recenter: isFreshStarter });
        }
        if (message.type === "whiteboard:viewport")
          applyWhiteboardViewportCommand(message);
        if (message.type === "error") {
          setError(message.message);
          if (/agent/i.test(message.message)) setAgentError(true);
          else setSttError(true);
        }
        if (message.type === "queue:stats") {
          setQueueStats({
            pending: message.pending ?? 0,
            buffered: message.buffered ?? 0,
            running: !!message.running,
            paused: !!message.paused,
            avgTurnMs: message.avgTurnMs ?? 0,
            ageMs: message.ageMs ?? 0,
            estimatedCatchupMs: message.estimatedCatchupMs ?? 0,
          });
        }
        if (message.type === "capture:paused") {
          setCapturePaused(!!message.paused);
        }
        if (message.type === "agent:question") {
          setPendingQuestion({
            id: message.id,
            question: message.question,
            options: Array.isArray(message.options) ? message.options : [],
            askedAt: message.askedAt,
          });
        }
        if (message.type === "agent:question-resolved") {
          setPendingQuestion((cur) => (cur && cur.id === message.id ? null : cur));
        }
        if (message.type === "mermaid:render") {
          // Render Mermaid → Excalidraw elements, then inject into the live
          // scene. The next handleExcalidrawChange will sync them back to the
          // server so subsequent agent turns see the new shapes.
          handleMermaidRender(message).catch((err) => {
            console.error("Mermaid render failed:", err);
            setError(`Mermaid render failed: ${err.message}`);
          });
        }
        if (message.type === "agent:zone") {
          const z = message.zone;
          if (z === "sketches" || z === "structured" || z === "notes") {
            setActiveZone(z);
          }
        }
        // v0.12.0: agent thinking status — tool:start fires when the agent
        // begins executing a tool. Surface a friendly description.
        if (message.type === "tool:start" || message.type === "agent:event") {
          const toolName = message.tool || message.name;
          if (toolName) {
            const friendly = {
              whiteboard_apply: "Editing the canvas",
              whiteboard_overwrite: "Rebuilding the canvas",
              render_mermaid: "Rendering Mermaid diagram",
              ask_user_question: "Asking a clarifying question",
              declare_zone: "Switching canvas zone",
            }[toolName] || `Running ${toolName}`;
            setAgentThinking(friendly);
            setTimeout(() => setAgentThinking((cur) => cur === friendly ? "" : cur), 3500);
          }
        }
        if (message.type === "agent:status" && message.status === "idle") {
          setAgentThinking("");
        }
        // v0.12.0: surface useful WS-side events as toasts
        if (message.type === "agent:interrupted") {
          showToast("Agent interrupted", { variant: "warn" });
        }
        if (message.type === "agent:undone") {
          showToast("Agent turn reverted", { variant: "info" });
        }
        if (message.type === "pin:changed") {
          if (message.pinned === true) showToast(`Pinned ${message.id ? "1 element" : ""}`, { variant: "success" });
          if (message.pinned === false && message.id) showToast("Unpinned", { variant: "info" });
          if (message.id === null && Array.isArray(message.all) && message.all.length === 0) showToast("All pins cleared", { variant: "info" });
        }
        if (message.type === "nudge:applied") {
          nudgeNonceRef.current += 1;
          setNudgeSignal({
            status: "applied",
            text: message.text || "",
            nonce: nudgeNonceRef.current,
          });
        }
        if (message.type === "nudge:failed") {
          nudgeNonceRef.current += 1;
          setNudgeSignal({
            status: "failed",
            reason: message.reason || "",
            nonce: nudgeNonceRef.current,
          });
        }
        if (message.type === "stt:dropped") {
          // Quiet, but log to console so dev can see what got filtered
          console.log(`[smart-stt] dropped (${message.reason}): ${message.text}`);
        }
      },
      onClose: () => {
        setListening(false);
        setStarting(false);
        setAgentStatus("idle");
      },
      onError: () => {
        setError("Lost connection to the server.");
      },
    });
    wsRef.current = wsClient;

    return () => {
      wsClient.close();
      wsRef.current = null;
    };
  }, []);

  // Seed the staging scene ref and the initial canvas once Excalidraw is ready.
  React.useEffect(() => {
    if (!api) return;
    if (!stagingSceneRef.current) {
      stagingSceneRef.current = convertToExcalidrawElements(
        STARTER_STAGING_ELEMENTS,
        { regenerateIds: false },
      );
    }
    let cancelled = false;
    const refresh = () => {
      if (cancelled) return;
      if (modeRef.current === "staging")
        applyScene(stagingSceneRef.current, { recenter: true });
    };
    const timer = setTimeout(refresh, 750);
    document.fonts?.ready.then(refresh).catch(() => {});
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api]);

  React.useEffect(() => {
    apiGetConfig()
      .then((config) => {
        setTranscriptionEngine(config.transcriptionEngine);
        if (config.settings) setSettings(config.settings);
      })
      .catch((err) => setError(err.message));
  }, []);

  async function saveSettings(patch) {
    setError("");
    const body = await apiSaveSettings(patch);
    setSettings(body.settings);
    setTranscriptionEngine(body.transcriptionEngine);
    setSttError(false);
    setAgentError(false);
  }

  async function cancelWarmup() {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send({ type: "warmup:cancel" });
    }
  }

  async function startAnyway() {
    // One-click: cancel the warmup loop and start listening right away. The
    // first turn may be slower (cold cache), but the user explicitly opted in.
    await cancelWarmup();
    await startListening();
  }

  async function startListening() {
    if (listening || starting) return;
    if (modeRef.current !== "live") return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("Connection not ready yet.");
      return;
    }
    setError("");
    setMicError(false);
    setSttError(false);
    setStarting(true);

    let audio = null;
    try {
      const audioSessionId = crypto.randomUUID();
      ws.send({ type: "audio:start", sessionId: audioSessionId });
      audio = await startMicCapture({
        deviceId: mic.deviceId,
        onChunk: (audioBase64) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send({ type: "audio", sessionId: audioSessionId, audio: audioBase64 });
          }
        },
      });
      setAnalyser(audio.analyser);
      audioSessionRef.current = { media: audio.media, audio, id: audioSessionId };
      setListening(true);
      setStarting(false);
    } catch (err) {
      setError(err.message);
      setMicError(true);
      setStarting(false);
      audio?.media?.getTracks().forEach((track) => track.stop());
      await audio?.close();
    }
  }

  async function stopListening() {
    const session = audioSessionRef.current;
    audioSessionRef.current = null;
    if (!session) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send({ type: "stop", sessionId: session.id });
    }
    session.media.getTracks().forEach((track) => track.stop());
    await session.audio.close();
    setAnalyser(null);
    setListening(false);
    setCaptionText("");
    clearTimeout(captionTimerRef.current);
    setAgentStatus("idle");
  }

  function toggleListening() {
    if (listening) stopListening();
    else startListening();
  }

  async function startPreso() {
    if (presoStarting) return;
    const excalidrawAPI = apiRef.current;
    if (!excalidrawAPI) {
      setError("Canvas isn't ready yet.");
      return;
    }
    setError("");
    setEndedSession(false);
    sessionStartedAtRef.current = Date.now();
    setPresoStarting(true);
    try {
      await flushAgentInstructionsSave();
      // Snapshot what the user has on the staging canvas right now.
      const stagingNative = excalidrawAPI
        .getSceneElements()
        .map((el) => ({ ...el }));
      stagingSceneRef.current = stagingNative;
      // Convert to the lean skeleton format before sending to the server. The
      // primer JSON is part of the cached prefix, so trimming volatile fields
      // (versionNonce, seed, internal binding details, etc.) shrinks the cold
      // turn footprint substantially without hurting the agent's understanding
      // of the staging layout.
      const stagingSkeleton = nativeElementsToSkeletonForSync(stagingNative);
      // Capture the full staging scene as an image so the primer carries it.
      let stagingScreenshot;
      try {
        stagingScreenshot = await captureStagingSceneAsImage(
          excalidrawAPI,
          stagingNative,
        );
      } catch (err) {
        console.warn(
          "Failed to capture staging screenshot, sending text-only primer:",
          err,
        );
      }

      await apiStartSession({
        stagingElements: stagingSkeleton,
        stagingScreenshot,
      });
      // Server broadcasts mode=live and whiteboard:update; the WS handler swaps the canvas.
    } catch (err) {
      setError(err.message);
    } finally {
      setPresoStarting(false);
    }
  }

  async function backToStaging() {
    setError("");
    if (listening) await stopListening();
    try {
      await apiBackToSetup();
      // Server broadcasts mode=staging; the WS handler restores the staged scene.
    } catch (err) {
      setError(err.message);
    }
  }

  function handleResetClick() {
    if (resetting) return;
    if (!resetConfirming) {
      setResetConfirming(true);
      resetConfirmTimerRef.current = setTimeout(
        () => setResetConfirming(false),
        3000,
      );
      return;
    }
    clearTimeout(resetConfirmTimerRef.current);
    setResetConfirming(false);
    resetSession();
  }

  async function resetSession() {
    setResetting(true);
    setError("");
    try {
      if (modeRef.current === "staging") {
        // Staging board lives on the client - just reload the starter content.
        const fresh = convertToExcalidrawElements(STARTER_STAGING_ELEMENTS, {
          regenerateIds: false,
        });
        stagingSceneRef.current = fresh;
        applyScene(fresh);
      } else {
        if (listening) await stopListening();
        clearTimeout(captionTimerRef.current);
        setCaptionText("");
        setTranscriptHistory([]);
        await apiResetSession();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setResetting(false);
    }
  }

  function currentWhiteboardZoom() {
    return apiRef.current?.getAppState().zoom?.value ?? 1;
  }

  function setWhiteboardZoom(zoom) {
    const zoomValue = Math.min(3, Math.max(0.1, Number(zoom) || 1));
    apiRef.current?.updateScene({ appState: { zoom: { value: zoomValue } } });
  }

  function scheduleWhiteboardScreenshot() {
    clearTimeout(screenshotTimerRef.current);
    screenshotTimerRef.current = setTimeout(sendWhiteboardScreenshot, 500);
  }

  async function sendWhiteboardScreenshot() {
    if (modeRef.current !== "live") return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const dataUrl = await captureCanvasDataUrl();
      if (!dataUrl) return;
      ws.send({ type: "whiteboard:screenshot", image: dataUrl });
    } catch (error) {
      console.warn("Failed to export whiteboard screenshot:", error);
    }
  }

  async function captureCanvasDataUrl() {
    const canvas = document.querySelector("canvas.excalidraw__canvas.static");
    if (!canvas) return null;
    const blob = await canvasToBlob(canvas);
    const downscaled = await downscaleBlobByHalf(blob);
    return await blobToDataUrl(downscaled);
  }

  async function captureStagingSceneAsImage(excalidrawAPI, elements) {
    if (!Array.isArray(elements) || elements.length === 0) {
      // Empty staging - no scene to render. Skip the image entirely; the
      // server's primer already drops the image part when this is falsy.
      return null;
    }
    try {
      const appState = excalidrawAPI.getAppState();
      const files = excalidrawAPI.getFiles?.() ?? {};
      const blob = await exportToBlob({
        elements,
        appState: {
          ...appState,
          exportBackground: true,
          viewBackgroundColor: "#fffdf8",
        },
        files,
        mimeType: "image/png",
      });
      const downscaled = await downscaleBlobByHalf(blob);
      return await blobToDataUrl(downscaled);
    } catch (error) {
      console.warn(
        "Failed to export staging scene, falling back to viewport canvas:",
        error,
      );
      return captureCanvasDataUrl();
    }
  }

  const micState = micError ? "error" : listening ? "active" : "idle";
  const agentState = agentError
    ? "error"
    : agentStatus === "thinking"
      ? "active"
      : "idle";
  const sttState = sttError ? "error" : listening ? "active" : "idle";
  const agentLabel = settings ? agentModelLabel(settings) : "loading...";
  const sttLabel = settings ? sttModelLabel(settings) : transcriptionEngine;
  const micLabel = mic.label || "System default";

  // Compute world hue tokens from themePrimary. The user picks one swatch in
  // the UI Settings drawer; the shell applies --p/--s/--g/--t throughout.
  const worldStyle = computeWorldStyle(uiPrefs.themePrimary);

  return React.createElement(
    "main",
    {
      className: `shell mode-${mode}${panelHidden ? " panel-hidden" : ""}`,
      "data-panel-theme": uiPrefs.panelTheme || "dark",
      style: worldStyle,
      ref: shellRef,
    },
    React.createElement(
      "section",
      { className: "canvas-wrap", ref: canvasWrapRef },
      // Setup screen (redesign). Overlays the full-bleed canvas while in the
      // pre-session "setup" phase, replacing the old staging side panel.
      phase === "setup"
        ? React.createElement(SetupScreen, {
            key: "setup-screen",
            excalidrawApi: api,
            onStarted: startPreso,
            wsClient: wsRef.current,
            warmupState,
            settings,
            onSaveSettings: saveSettings,
            agentInstructions,
            onAgentInstructionsChange: handleAgentInstructionsChange,
            mic,
            onMicChange: (next) => {
              setMic(next);
              saveStoredMic(next);
            },
            uiPrefs,
            onPatchUiPref: patchUiPref,
            starting: presoStarting,
          })
        : null,
      // Listening / Paused halo (redesign). Overlays the full-bleed canvas with
      // the top status strip, status drawer, question card, caption pill and
      // steer bar. Replaces the old live-mode side panel + canvas floaters.
      phase === "listening" || phase === "paused"
        ? React.createElement(ListeningScreen, {
            key: "listening-screen",
            paused: phase === "paused",
            listening,
            agentStatus,
            agentThinking,
            activeZone,
            cost,
            agentLabel: settings ? agentModelLabel(settings) : "Agent",
            transcriptionProvider: settings?.transcription?.provider ?? "moonshine",
            turnCount: transcriptHistory.filter((t) => t.status === "completed").length,
            captionText,
            captionsOn: uiPrefs.captionsOn,
            onToggleCaptions: (v) => patchUiPref("captionsOn", v),
            question: pendingQuestion,
            onAnswerQuestion: answerPendingQuestion,
            onSkipQuestion: dismissPendingQuestion,
            onPauseResume: handlePauseToggle,
            onUndo: handleUndoTurn,
            onPinSelection: pinSelection,
            onClearPins: clearAllPins,
            onEnd: endToReview,
            nudgeSignal,
            error,
          })
        : null,
      // Review is a client-only phase (End pressed). The canvas stays visible
      // and editable — the server's state.mode is still "live", so manual edits
      // keep syncing. The ReviewScreen calls POST /api/session/review on mount.
      phase === "review"
        ? React.createElement(ReviewScreen, {
            key: "review-screen",
            excalidrawApi: api,
            cost,
            turnCount: transcriptHistory.filter((t) => t.status === "completed").length,
            sessionStartedAt: sessionStartedAtRef.current,
            onExport: exportCanvas,
            onNewSession: newSessionFromReview,
          })
        : null,
      // v0.12.0: Toast stack. Bottom-right of the canvas.
      toasts.length > 0
        ? React.createElement(
            "div",
            { className: "toast-stack", key: "toast-stack" },
            ...toasts.map((t) =>
              React.createElement(
                "div",
                {
                  key: t.id,
                  className: `toast toast-${t.variant}`,
                  onClick: () => dismissToast(t.id),
                },
                React.createElement("span", { className: "toast-text" }, t.text),
              ),
            ),
          )
        : null,
      React.createElement(Excalidraw, {
        excalidrawAPI: setApi,
        // v0.13.0: sync Excalidraw's appearance with the Aegis panel theme.
        // theme="dark" gives the toolbar a dark skin; viewBackgroundColor sets
        // the canvas surface so shapes stay legible.
        theme: uiPrefs.panelTheme === "dark" ? "dark" : "light",
        initialData: {
          elements: convertToExcalidrawElements(STARTER_STAGING_ELEMENTS, {
            regenerateIds: false,
          }),
          appState: {
            viewBackgroundColor: uiPrefs.panelTheme === "dark" ? "#14171F" : "#fffdf8",
            theme: uiPrefs.panelTheme === "dark" ? "dark" : "light",
          },
        },
        onChange: handleExcalidrawChange,
      }),
      // v0.15.0: scoped-edit bar. Appears over the canvas when the user has a
      // selection in live mode. Type an instruction -> the agent edits ONLY the
      // selected elements. Works with zero voice.
      isLive && selectedCount > 0
        ? React.createElement(
            "div",
            { className: "scoped-edit-bar", role: "group", "aria-label": "Edit selected elements" },
            React.createElement(
              "span",
              { className: "se-count" },
              `✏️ ${selectedCount} selected`,
            ),
            React.createElement("input", {
              className: "se-input",
              type: "text",
              value: scopedEditText,
              placeholder: "Describe the edit for these…",
              disabled: scopedEditSending,
              "aria-label": "Edit instruction for the selected elements",
              onChange: (e) => setScopedEditText(e.target.value),
              onKeyDown: (e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendScopedEditCommand(scopedEditText);
                }
              },
            }),
            React.createElement(
              "button",
              {
                className: "se-send",
                type: "button",
                disabled: scopedEditSending || !scopedEditText.trim(),
                onClick: () => sendScopedEditCommand(scopedEditText),
              },
              scopedEditSending ? "Sending…" : "Edit",
            ),
          )
        : null,
    ),
  );
}

// ---------------------------------------------------------------------------
// Retained helpers used by App() after the frontend-redesign cleanup removed
// the legacy status-card / canvas-floater component library.
// ---------------------------------------------------------------------------

function agentModelLabel(settings) {
  const provider = settings.agent.provider;
  if (provider === "ollama") return settings.agent.ollama.model || "(unset)";
  if (provider === "codex") return settings.agent.codex.model;
  if (provider === "openrouter")
    return settings.agent.openrouter?.model || "(unset)";
  if (provider === "groq")
    return settings.agent.groq?.model || "(unset)";
  if (provider === "cerebras")
    return settings.agent.cerebras?.model || "(unset)";
  return settings.agent.openai.model;
}

function sttModelLabel(settings) {
  if (settings.transcription.provider === "moonshine")
    return settings.transcription.moonshine.model;
  return settings.transcription.openai.model;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas screenshot export failed."));
    }, "image/png");
  });
}

// Halve each dimension before sending to the agent. ~4x fewer pixels means
// ~4x fewer image tokens and a smaller WS payload, while shapes and labels
// stay legible enough for the model to do visual sanity checks.
async function downscaleBlobByHalf(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const w = Math.max(1, Math.floor(bitmap.width / 2));
    const h = Math.max(1, Math.floor(bitmap.height / 2));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    return await canvasToBlob(canvas);
  } catch (error) {
    console.warn("Image downscale failed, sending original:", error);
    return blob;
  }
}

function computeWorldStyle(primary) {
  const map = {
    "#FF6B35": { s: "#C2410C", g: "#FFB088", t: "#2B1308" }, // Champ Ember
    "#F26722": { s: "#D94F0A", g: "#FF8544", t: "#3A1A04" }, // Champions Group
    "#06B6D4": { s: "#0E7490", g: "#67E8F9", t: "#062A30" }, // Cyan
    "#7C5CFF": { s: "#5B3FD6", g: "#BBA9FF", t: "#1B1535" }, // Violet
    "#10B981": { s: "#047857", g: "#6EE7B7", t: "#022C22" }, // Verdant
    "#EC4899": { s: "#BE185D", g: "#F9A8D4", t: "#500724" }, // Pulse
  };
  const w = map[primary] || map["#FF6B35"];
  return { "--p": primary, "--s": w.s, "--g": w.g, "--t": w.t };
}

createRoot(document.getElementById("app")).render(React.createElement(App));
