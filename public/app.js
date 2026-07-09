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
  sendNudge as apiSendNudge,
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
import {
  REASONING_EFFORTS,
  OPENAI_AGENT_MODELS,
  CODEX_AGENT_MODELS,
  GROQ_AGENT_MODELS,
  CEREBRAS_AGENT_MODELS,
  OPENROUTER_AGENT_MODELS,
  OPENAI_TRANSCRIPTION_MODELS,
  MOONSHINE_MODELS,
} from "./model-catalog.js";

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
      // Review is a client-only phase (End pressed). Task 10 builds the real
      // Review screen; until then show a minimal placeholder so the canvas stays
      // visible and editable.
      phase === "review"
        ? React.createElement(
            "div",
            { className: "review-placeholder", key: "review-placeholder" },
            "Session ended. Review screen coming soon.",
          )
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

const CAPTION_MAX_CHARS = 70;

function truncateCaption(text) {
  if (!text || text.length <= CAPTION_MAX_CHARS) return text;
  const tail = text.slice(-CAPTION_MAX_CHARS);
  const space = tail.indexOf(" ");
  return space >= 0 && space < tail.length - 1 ? tail.slice(space + 1) : tail;
}

function Waveform({ analyser, active }) {
  const canvasRef = React.useRef(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    let raf = 0;
    let resizeObserver;
    let lastWidth = 0;
    let lastHeight = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width;
      lastHeight = height;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    };

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(canvas);
    }
    resize();

    if (!analyser || !active) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return () => {
        if (resizeObserver) resizeObserver.disconnect();
      };
    }

    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.85;
    const data = new Uint8Array(analyser.fftSize);

    const draw = () => {
      analyser.getByteTimeDomainData(data);
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const mid = h / 2;
      const amplitude = mid * 0.85;

      const gradient = ctx.createLinearGradient(0, 0, w, 0);
      gradient.addColorStop(0, "rgba(56, 189, 248, 0)");
      gradient.addColorStop(0.15, "rgba(56, 189, 248, 0.95)");
      gradient.addColorStop(0.5, "rgba(168, 85, 247, 0.95)");
      gradient.addColorStop(0.85, "rgba(56, 189, 248, 0.95)");
      gradient.addColorStop(1, "rgba(56, 189, 248, 0)");

      ctx.shadowColor = "rgba(56, 189, 248, 0.55)";
      ctx.shadowBlur = 22 * dpr;
      ctx.lineWidth = 2.4 * dpr;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = gradient;

      ctx.beginPath();
      const step = w / data.length;
      for (let i = 0; i < data.length; i += 1) {
        const v = (data[i] - 128) / 128;
        const x = i * step;
        const y = mid + v * amplitude;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      if (resizeObserver) resizeObserver.disconnect();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [analyser, active]);

  return React.createElement("canvas", {
    ref: canvasRef,
    className: "waveform-canvas",
  });
}

function CostCard({ cost }) {
  const agent = cost.agent ?? {};
  const stt = cost.transcription ?? {};
  const total = (agent.priced ? agent.cost : 0) + (stt.priced ? stt.cost : 0);
  return React.createElement(
    "div",
    { className: "cost-card" },
    React.createElement(
      "div",
      { className: "cost-card-header" },
      React.createElement(
        "span",
        { className: "cost-card-title" },
        "Session cost",
      ),
      React.createElement(
        "span",
        {
          className: "cost-card-total",
          title: "Sum of priced agent + transcription costs",
        },
        formatUsd(total),
      ),
    ),
    React.createElement(CostRow, {
      label: "Agent",
      sub: costSubtitle(agent),
      value: costValue(agent),
      title: agentTokenTooltip(agent),
    }),
    React.createElement(CostRow, {
      label: "Voice",
      sub: costSubtitle(stt),
      value: costValue(stt),
      title: transcriptionTooltip(stt),
    }),
  );
}

function CostRow({ label, sub, value, title }) {
  return React.createElement(
    "div",
    { className: "cost-row", title: title || undefined },
    React.createElement(
      "div",
      { className: "cost-row-left" },
      React.createElement("span", { className: "cost-row-label" }, label),
      sub
        ? React.createElement("span", { className: "cost-row-sub" }, sub)
        : null,
    ),
    React.createElement("span", { className: "cost-row-value" }, value),
  );
}

function costSubtitle(entry) {
  if (!entry?.provider) return "";
  if (entry.provider === "moonshine")
    return `${entry.model ?? ""} (local)`.trim();
  if (entry.provider === "ollama") return `${entry.model ?? ""} (local)`.trim();
  if (entry.provider === "openrouter")
    return `${entry.model ?? ""} (openrouter)`.trim();
  if (entry.provider === "groq")
    return `${entry.model ?? ""} (groq · fast)`.trim();
  if (entry.provider === "cerebras")
    return `${entry.model ?? ""} (cerebras · fastest)`.trim();
  if (entry.provider === "codex")
    return `${entry.model ?? ""} (subscription)`.trim();
  return entry.model ?? "";
}

function costValue(entry) {
  if (!entry?.provider) return "$0.0000";
  if (!entry.priced) {
    if (entry.reason === "local") return "$0.0000";
    // Codex routes through the user's ChatGPT subscription, so there's no
    // per-token dollar cost we can report. Show usage volume instead so the
    // panel still surfaces "is the agent doing work?".
    if (entry.reason === "subscription") return formatTokenCount(entry.tokens);
    return "n/a";
  }
  return formatUsd(entry.cost ?? 0);
}

function formatUsd(value) {
  if (typeof value !== "number" || !isFinite(value)) return "$0.0000";
  if (value === 0) return "$0.0000";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(3)}`;
}

function formatTokenCount(tokens) {
  const total =
    (tokens?.input ?? 0) + (tokens?.output ?? 0) + (tokens?.reasoning ?? 0);
  if (total === 0) return "0 tok";
  if (total < 1000) return `${total} tok`;
  if (total < 1_000_000) {
    const k = total / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k tok`;
  }
  return `${(total / 1_000_000).toFixed(1)}M tok`;
}

function agentTokenTooltip(entry) {
  if (!entry?.tokens) return "";
  const t = entry.tokens;
  const total = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
  if (total === 0) return "";
  return `input ${t.input ?? 0} (cached ${t.cached ?? 0}) + output ${t.output ?? 0}${t.reasoning ? ` + reasoning ${t.reasoning}` : ""} tokens`;
}

function transcriptionTooltip(entry) {
  if (!entry?.seconds) return "";
  const seconds = entry.seconds;
  const minutes = seconds / 60;
  return `${minutes.toFixed(2)} minutes of audio sent`;
}

function statusRow({
  dotState,
  label,
  value,
  expanded = false,
  onToggle,
  editor,
}) {
  const clickable = Boolean(onToggle);
  return React.createElement(
    "div",
    { className: `status-row-wrap ${expanded ? "expanded" : ""}` },
    React.createElement(
      "div",
      {
        className: `status-row ${clickable ? "clickable" : ""} ${expanded ? "open" : ""}`,
        onClick: clickable ? onToggle : undefined,
        role: clickable ? "button" : undefined,
        tabIndex: clickable ? 0 : undefined,
        onKeyDown: clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggle();
              }
            }
          : undefined,
      },
      React.createElement("span", {
        className: `dot ${dotState}`,
        "aria-hidden": "true",
      }),
      React.createElement("span", { className: "label" }, label),
      React.createElement(
        "span",
        {
          className: "value",
          title: typeof value === "string" ? value : undefined,
        },
        value,
      ),
      clickable
        ? React.createElement(
            "span",
            { className: "chevron", "aria-hidden": "true" },
            "›",
          )
        : null,
    ),
    expanded && editor
      ? React.createElement("div", { className: "editor" }, editor)
      : null,
  );
}

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

function MicEditor({ currentDeviceId, onSave, onCancel }) {
  const [devices, setDevices] = React.useState([]);
  const [selected, setSelected] = React.useState(currentDeviceId);
  const [needsPermission, setNeedsPermission] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [errorText, setErrorText] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        const inputs = list.filter((d) => d.kind === "audioinput");
        if (cancelled) return;
        setDevices(inputs);
        setNeedsPermission(inputs.length > 0 && inputs.every((d) => !d.label));
      } catch (err) {
        if (!cancelled) setErrorText(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function grantPermission() {
    setBusy(true);
    setErrorText("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      const list = await navigator.mediaDevices.enumerateDevices();
      const inputs = list.filter((d) => d.kind === "audioinput");
      setDevices(inputs);
      setNeedsPermission(false);
    } catch (err) {
      setErrorText(err.message);
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    const device = devices.find((d) => d.deviceId === selected);
    onSave({ deviceId: selected || "", label: device?.label || "" });
  }

  return React.createElement(
    "div",
    { className: "editor-grid" },
    needsPermission
      ? React.createElement(
          "div",
          { className: "editor-hint" },
          "Grant microphone access to see device names.",
          React.createElement(
            "button",
            {
              className: "secondary",
              onClick: grantPermission,
              disabled: busy,
              style: { marginLeft: "8px" },
            },
            busy ? "..." : "Grant",
          ),
        )
      : null,
    field(
      "Device",
      React.createElement(
        "select",
        {
          value: selected,
          onChange: (e) => setSelected(e.target.value),
          disabled: busy,
        },
        React.createElement("option", { value: "" }, "System default"),
        devices.map((d) =>
          React.createElement(
            "option",
            { key: d.deviceId, value: d.deviceId },
            d.label || `Device ${d.deviceId.slice(0, 8)}`,
          ),
        ),
      ),
    ),
    errorText
      ? React.createElement("div", { className: "editor-error" }, errorText)
      : null,
    React.createElement(
      "div",
      { className: "editor-actions" },
      React.createElement(
        "button",
        { className: "secondary", onClick: onCancel, disabled: busy },
        "Cancel",
      ),
      React.createElement(
        "button",
        { onClick: submit, disabled: busy },
        "Save",
      ),
    ),
  );
}

function AgentEditor({ settings, onSave, onCancel }) {
  const [provider, setProvider] = React.useState(settings.agent.provider);
  const [openaiModel, setOpenaiModel] = React.useState(
    settings.agent.openai.model,
  );
  const [reasoningEffort, setReasoningEffort] = React.useState(
    settings.agent.openai.reasoningEffort,
  );
  const [openaiBaseURL, setOpenaiBaseURL] = React.useState(
    settings.agent.openai.baseURL,
  );
  const [codexModel, setCodexModel] = React.useState(
    settings.agent.codex.model,
  );
  const [ollamaModel, setOllamaModel] = React.useState(
    settings.agent.ollama.model,
  );
  const [ollamaBaseURL, setOllamaBaseURL] = React.useState(
    settings.agent.ollama.baseURL,
  );
  const [openrouterModel, setOpenrouterModel] = React.useState(
    settings.agent.openrouter?.model || "anthropic/claude-3.5-sonnet",
  );
  const [openrouterBaseURL, setOpenrouterBaseURL] = React.useState(
    settings.agent.openrouter?.baseURL || "https://openrouter.ai/api/v1",
  );
  const [groqModel, setGroqModel] = React.useState(
    settings.agent.groq?.model || "llama-3.3-70b-versatile",
  );
  const [cerebrasModel, setCerebrasModel] = React.useState(
    settings.agent.cerebras?.model || "llama-3.3-70b",
  );
  const [openaiKey, setOpenaiKey] = React.useState("");
  const [openrouterKey, setOpenrouterKey] = React.useState("");
  const [groqKey, setGroqKey] = React.useState("");
  const [cerebrasKey, setCerebrasKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [errorText, setErrorText] = React.useState("");

  const needsOpenAIKey =
    provider === "openai" && !settings.hasOpenAIKey && !openaiKey;
  const needsOpenRouterKey =
    provider === "openrouter" && !settings.hasOpenRouterKey && !openrouterKey;
  const needsGroqKey =
    provider === "groq" && !settings.hasGroqKey && !groqKey;
  const needsCerebrasKey =
    provider === "cerebras" && !settings.hasCerebrasKey && !cerebrasKey;

  async function submit() {
    setBusy(true);
    setErrorText("");
    const patch = {
      agent: {
        provider,
        openai: {},
        codex: {},
        ollama: {},
        openrouter: {},
        groq: {},
        cerebras: {},
      },
    };
    if (provider === "openai") {
      patch.agent.openai.model = openaiModel;
      patch.agent.openai.reasoningEffort = reasoningEffort;
      patch.agent.openai.baseURL = openaiBaseURL;
    } else if (provider === "codex") {
      patch.agent.codex.model = codexModel;
    } else if (provider === "openrouter") {
      patch.agent.openrouter.model = openrouterModel;
      patch.agent.openrouter.baseURL = openrouterBaseURL;
    } else if (provider === "groq") {
      patch.agent.groq.model = groqModel;
    } else if (provider === "cerebras") {
      patch.agent.cerebras.model = cerebrasModel;
    } else {
      patch.agent.ollama.model = ollamaModel;
      patch.agent.ollama.baseURL = ollamaBaseURL;
    }
    const keys = {};
    if (openaiKey) keys.openai = openaiKey;
    if (openrouterKey) keys.openrouter = openrouterKey;
    if (groqKey) keys.groq = groqKey;
    if (cerebrasKey) keys.cerebras = cerebrasKey;
    if (Object.keys(keys).length) patch.apiKeys = keys;
    try {
      await onSave(patch);
    } catch (error) {
      setErrorText(error.message);
      setBusy(false);
    }
  }

  return React.createElement(
    "div",
    { className: "editor-grid" },
    field(
      "Provider",
      React.createElement(
        "select",
        {
          value: provider,
          onChange: (e) => setProvider(e.target.value),
          disabled: busy,
        },
        React.createElement("option", { value: "groq" }, "Groq (fast)"),
        React.createElement("option", { value: "cerebras" }, "Cerebras (fastest)"),
        React.createElement("option", { value: "openrouter" }, "OpenRouter"),
        React.createElement("option", { value: "openai" }, "OpenAI"),
        React.createElement("option", { value: "ollama" }, "Ollama (local)"),
        React.createElement("option", { value: "codex" }, "Codex"),
      ),
    ),
    provider === "openai"
      ? field(
          "Model",
          select(openaiModel, setOpenaiModel, OPENAI_AGENT_MODELS, busy),
        )
      : null,
    provider === "openai"
      ? field(
          "Reasoning",
          select(reasoningEffort, setReasoningEffort, REASONING_EFFORTS, busy),
        )
      : null,
    provider === "codex"
      ? field(
          "Model",
          select(codexModel, setCodexModel, CODEX_AGENT_MODELS, busy),
        )
      : null,
    provider === "ollama"
      ? field(
          "Model",
          React.createElement("input", {
            type: "text",
            value: ollamaModel,
            onChange: (e) => setOllamaModel(e.target.value),
            placeholder: "e.g. llama3.2",
            disabled: busy,
          }),
        )
      : null,
    provider === "ollama"
      ? field(
          "Base URL",
          React.createElement("input", {
            type: "text",
            value: ollamaBaseURL,
            onChange: (e) => setOllamaBaseURL(e.target.value),
            disabled: busy,
          }),
        )
      : null,
    provider === "groq"
      ? field("Model", select(groqModel, setGroqModel, GROQ_AGENT_MODELS, busy))
      : null,
    provider === "cerebras"
      ? field("Model", select(cerebrasModel, setCerebrasModel, CEREBRAS_AGENT_MODELS, busy))
      : null,
    needsGroqKey || (provider === "groq" && settings.hasGroqKey)
      ? field(
          "API key",
          React.createElement("input", {
            type: "password",
            value: groqKey,
            onChange: (e) => setGroqKey(e.target.value),
            placeholder: settings.hasGroqKey ? "configured (enter to replace)" : "gsk_...",
            disabled: busy,
          }),
        )
      : null,
    needsCerebrasKey || (provider === "cerebras" && settings.hasCerebrasKey)
      ? field(
          "API key",
          React.createElement("input", {
            type: "password",
            value: cerebrasKey,
            onChange: (e) => setCerebrasKey(e.target.value),
            placeholder: settings.hasCerebrasKey ? "configured (enter to replace)" : "csk-...",
            disabled: busy,
          }),
        )
      : null,
    provider === "openrouter"
      ? field(
          "Model",
          React.createElement(
            "input",
            {
              type: "text",
              value: openrouterModel,
              onChange: (e) => setOpenrouterModel(e.target.value),
              placeholder: "anthropic/claude-3.5-sonnet",
              list: "openrouter-model-suggestions",
              disabled: busy,
            },
          ),
          React.createElement(
            "datalist",
            { id: "openrouter-model-suggestions" },
            ...OPENROUTER_AGENT_MODELS.map((m) =>
              React.createElement("option", { key: m, value: m }),
            ),
          ),
        )
      : null,
    provider === "openrouter"
      ? field(
          "Base URL",
          React.createElement("input", {
            type: "text",
            value: openrouterBaseURL,
            onChange: (e) => setOpenrouterBaseURL(e.target.value),
            disabled: busy,
          }),
        )
      : null,
    needsOpenRouterKey
      ? field(
          "API key",
          React.createElement("input", {
            type: "password",
            value: openrouterKey,
            onChange: (e) => setOpenrouterKey(e.target.value),
            placeholder: "sk-or-v1-...",
            disabled: busy,
          }),
        )
      : null,
    provider === "openrouter" && settings.hasOpenRouterKey
      ? field(
          "API key",
          React.createElement("input", {
            type: "password",
            value: openrouterKey,
            onChange: (e) => setOpenrouterKey(e.target.value),
            placeholder: "configured (enter to replace)",
            disabled: busy,
          }),
        )
      : null,
    needsOpenAIKey
      ? field(
          "API key",
          React.createElement("input", {
            type: "password",
            value: openaiKey,
            onChange: (e) => setOpenaiKey(e.target.value),
            placeholder: "sk-...",
            disabled: busy,
          }),
        )
      : null,
    provider === "openai" && settings.hasOpenAIKey
      ? field(
          "API key",
          React.createElement("input", {
            type: "password",
            value: openaiKey,
            onChange: (e) => setOpenaiKey(e.target.value),
            placeholder: "configured (enter to replace)",
            disabled: busy,
          }),
        )
      : null,
    provider === "openai"
      ? field(
          "Base URL",
          React.createElement("input", {
            type: "text",
            value: openaiBaseURL,
            onChange: (e) => setOpenaiBaseURL(e.target.value),
            disabled: busy,
          }),
        )
      : null,
    errorText
      ? React.createElement("div", { className: "editor-error" }, errorText)
      : null,
    React.createElement(
      "div",
      { className: "editor-actions" },
      React.createElement(
        "button",
        { className: "secondary", onClick: onCancel, disabled: busy },
        "Cancel",
      ),
      React.createElement(
        "button",
        {
          onClick: submit,
          disabled: busy || needsOpenAIKey || needsOpenRouterKey || needsGroqKey || needsCerebrasKey,
        },
        busy ? "Saving..." : "Save",
      ),
    ),
  );
}

function TranscriptionEditor({ settings, onSave, onCancel }) {
  const [provider, setProvider] = React.useState(
    settings.transcription.provider,
  );
  const [moonshineModel, setMoonshineModel] = React.useState(
    settings.transcription.moonshine.model,
  );
  const [openaiModel, setOpenaiModel] = React.useState(
    settings.transcription.openai.model,
  );
  const [openaiKey, setOpenaiKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [errorText, setErrorText] = React.useState("");

  const needsOpenAIKey =
    provider === "openai" && !settings.hasOpenAIKey && !openaiKey;

  async function submit() {
    setBusy(true);
    setErrorText("");
    const patch = { transcription: { provider, moonshine: {}, openai: {} } };
    if (provider === "moonshine")
      patch.transcription.moonshine.model = moonshineModel;
    if (provider === "openai") patch.transcription.openai.model = openaiModel;
    if (openaiKey) patch.apiKeys = { openai: openaiKey };
    try {
      await onSave(patch);
    } catch (error) {
      setErrorText(error.message);
      setBusy(false);
    }
  }

  return React.createElement(
    "div",
    { className: "editor-grid" },
    field(
      "Provider",
      React.createElement(
        "select",
        {
          value: provider,
          onChange: (e) => setProvider(e.target.value),
          disabled: busy,
        },
        React.createElement(
          "option",
          { value: "moonshine" },
          "Moonshine (local)",
        ),
        React.createElement("option", { value: "openai" }, "OpenAI Realtime"),
      ),
    ),
    provider === "moonshine"
      ? field(
          "Model",
          select(moonshineModel, setMoonshineModel, MOONSHINE_MODELS, busy),
        )
      : null,
    provider === "openai"
      ? field(
          "Model",
          select(
            openaiModel,
            setOpenaiModel,
            OPENAI_TRANSCRIPTION_MODELS,
            busy,
          ),
        )
      : null,
    needsOpenAIKey
      ? field(
          "API key",
          React.createElement("input", {
            type: "password",
            value: openaiKey,
            onChange: (e) => setOpenaiKey(e.target.value),
            placeholder: "sk-...",
            disabled: busy,
          }),
        )
      : null,
    provider === "openai" && settings.hasOpenAIKey
      ? field(
          "API key",
          React.createElement("input", {
            type: "password",
            value: openaiKey,
            onChange: (e) => setOpenaiKey(e.target.value),
            placeholder: "configured (enter to replace)",
            disabled: busy,
          }),
        )
      : null,
    errorText
      ? React.createElement("div", { className: "editor-error" }, errorText)
      : null,
    React.createElement(
      "div",
      { className: "editor-actions" },
      React.createElement(
        "button",
        { className: "secondary", onClick: onCancel, disabled: busy },
        "Cancel",
      ),
      React.createElement(
        "button",
        { onClick: submit, disabled: busy || needsOpenAIKey },
        busy ? "Saving..." : "Save",
      ),
    ),
  );
}

function field(label, control) {
  return React.createElement(
    "label",
    { className: "field" },
    React.createElement("span", { className: "field-label" }, label),
    control,
  );
}

function select(value, onChange, options, disabled) {
  return React.createElement(
    "select",
    { value, onChange: (e) => onChange(e.target.value), disabled },
    options.map((option) =>
      React.createElement("option", { key: option, value: option }, option),
    ),
  );
}

// nativeElementsToSkeletonForSync / stripInternalFields now live in
// public/excalidraw-sync.js (imported above); kept out of this file to keep
// the mode/status-aware sync contract colocated with applyScene /
// handleExcalidrawChange / applyWhiteboardViewportCommand.

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

// Nudge bar. Renders in the side panel during PRESO mode. Lets the user steer
// the agent mid-session without restarting. POSTs to /api/preso/nudge which
// pushes a system-message directive into agentHistory for the next turn.
const NUDGE_PLACEHOLDERS = [
  "Use a flowchart instead",
  "Group by quarter",
  "Highlight risks in orange",
  "Reorganize as a 2x2 matrix",
  "Drop the licenses node",
];
function NudgeBar() {
  const [value, setValue] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [recent, setRecent] = React.useState([]);
  const [confirm, setConfirm] = React.useState(false);
  const [errorText, setErrorText] = React.useState("");
  const [placeholderIndex, setPlaceholderIndex] = React.useState(0);
  const inputRef = React.useRef(null);

  // v0.12.0: Cmd+K focus shortcut hook
  React.useEffect(() => {
    const handler = () => { inputRef.current?.focus(); };
    window.addEventListener("champpreso:focus-nudge", handler);
    return () => window.removeEventListener("champpreso:focus-nudge", handler);
  }, []);

  React.useEffect(() => {
    const id = setInterval(
      () => setPlaceholderIndex((i) => (i + 1) % NUDGE_PLACEHOLDERS.length),
      4000,
    );
    return () => clearInterval(id);
  }, []);

  React.useEffect(() => {
    if (!confirm) return;
    const id = setTimeout(() => setConfirm(false), 2000);
    return () => clearTimeout(id);
  }, [confirm]);

  async function submit() {
    const text = value.trim();
    if (!text || sending) return;
    setSending(true);
    setErrorText("");
    try {
      await apiSendNudge(text);
      setValue("");
      setRecent((prev) => [text, ...prev.filter((t) => t !== text)].slice(0, 3));
      setConfirm(true);
    } catch (error) {
      setErrorText(error.message || "Nudge failed.");
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return React.createElement(
    "div",
    { className: "nudge-bar" },
    React.createElement("div", { className: "nudge-label" }, "NUDGE"),
    React.createElement(
      "div",
      { className: "nudge-input-row" },
      React.createElement("input", {
        ref: inputRef,
        type: "text",
        className: "nudge-input",
        placeholder: NUDGE_PLACEHOLDERS[placeholderIndex],
        value,
        disabled: sending,
        onChange: (e) => setValue(e.target.value),
        onKeyDown,
        maxLength: 500,
      }),
      React.createElement(
        "button",
        {
          className: "nudge-send",
          onClick: submit,
          disabled: sending || !value.trim(),
          title: "Send nudge (Enter)",
          "aria-label": "Send nudge",
        },
        sending ? "..." : "↑",
      ),
    ),
    confirm
      ? React.createElement("div", { className: "nudge-confirm" }, "Nudge applied.")
      : null,
    errorText
      ? React.createElement("div", { className: "nudge-error" }, errorText)
      : null,
    recent.length > 0
      ? React.createElement(
          "div",
          { className: "nudge-recent" },
          React.createElement("span", { className: "nudge-recent-label" }, "Recent: "),
          ...recent.map((text, i) =>
            React.createElement(
              "button",
              {
                key: `${text}-${i}`,
                className: "nudge-recent-chip",
                onClick: () => setValue(text),
                title: "Click to reuse",
              },
              text.length > 28 ? text.slice(0, 26) + "..." : text,
            ),
          ),
        )
      : null,
  );
}

// Backlog pill. Shows how far behind the agent is relative to live speech.
// Renders in PRESO mode only, next to the Pause Capture button.
function BacklogPill({ stats }) {
  if (!stats) return null;
  const total = (stats.pending ?? 0) + (stats.buffered ?? 0);
  const seconds = Math.round((stats.estimatedCatchupMs ?? 0) / 1000);
  const ageSeconds = Math.round((stats.ageMs ?? 0) / 1000);
  let severity = "calm";
  if (seconds >= 30 || total >= 4) severity = "alert";
  else if (seconds >= 12 || total >= 2) severity = "warn";

  const lines = [];
  if (stats.running) lines.push("Thinking");
  if (total > 0) lines.push(`${total} queued`);
  if (seconds > 0) lines.push(`~${seconds}s behind`);
  if (lines.length === 0) lines.push("Active");

  return React.createElement(
    "div",
    {
      className: `backlog-pill ${severity}`,
      title: `Avg turn: ${Math.round((stats.avgTurnMs ?? 0) / 100) / 10}s. Oldest queued chunk: ${ageSeconds}s ago.`,
    },
    React.createElement("span", { className: `backlog-dot ${severity}` }),
    React.createElement("span", null, lines.join(" · ")),
  );
}

// Floating question card. Anchored to the top-center of the canvas. Visible
// when the agent has called ask_user_question. User taps an option or types
// a custom answer; either way the answer flows into agentHistory.
function QuestionCard({ question, onAnswer, onDismiss, position = "top" }) {
  const [custom, setCustom] = React.useState("");
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    // Soft focus the input after a tick so screen readers announce the
    // question before the cursor lands.
    const t = setTimeout(() => inputRef.current?.focus(), 600);
    return () => clearTimeout(t);
  }, [question.id]);

  function submitCustom() {
    const text = custom.trim();
    if (!text) return;
    onAnswer(text);
  }

  return React.createElement(
    "div",
    {
      className: `question-card ${position === "bottom" ? "at-bottom" : ""}`,
      role: "dialog",
      "aria-live": "polite",
    },
    React.createElement(
      "div",
      { className: "question-card-header" },
      React.createElement("span", { className: "question-card-pill" }, "Quick question"),
      React.createElement(
        "button",
        {
          type: "button",
          className: "question-card-skip",
          onClick: onDismiss,
          title: "Skip this question; let the agent use its best guess",
          "aria-label": "Skip",
        },
        "Skip",
      ),
    ),
    React.createElement("p", { className: "question-card-body" }, question.question),
    Array.isArray(question.options) && question.options.length > 0
      ? React.createElement(
          "div",
          { className: "question-card-options" },
          ...question.options.map((opt, idx) =>
            React.createElement(
              "button",
              {
                key: `${opt}-${idx}`,
                type: "button",
                className: "question-card-option",
                onClick: () => onAnswer(opt),
              },
              opt,
            ),
          ),
        )
      : null,
    React.createElement(
      "div",
      { className: "question-card-custom" },
      React.createElement("input", {
        ref: inputRef,
        type: "text",
        className: "question-card-custom-input",
        placeholder: "Or type a brief answer...",
        value: custom,
        onChange: (e) => setCustom(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submitCustom();
          }
        },
        maxLength: 500,
      }),
      React.createElement(
        "button",
        {
          type: "button",
          className: "question-card-custom-send",
          onClick: submitCustom,
          disabled: !custom.trim(),
          title: "Send (Enter)",
          "aria-label": "Send custom answer",
        },
        "↑",
      ),
    ),
  );
}

// === v0.8.0 Export menu ===
// Dropdown with PNG / SVG / .excalidraw export. Closes on outside click.
function ExportMenu({ onExport }) {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!e.target.closest(".export-menu")) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return React.createElement(
    "div",
    { className: "export-menu" },
    React.createElement(
      "button",
      {
        type: "button",
        className: "export-trigger",
        onClick: () => setOpen((v) => !v),
        title: "Export the canvas for sharing",
      },
      "⤴ Share / Export",
      React.createElement("span", { className: "ex-chev" }, open ? "▴" : "▾"),
    ),
    open
      ? React.createElement(
          "div",
          { className: "export-pop" },
          React.createElement(
            "button",
            {
              type: "button",
              className: "export-opt",
              onClick: () => { onExport("png"); setOpen(false); },
            },
            "📷 PNG image (high res)",
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "export-opt",
              onClick: () => { onExport("svg"); setOpen(false); },
            },
            "✒ SVG vector",
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "export-opt",
              onClick: () => { onExport("excalidraw"); setOpen(false); },
            },
            "📁 .excalidraw file",
          ),
        )
      : null,
  );
}

// === v0.4.0 Quick Actions and Pattern Picker ===

// Pre-baked nudges. Click sends straight to /api/preso/nudge. The strings are
// chosen to be unambiguous, action-oriented, and match the system prompt's
// pattern library + icon vocabulary.
const QUICK_ACTIONS = [
  { label: "Reorganize", text: "Reorganize the canvas. Pick a clearer visual pattern and rebuild." },
  { label: "Mermaid flow", text: "Use render_mermaid to draw a flowchart of what we just discussed. Place it in clear space on the canvas." },
  { label: "Mermaid sequence", text: "Use render_mermaid to draw a sequenceDiagram of the interactions we just discussed." },
  { label: "Mindmap it", text: "Use render_mermaid with a mindmap diagram to expand around the central concept on the canvas." },
  { label: "Color by owner", text: "Color-code shapes by owner. Same owner = same color." },
  { label: "Simplify", text: "Simplify. Reduce to the 5-6 most important nodes. Drop the rest." },
];
const PATTERN_PICKS = [
  { label: "Hub-spoke", text: "Switch to the HUB-AND-SPOKE pattern. One primary node in the center, spokes radiating." },
  { label: "2×2 matrix", text: "Switch to the 2x2 MATRIX pattern. Two axes, four labeled quadrants." },
  { label: "Timeline", text: "Switch to the TIMELINE pattern. Horizontal arrow spine with milestone nodes." },
  { label: "Flow", text: "Switch to the FLOW pattern. Linear chain with diamond decision points." },
  { label: "Tree", text: "Switch to the TREE / HIERARCHY pattern. Top node fanning down." },
  { label: "Compare", text: "Switch to the SIDE-BY-SIDE COMPARISON pattern. Two labeled columns." },
  { label: "Causal loop", text: "Switch to the CAUSAL LOOP pattern. Nodes in a circle with feedback arrows." },
  { label: "Funnel", text: "Switch to the FUNNEL pattern. Vertical sequence of narrowing rectangles." },
];

function QuickActions() {
  const [busy, setBusy] = React.useState(null);
  const [flash, setFlash] = React.useState("");
  const [patternsOpen, setPatternsOpen] = React.useState(false);

  async function send(action) {
    if (busy) return;
    setBusy(action.label);
    setFlash("");
    try {
      await apiSendNudge(action.text);
      setFlash(`Sent: ${action.label}`);
      setTimeout(() => setFlash(""), 1800);
    } catch (e) {
      setFlash(`Failed: ${e.message}`);
    } finally {
      setBusy(null);
    }
  }

  return React.createElement(
    "div",
    { className: "quick-actions" },
    React.createElement(
      "div",
      { className: "qa-row-label" },
      React.createElement("span", null, "QUICK ACTIONS"),
      React.createElement(
        "button",
        {
          type: "button",
          className: "qa-toggle-patterns",
          onClick: () => setPatternsOpen((v) => !v),
          title: "Show visual pattern picker",
        },
        patternsOpen ? "− Patterns" : "+ Patterns",
      ),
    ),
    React.createElement(
      "div",
      { className: "qa-chips" },
      ...QUICK_ACTIONS.map((a) =>
        React.createElement(
          "button",
          {
            key: a.label,
            type: "button",
            className: `qa-chip ${busy === a.label ? "busy" : ""}`,
            onClick: () => send(a),
            disabled: !!busy,
            title: a.text,
          },
          a.label,
        ),
      ),
    ),
    patternsOpen
      ? React.createElement(
          "div",
          { className: "qa-chips qa-patterns" },
          ...PATTERN_PICKS.map((p) =>
            React.createElement(
              "button",
              {
                key: p.label,
                type: "button",
                className: `qa-chip qa-pattern ${busy === p.label ? "busy" : ""}`,
                onClick: () => send(p),
                disabled: !!busy,
                title: p.text,
              },
              p.label,
            ),
          ),
        )
      : null,
    flash
      ? React.createElement("div", { className: "qa-flash" }, flash)
      : null,
  );
}

// === v0.3.0 Aegis components ===

// Compute the per-session world hue tokens from a single primary hex value.
// Used to set --p/--s/--g/--t on the shell so every Aegis-themed surface picks
// up the user's brand swatch choice.
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

const WORLD_SWATCHES = [
  { hex: "#FF6B35", name: "Champ Ember" },
  { hex: "#F26722", name: "Champions Orange" },
  { hex: "#06B6D4", name: "Cyan" },
  { hex: "#7C5CFF", name: "Violet" },
  { hex: "#10B981", name: "Verdant" },
  { hex: "#EC4899", name: "Pulse" },
];

// v0.7.0: Floating "Working in: ZONE" chip on the canvas. Reflects the
// agent's declared active zone (sketches/structured/notes).
function ZoneChip({ zone }) {
  const labels = {
    sketches: "Sketches",
    structured: "Structured",
    notes: "Notes",
  };
  const label = labels[zone] || "Structured";
  return React.createElement(
    "div",
    { className: `zone-chip zone-${zone || "structured"}` },
    React.createElement("span", { className: "zc-dot" }),
    React.createElement("span", { className: "zc-label" }, "Working in:"),
    React.createElement("span", { className: "zc-zone" }, label),
  );
}

// Onboarding ribbon. First-launch only. Dismissable, persists choice.
// Canvas-level palette swatch row. Shifts down 50px when onboarding ribbon
// is up so they never collide.
const CANVAS_PALETTES = {
  champions: { label: "Champions", dots: ["var(--p)", "var(--s)", "var(--g)"] },
  cool:      { label: "Cool",      dots: ["#2563EB", "#0E7490", "#67E8F9"] },
  warm:      { label: "Warm",      dots: ["#EA580C", "#B91C1C", "#F59E0B"] },
  mono:      { label: "Mono",      dots: ["#1E222D", "#6B7280", "#D1D5DB"] },
};
const CANVAS_PALETTE_ORDER = ["champions", "cool", "warm", "mono"];
function PaletteRow({ active, onChange, shift }) {
  return React.createElement(
    "div",
    { className: `palette-row ${shift ? "shift" : ""}` },
    React.createElement("span", { className: "pr-label" }, "Palette"),
    ...CANVAS_PALETTE_ORDER.map((k) =>
      React.createElement(
        "button",
        {
          key: k,
          type: "button",
          className: `palette-btn ${active === k ? "active" : ""}`,
          onClick: () => onChange(k),
        },
        React.createElement(
          "span",
          { className: "palette-dots" },
          ...CANVAS_PALETTES[k].dots.map((c, i) =>
            React.createElement("i", { key: i, style: { background: c } }),
          ),
        ),
        React.createElement("span", { className: "palette-name" }, CANVAS_PALETTES[k].label),
      ),
    ),
  );
}

// Caption mode FAB (Present / Work toggle).
function CaptionFab({ mode, onChange, shift }) {
  return React.createElement(
    "div",
    { className: `caption-fab ${shift ? "shift" : ""}` },
    React.createElement(
      "button",
      {
        type: "button",
        className: `cf-opt ${mode === "presentation" ? "on" : ""}`,
        onClick: () => onChange("presentation"),
        title: "Big presentation captions, bottom-center",
      },
      "Present",
    ),
    React.createElement(
      "button",
      {
        type: "button",
        className: `cf-opt ${mode === "working" ? "on" : ""}`,
        onClick: () => onChange("working"),
        title: "Small working captions, top-right",
      },
      "Work",
    ),
  );
}

// UI Settings drawer. Renders inside the side panel; toggles every Aegis
// preference and persists each change via the parent's onChange (which routes
// through saveSettings → PUT /api/settings).
function UISettingsPanel({ prefs, onChange, onClose }) {
  return React.createElement(
    "div",
    { className: "ui-settings" },
    React.createElement(
      "div",
      { className: "us-title" },
      React.createElement("span", null, "UI Settings"),
      React.createElement(
        "button",
        { className: "us-close", onClick: onClose, "aria-label": "Close UI settings" },
        "✕",
      ),
    ),
    React.createElement("div", { className: "ui-section-label" }, "Theme"),
    React.createElement(
      "div",
      { className: "ui-row" },
      React.createElement("label", null, "Primary hue"),
      React.createElement(
        "div",
        { className: "ui-swatches" },
        ...WORLD_SWATCHES.map((s) =>
          React.createElement("button", {
            key: s.hex,
            type: "button",
            className: `ui-swatch ${prefs.themePrimary === s.hex ? "active" : ""}`,
            style: { background: s.hex },
            onClick: () => onChange("themePrimary", s.hex),
            title: s.name,
            "aria-label": s.name,
          }),
        ),
      ),
    ),
    React.createElement(
      "div",
      { className: "ui-row" },
      React.createElement("label", null, "Panel theme"),
      React.createElement(
        "div",
        { className: "ui-seg" },
        React.createElement(
          "button",
          {
            className: prefs.panelTheme === "dark" ? "on" : "",
            onClick: () => onChange("panelTheme", "dark"),
          },
          "Dark",
        ),
        React.createElement(
          "button",
          {
            className: prefs.panelTheme === "light" ? "on" : "",
            onClick: () => onChange("panelTheme", "light"),
          },
          "Light",
        ),
      ),
    ),
    React.createElement("div", { className: "ui-section-label" }, "Layout"),
    React.createElement(
      "div",
      { className: "ui-row" },
      React.createElement("label", null, "Backlog Pill position"),
      React.createElement(
        "div",
        { className: "ui-seg" },
        React.createElement(
          "button",
          {
            className: prefs.backlogPosition === "above" ? "on" : "",
            onClick: () => onChange("backlogPosition", "above"),
          },
          "Above",
        ),
        React.createElement(
          "button",
          {
            className: prefs.backlogPosition === "below" ? "on" : "",
            onClick: () => onChange("backlogPosition", "below"),
          },
          "Below",
        ),
      ),
    ),
    React.createElement(
      "div",
      { className: "ui-row" },
      React.createElement("label", null, "Status Card in PRESO"),
      React.createElement(
        "div",
        { className: "ui-seg" },
        React.createElement(
          "button",
          {
            className: prefs.statusDensity === "expand" ? "on" : "",
            onClick: () => onChange("statusDensity", "expand"),
          },
          "Expand",
        ),
        React.createElement(
          "button",
          {
            className: prefs.statusDensity === "collapse" ? "on" : "",
            onClick: () => onChange("statusDensity", "collapse"),
          },
          "Collapse",
        ),
      ),
    ),
    React.createElement(
      "div",
      { className: "ui-row" },
      React.createElement("label", null, "Question Card anchor"),
      React.createElement(
        "div",
        { className: "ui-seg" },
        React.createElement(
          "button",
          {
            className: prefs.questionPos === "top" ? "on" : "",
            onClick: () => onChange("questionPos", "top"),
          },
          "Top",
        ),
        React.createElement(
          "button",
          {
            className: prefs.questionPos === "bottom" ? "on" : "",
            onClick: () => onChange("questionPos", "bottom"),
          },
          "Bottom",
        ),
      ),
    ),
    React.createElement("div", { className: "ui-section-label" }, "Canvas"),
    React.createElement(
      "div",
      { className: "ui-row inline" },
      React.createElement("label", null, "Show palette row"),
      React.createElement(
        "button",
        {
          type: "button",
          className: "ui-toggle",
          "data-on": prefs.paletteRow ? "1" : "0",
          onClick: () => onChange("paletteRow", !prefs.paletteRow),
          "aria-label": "Toggle palette row",
        },
        React.createElement("i"),
      ),
    ),
    React.createElement(
      "div",
      { className: "ui-row" },
      React.createElement("label", null, "Active palette"),
      React.createElement(
        "div",
        { className: "ui-seg" },
        ...CANVAS_PALETTE_ORDER.map((k) =>
          React.createElement(
            "button",
            {
              key: k,
              className: prefs.activePalette === k ? "on" : "",
              onClick: () => onChange("activePalette", k),
            },
            CANVAS_PALETTES[k].label,
          ),
        ),
      ),
    ),
    React.createElement(
      "div",
      { className: "ui-row inline" },
      React.createElement("label", null, "Captions on"),
      React.createElement(
        "button",
        {
          type: "button",
          className: "ui-toggle",
          "data-on": prefs.captionsOn ? "1" : "0",
          onClick: () => onChange("captionsOn", !prefs.captionsOn),
          "aria-label": "Toggle captions",
        },
        React.createElement("i"),
      ),
    ),
    React.createElement(
      "div",
      { className: "ui-row" },
      React.createElement("label", null, "Caption mode"),
      React.createElement(
        "div",
        { className: "ui-seg" },
        React.createElement(
          "button",
          {
            className: prefs.captionMode === "presentation" ? "on" : "",
            onClick: () => onChange("captionMode", "presentation"),
          },
          "Present",
        ),
        React.createElement(
          "button",
          {
            className: prefs.captionMode === "working" ? "on" : "",
            onClick: () => onChange("captionMode", "working"),
          },
          "Work",
        ),
      ),
    ),
    React.createElement("div", { className: "ui-section-label" }, "Micro"),
    React.createElement(
      "div",
      { className: "ui-row inline" },
      React.createElement("label", null, "Breathing underline"),
      React.createElement(
        "button",
        {
          type: "button",
          className: "ui-toggle",
          "data-on": prefs.toggleBreathe ? "1" : "0",
          onClick: () => onChange("toggleBreathe", !prefs.toggleBreathe),
          "aria-label": "Toggle breathing underline",
        },
        React.createElement("i"),
      ),
    ),
    React.createElement(
      "div",
      { className: "ui-row inline" },
      React.createElement("label", null, "Onboarding ribbon"),
      React.createElement(
        "button",
        {
          type: "button",
          className: "ui-toggle",
          "data-on": prefs.onboarding ? "1" : "0",
          onClick: () => onChange("onboarding", !prefs.onboarding),
          "aria-label": "Toggle onboarding ribbon",
        },
        React.createElement("i"),
      ),
    ),
  );
}

createRoot(document.getElementById("app")).render(React.createElement(App));
