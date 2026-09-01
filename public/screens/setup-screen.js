// Setup screen (redesign). Translates the design source's SETUP RAIL and
// consolidated SETTINGS SHEET (docs/design-handoff/frontend-source/
// ChampPreso-Shell.dc.html) into real React + wiring against the live backend.
//
// This replaces the old staging-mode side panel: the session-intent textarea,
// the multiple-speakers toggle, restore-last-session, a single scrollable
// settings sheet (agent / transcription / mic / appearance), a canvas seed
// affordance, the readiness glyph, and the "Start whiteboarding" button.
//
// It owns only local UI state (sheet open/closed, restore feedback, seed
// disclosure, optimistic mirrors of a few settings). Anything that must leave
// the component is routed through the props the host (app.js) provides so the
// app stays the single source of truth for settings, appearance and the WS.

import React from "react";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";

import {
  seedCanvas as apiSeedCanvas,
  getLastBackup as apiGetLastBackup,
  restoreBackup as apiRestoreBackup,
} from "../api-client.js";
import {
  BRAINSTORM_TEMPLATES,
  isTemplateElementId,
} from "../brainstorm-templates.js";
import {
  OPENAI_AGENT_MODELS,
  CODEX_AGENT_MODELS,
  GROQ_AGENT_MODELS,
  CEREBRAS_AGENT_MODELS,
  OPENROUTER_AGENT_MODELS,
  OPENAI_TRANSCRIPTION_MODELS,
  MOONSHINE_MODELS,
  GROQ_TRANSCRIPTION_MODELS,
  DEEPGRAM_TRANSCRIPTION_MODELS,
  ASK_MODELS,
  REASONING_EFFORTS,
} from "../model-catalog.js";
import {
  describeModel,
  useModelCatalog,
  useModelWarning,
} from "../use-model-catalog.js";

const h = React.createElement;

const AGENT_PROVIDERS = [
  { value: "groq", label: "Groq · fast, free tier" },
  { value: "cerebras", label: "Cerebras · fastest" },
  { value: "openrouter", label: "OpenRouter · 200+ models" },
  { value: "openai", label: "OpenAI" },
  { value: "ollama", label: "Ollama · runs on this Mac" },
  { value: "codex", label: "Codex · your ChatGPT plan" },
];

// Which providers authenticate with an API key (vs. local / OAuth).
const AGENT_KEY_FLAG = {
  openai: "hasOpenAIKey",
  openrouter: "hasOpenRouterKey",
  groq: "hasGroqKey",
  cerebras: "hasCerebrasKey",
};
const AGENT_KEY_PLACEHOLDER = {
  openai: "sk-...",
  openrouter: "sk-or-v1-...",
  groq: "gsk_...",
  cerebras: "csk-...",
};

// Must match the keys computeWorldStyle() (public/app.js) actually maps to
// --p/--s/--g/--t accent tokens - these are the only hex values it knows how
// to turn into a real color scheme. Picking any other hex here would
// silently fall back to Champ Ember with no visible effect, which is exactly
// the bug this list used to have (its old "cool/warm/mono" hexes matched
// nothing computeWorldStyle recognized).
const PALETTE_SWATCHES = [
  { name: "Champ Ember", key: "#FF6B35", hex: "#FF6B35" },
  { name: "Champions Group", key: "#F26722", hex: "#F26722" },
  { name: "Cyan", key: "#06B6D4", hex: "#06B6D4" },
  { name: "Violet", key: "#7C5CFF", hex: "#7C5CFF" },
];

function agentModelsFor(provider) {
  switch (provider) {
    case "groq":
      return GROQ_AGENT_MODELS;
    case "cerebras":
      return CEREBRAS_AGENT_MODELS;
    case "openrouter":
      return OPENROUTER_AGENT_MODELS;
    case "openai":
      return OPENAI_AGENT_MODELS;
    case "codex":
      return CODEX_AGENT_MODELS;
    default:
      return [];
  }
}

function currentAgentModel(settings, provider) {
  const agent = settings?.agent ?? {};
  if (provider === "ollama") return agent.ollama?.model || "";
  if (provider === "codex") return agent.codex?.model || CODEX_AGENT_MODELS[0];
  if (provider === "openrouter")
    return agent.openrouter?.model || OPENROUTER_AGENT_MODELS[0];
  if (provider === "groq") return agent.groq?.model || GROQ_AGENT_MODELS[0];
  if (provider === "cerebras")
    return agent.cerebras?.model || CEREBRAS_AGENT_MODELS[0];
  return agent.openai?.model || OPENAI_AGENT_MODELS[0];
}

function defaultAgentModel(provider) {
  if (provider === "ollama") return "llama3.2";
  return agentModelsFor(provider)[0] || "";
}

// Providers that talk to an OpenAI-compatible endpoint whose base URL the user
// may want to override (self-hosted, proxy, alternate region, local runtime).
const AGENT_BASE_URL_DEFAULT = {
  openai: "https://api.openai.com/v1",
  ollama: "http://localhost:11434/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

function currentAgentBaseURL(settings, provider) {
  const agent = settings?.agent ?? {};
  return agent?.[provider]?.baseURL || AGENT_BASE_URL_DEFAULT[provider] || "";
}

function currentSttModel(settings, provider) {
  const t = settings?.transcription ?? {};
  if (provider === "openai")
    return t.openai?.model || OPENAI_TRANSCRIPTION_MODELS[0];
  if (provider === "groq")
    return t.groq?.model || GROQ_TRANSCRIPTION_MODELS[0];
  if (provider === "deepgram")
    return t.deepgram?.model || DEEPGRAM_TRANSCRIPTION_MODELS[0];
  return t.moonshine?.model || "medium";
}

// "RESTORED · YESTERDAY 4:12 PM · 9 DRAWINGS" style timestamp.
function formatBackupWhen(savedAt) {
  const when = new Date(savedAt);
  if (Number.isNaN(when.getTime())) return "EARLIER";
  const time = when
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toUpperCase();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const todayMs = startOfDay(new Date()).getTime();
  const thenMs = startOfDay(when).getTime();
  const dayMs = 86400000;
  if (thenMs === todayMs) return `TODAY ${time}`;
  if (thenMs === todayMs - dayMs) return `YESTERDAY ${time}`;
  return `${when.toLocaleDateString([], { month: "short", day: "numeric" }).toUpperCase()} ${time}`;
}

export function SetupScreen({
  excalidrawApi,
  onStarted,
  wsClient,
  warmupState,
  settings,
  onSaveSettings,
  agentInstructions,
  onAgentInstructionsChange,
  mic,
  onMicChange,
  uiPrefs,
  onPatchUiPref,
  starting,
}) {
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [restoredText, setRestoredText] = React.useState("");
  const [restoring, setRestoring] = React.useState(false);
  const [multiSpeaker, setMultiSpeaker] = React.useState(
    Boolean(settings?.multiSpeaker),
  );
  const [canvasEmpty, setCanvasEmpty] = React.useState(true);

  // Optimistic mirrors so the pickers feel instant; saves fan out to the
  // backend (which re-warms in the background).
  const agentProvider = settings?.agent?.provider ?? "groq";
  const agentModel = currentAgentModel(settings, agentProvider);
  const sttProvider = settings?.transcription?.provider ?? "moonshine";
  const sttModel = currentSttModel(settings, sttProvider);

  // Keep the multi-speaker checkbox in sync if settings arrive/refresh.
  React.useEffect(() => {
    setMultiSpeaker(Boolean(settings?.multiSpeaker));
  }, [settings?.multiSpeaker]);

  // Poll canvas emptiness so the "Draw or paste what you have so far" hint
  // mirrors the design's showCanvasHint (empty staging canvas only).
  React.useEffect(() => {
    let cancelled = false;
    const check = () => {
      if (cancelled) return;
      const els = excalidrawApi?.getSceneElements?.() ?? [];
      setCanvasEmpty(els.length === 0);
    };
    check();
    const id = setInterval(check, 1200);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [excalidrawApi]);

  const warming = warmupState?.state === "running";
  const micLabel = (mic?.label || "System default").toUpperCase();
  const sttReadyLabel =
    sttProvider === "moonshine"
      ? "LOCAL TRANSCRIPTION"
      : sttProvider === "groq"
        ? "GROQ LPU TRANSCRIPTION"
        : sttProvider === "deepgram"
          ? "DEEPGRAM STREAMING"
          : "CLOUD TRANSCRIPTION";
  const readyText = warming
    ? `RE-WARMING · STILL FINE TO START · ${micLabel}`
    : `AGENT WARM · ${micLabel} · ${sttReadyLabel}`;

  function readinessGlyph(extraClass) {
    return h(
      "div",
      { className: `sr-ready${extraClass ? " " + extraClass : ""}` },
      h("span", {
        className: `sr-ready-dot${warming ? " warming" : ""}`,
      }),
      readyText,
    );
  }

  function saveAgentProvider(nextProvider) {
    const nextModel = defaultAgentModel(nextProvider);
    const patch = {
      agent: { provider: nextProvider, [nextProvider]: { model: nextModel } },
    };
    onSaveSettings(patch);
  }

  function saveAgentModel(nextModel) {
    onSaveSettings({ agent: { [agentProvider]: { model: nextModel } } });
  }

  function saveSttProvider(nextProvider) {
    const nextModel =
      nextProvider === "moonshine"
        ? "medium"
        : nextProvider === "groq"
          ? GROQ_TRANSCRIPTION_MODELS[0]
          : nextProvider === "deepgram"
            ? DEEPGRAM_TRANSCRIPTION_MODELS[0]
            : OPENAI_TRANSCRIPTION_MODELS[0];
    onSaveSettings({
      transcription: { provider: nextProvider, [nextProvider]: { model: nextModel } },
    });
  }

  function saveSttModel(nextModel) {
    onSaveSettings({ transcription: { [sttProvider]: { model: nextModel } } });
  }

  function toggleMulti(e) {
    const next = e.target.checked;
    setMultiSpeaker(next);
    onSaveSettings({ multiSpeaker: next });
  }

  async function restoreSession() {
    if (restoring) return;
    setRestoring(true);
    setRestoredText("");
    try {
      const backup = await apiGetLastBackup(); // 404 -> throws
      const res = await apiRestoreBackup();
      const count = res?.restored ?? (Array.isArray(backup?.elements) ? backup.elements.length : 0);
      const savedAt = res?.savedAt ?? backup?.savedAt ?? Date.now();
      // The server broadcasts whiteboard:update, which the host applies to the
      // canvas; this line just reflects the outcome in the rail.
      setRestoredText(`RESTORED · ${formatBackupWhen(savedAt)} · ${count} ${count === 1 ? "DRAWING" : "DRAWINGS"}`);
    } catch (err) {
      setRestoredText(/no /i.test(err?.message ?? "") ? "NO SAVED SESSION ON DISK" : `RESTORE FAILED · ${(err?.message ?? "unknown").toUpperCase()}`);
    } finally {
      setRestoring(false);
    }
  }

  async function startListening() {
    if (starting) return;
    await onStarted?.();
  }

  // Applies a brainstorm template: fills the intent and lays a zone skeleton
  // on the (client-owned, staging-mode) canvas. Elements from a previously
  // selected template are removed first - identified by their tpl- id prefix -
  // so switching templates swaps skeletons without touching anything the user
  // drew themselves.
  const [activeTemplateId, setActiveTemplateId] = React.useState("");

  function applyTemplate(template) {
    onAgentInstructionsChange?.(template.intent);
    setActiveTemplateId(template.id);
    const api = excalidrawApi;
    if (!api) return;
    const kept = (api.getSceneElements?.() ?? []).filter(
      (el) => !isTemplateElementId(el.id),
    );
    const skeleton = convertToExcalidrawElements(template.elements, {
      regenerateIds: false,
    });
    api.updateScene({ elements: [...kept, ...skeleton] });
    try {
      api.scrollToContent?.(skeleton, { fitToViewport: true, viewportZoomFactor: 0.75 });
    } catch {
      /* older Excalidraw builds without scrollToContent options: non-fatal */
    }
  }

  function clearTemplate() {
    onAgentInstructionsChange?.("");
    setActiveTemplateId("");
    const api = excalidrawApi;
    if (!api) return;
    const kept = (api.getSceneElements?.() ?? []).filter(
      (el) => !isTemplateElementId(el.id),
    );
    api.updateScene({ elements: kept });
  }

  return h(
    React.Fragment,
    null,

    // ============ TOP STRIP (mirrors the live Whiteboarding strip) ============
    h(
      "div",
      { className: "setup-strip" },
      h(
        "div",
        { className: "setup-brand" },
        "Champ",
        h("span", { className: "setup-brand-mark" }, "Preso"),
      ),
      h("div", { className: "setup-strip-spacer" }),
      h(
        "button",
        {
          type: "button",
          className: "setup-options-btn",
          onClick: () => setSettingsOpen(true),
          title: "Everything else: agent, transcription, mic, seeding, appearance",
        },
        settingsIcon(),
        "Options",
      ),
    ),

    // ============ THE ONE QUESTION ============
    // Centered while the canvas is empty; docks to the bottom edge once the
    // canvas has content so nothing covers the user's drawing. Everything the
    // old 39-control rail held still exists - it lives behind Options.
    h(
      "div",
      { className: `sq-card${canvasEmpty ? "" : " sq-docked"}` },
      h("div", { className: "sq-title" }, "What are we working on?"),
      h("input", {
        className: "sq-input",
        type: "text",
        value: agentInstructions ?? "",
        onChange: (e) => onAgentInstructionsChange?.(e.target.value),
        placeholder: "Say it in a line — or pick a start below",
        spellCheck: true,
        "aria-label": "What are we working on?",
      }),
      h(
        "div",
        { className: "sq-chips" },
        BRAINSTORM_TEMPLATES.map((template) =>
          h(
            "button",
            {
              key: template.id,
              type: "button",
              className: `sq-chip${activeTemplateId === template.id ? " active" : ""}`,
              title: template.tagline,
              onClick: () => applyTemplate(template),
            },
            template.label,
          ),
        ),
        agentInstructions || activeTemplateId
          ? h(
              "button",
              { type: "button", className: "sq-chip sq-chip-clear", onClick: clearTemplate },
              "Clear",
            )
          : null,
      ),
      h(
        "button",
        {
          type: "button",
          className: "setup-start sq-start",
          onClick: startListening,
          disabled: starting,
        },
        starting ? "Starting…" : "Start whiteboarding",
      ),
      readinessGlyph("sq-ready"),
      h(
        "div",
        { className: "sq-restore" },
        h(
          "button",
          {
            type: "button",
            className: "sq-restore-btn",
            onClick: restoreSession,
            disabled: restoring,
          },
          restoring ? "Restoring…" : "Restore last session",
        ),
        restoredText
          ? h(
              "span",
              { className: `sq-restored${/failed|no saved/i.test(restoredText) ? " err" : ""}` },
              restoredText,
            )
          : null,
      ),
      canvasEmpty
        ? h(
            "div",
            { className: "sq-hint" },
            "Or draw straight on the canvas — whatever is there when you start becomes the agent's starting state.",
          )
        : null,
    ),

    // ============ OPTIONS (settings sheet) ============
    settingsOpen
      ? h(SettingsSheet, {
          settings,
          agentProvider,
          agentModel,
          sttProvider,
          sttModel,
          uiPrefs,
          mic,
          onMicChange,
          onSaveSettings,
          onSaveAgentProvider: saveAgentProvider,
          onSaveAgentModel: saveAgentModel,
          onSaveSttProvider: saveSttProvider,
          onSaveSttModel: saveSttModel,
          onPatchUiPref,
          readiness: readinessGlyph("in-sheet"),
          excalidrawApi,
          agentInstructions,
          onAgentInstructionsChange,
          multiSpeaker,
          onToggleMulti: toggleMulti,
          onClose: () => setSettingsOpen(false),
        })
      : null,
  );
}

// ---- Seed affordance ----------------------------------------------------
// The Shell's setup rail carries only the static line "Seed the canvas: paste
// or draw directly on it." There is no dedicated seed input in this version of
// the source. The seed backend endpoint exists specifically to serve this
// screen, so we keep the design's descriptive line and add a minimal, tucked-
// away disclosure: a paste textarea behind a "Seed with notes" toggle that
// runs POST /api/session/seed with the current canvas as the base.
function SeedArea({ excalidrawApi }) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const [seeding, setSeeding] = React.useState(false);
  const [feedback, setFeedback] = React.useState("");

  async function seed() {
    const value = text.trim();
    if (!value || seeding) return;
    setSeeding(true);
    setFeedback("");
    try {
      const existingElements = excalidrawApi?.getSceneElements?.() ?? [];
      const res = await apiSeedCanvas({ text: value, existingElements });
      setText("");
      setFeedback(`Seeded · ${res?.elementCount ?? 0} on canvas`);
    } catch (err) {
      setFeedback(err?.message ?? "Seeding failed.");
    } finally {
      setSeeding(false);
    }
  }

  return h(
    "div",
    { className: "setup-seed" },
    h(
      "div",
      { className: "setup-seed-lead" },
      "Seed the canvas: paste or draw directly on it. The agent builds on whatever is there when you start.",
    ),
    h(
      "button",
      {
        type: "button",
        className: "setup-seed-toggle",
        onClick: () => setOpen((v) => !v),
        "aria-expanded": open,
      },
      open ? "− Hide seed notes" : "+ Seed with notes",
    ),
    open
      ? h(
          "div",
          { className: "setup-seed-body" },
          h("textarea", {
            className: "setup-seed-input",
            value: text,
            onChange: (e) => setText(e.target.value),
            placeholder: "Paste notes, bullets, or context. The agent sketches it onto the canvas.",
            spellCheck: true,
          }),
          h(
            "div",
            { className: "setup-seed-actions" },
            feedback ? h("span", { className: "setup-seed-feedback" }, feedback) : h("span", null),
            h(
              "button",
              {
                type: "button",
                className: "setup-seed-run",
                onClick: seed,
                disabled: seeding || !text.trim(),
              },
              seeding ? "Seeding…" : "Add to canvas",
            ),
          ),
        )
      : null,
  );
}

// ---- Settings sheet -----------------------------------------------------
function SettingsSheet({
  settings,
  excalidrawApi,
  agentInstructions,
  onAgentInstructionsChange,
  multiSpeaker,
  onToggleMulti,
  agentProvider,
  agentModel,
  sttProvider,
  sttModel,
  uiPrefs,
  mic,
  onMicChange,
  onSaveSettings,
  onSaveAgentProvider,
  onSaveAgentModel,
  onSaveSttProvider,
  onSaveSttModel,
  onPatchUiPref,
  readiness,
  onClose,
}) {
  const keyFlag = AGENT_KEY_FLAG[agentProvider];
  const providerUsesKey = Boolean(keyFlag);
  const hasKey = keyFlag ? Boolean(settings?.[keyFlag]) : false;
  const [apiKey, setApiKey] = React.useState("");

  function commitApiKey() {
    const value = apiKey.trim();
    if (!value || !providerUsesKey) return;
    onSaveSettings({ apiKeys: { [agentProvider]: value } });
    setApiKey("");
  }

  // Base URL (OpenAI-compatible endpoint override) and reasoning effort are
  // provider-scoped agent settings the old AgentEditor exposed. They persist via
  // the same onSaveSettings channel as provider/model.
  const providerUsesBaseURL = Object.prototype.hasOwnProperty.call(
    AGENT_BASE_URL_DEFAULT,
    agentProvider,
  );
  const savedBaseURL = currentAgentBaseURL(settings, agentProvider);
  const [baseURL, setBaseURL] = React.useState(savedBaseURL);
  // Re-sync the local mirror when the provider (and thus the saved value) changes.
  React.useEffect(() => {
    setBaseURL(savedBaseURL);
  }, [agentProvider, savedBaseURL]);

  function commitBaseURL() {
    const value = baseURL.trim();
    if (!providerUsesBaseURL || value === savedBaseURL) return;
    onSaveSettings({ agent: { [agentProvider]: { baseURL: value } } });
  }

  const reasoningEffort =
    settings?.agent?.openai?.reasoningEffort || REASONING_EFFORTS[0];

  function saveReasoningEffort(next) {
    onSaveSettings({ agent: { openai: { reasoningEffort: next } } });
  }

  const agentModelOptions = agentModelsFor(agentProvider);
  // ---- ask agent ----
  const askModel = settings?.ask?.model || ASK_MODELS[0];
  const askWebSearch = Boolean(settings?.ask?.webSearch);
  // Folders are edited as one comma-separated string and committed on blur,
  // so a half-typed path never gets saved as a folder.
  const [kbFolders, setKbFolders] = React.useState(
    (settings?.knowledgeBase?.folders ?? []).join(", "),
  );
  React.useEffect(() => {
    setKbFolders((settings?.knowledgeBase?.folders ?? []).join(", "));
  }, [settings?.knowledgeBase?.folders]);

  const sttModelOptions =
    sttProvider === "moonshine"
      ? MOONSHINE_MODELS
      : sttProvider === "groq"
        ? GROQ_TRANSCRIPTION_MODELS
        : sttProvider === "deepgram"
          ? DEEPGRAM_TRANSCRIPTION_MODELS
          : OPENAI_TRANSCRIPTION_MODELS;
  const sttHelp =
    sttProvider === "moonshine"
      ? "Runs on this Mac. Free. Names come out mediocre."
      : sttProvider === "groq"
        ? "Whisper on Groq's LPU silicon. Fastest option here, and free for 14,400 minutes a day."
        : sttProvider === "deepgram"
          ? "Streaming: captions appear while you speak, and the glossary biases names. ~$0.46/hr."
          : "Cloud, low latency, nails names. Costs money per minute.";
  const [deepgramKey, setDeepgramKey] = React.useState("");
  // Three questions by default; everything else one disclosure down.
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  function commitDeepgramKey() {
    const value = deepgramKey.trim();
    if (!value) return;
    onSaveSettings({ apiKeys: { deepgram: value } });
    setDeepgramKey("");
  }

  return h(
    React.Fragment,
    null,
    h("div", { className: "settings-scrim", onClick: onClose }),
    h(
      "div",
      { className: "settings-sheet", role: "dialog", "aria-label": "Settings" },
      h(
        "div",
        { className: "ss-head" },
        h("div", { className: "ss-title" }, "Settings"),
        h("div", { className: "ss-spacer" }),
        h(
          "button",
          { type: "button", className: "ss-close", "aria-label": "Close settings", onClick: onClose },
          closeIcon(),
        ),
      ),
      h(
        "div",
        { className: "ss-note" },
        "Changes apply now. The agent re-warms in the background, nothing blocks.",
      ),

      h(
        "div",
        { className: "ss-body" },

        // ---- THE THREE QUESTIONS ----
        h(
          "section",
          { className: "ss-group" },
          h("div", { className: "ss-q" }, "How should it listen?"),
          h(
            "select",
            {
              className: "ss-select",
              value: sttProvider,
              onChange: (e) => onSaveSttProvider(e.target.value),
              "aria-label": "How should it listen?",
            },
            h("option", { value: "moonshine" }, "Local · private, free, on this Mac"),
            h("option", { value: "groq" }, "Groq LPU · fastest, free tier"),
            h("option", { value: "deepgram" }, "Deepgram · streaming, captions as you speak"),
            h("option", { value: "openai" }, "OpenAI · realtime, accurate"),
          ),
          h("div", { className: "ss-help" }, sttHelp),
        ),

        h(
          "section",
          { className: "ss-group" },
          h("div", { className: "ss-q" }, "How should it draw?"),
          h(ModelCombobox, {
            provider: agentProvider,
            value: agentModel,
            onCommit: (model) => onSaveAgentModel(model),
          }),
          h(
            "div",
            { className: "ss-help" },
            `A fast model, because drawing happens while you are still talking. Provider: ${agentProvider} (change under Advanced).`,
          ),
        ),

        h(
          "section",
          { className: "ss-group" },
          h("div", { className: "ss-q" }, "How should it answer?"),
          h(ModelCombobox, {
            provider: "openrouter",
            value: askModel,
            onCommit: (model) => onSaveSettings({ ask: { provider: "openrouter", model } }),
          }),
          h(
            "div",
            { className: "ss-help" },
            `A stronger model for questions about the board. Web search ${askWebSearch ? "on" : "off"}.`,
          ),
        ),

        h(
          "button",
          {
            type: "button",
            className: "ss-advanced-toggle",
            onClick: () => setAdvancedOpen((v) => !v),
            "aria-expanded": advancedOpen,
          },
          h("span", null, "Advanced"),
          h("span", { className: "ss-advanced-count" }, advancedOpen ? "hide ‹" : "more settings ›"),
        ),

        ...(advancedOpen ? [

        // ---- SESSION ----
        // Migrated from the old setup rail: the one-line question on the card
        // is the short form; this is the long form plus session toggles.
        h(
          "section",
          { className: "ss-group" },
          h("div", { className: "ss-group-label" }, "SESSION"),
          ssField(
            "Agent instructions",
            h("textarea", {
              className: "ss-select ss-textarea",
              value: agentInstructions ?? "",
              onChange: (e) => onAgentInstructionsChange?.(e.target.value),
              placeholder: "Longer-form direction for the whole session…",
              spellCheck: true,
            }),
          ),
          ssField(
            "Multiple speakers",
            h(
              "label",
              { className: "ss-check" },
              h("input", {
                type: "checkbox",
                checked: Boolean(multiSpeaker),
                onChange: onToggleMulti,
              }),
              h("span", null, multiSpeaker ? "On" : "Off"),
            ),
          ),
          h(SeedArea, { excalidrawApi }),
        ),

        h("div", { className: "ss-divider" }),

        // ---- AGENT ----
        h(
          "section",
          { className: "ss-group" },
          h("div", { className: "ss-group-label" }, "AGENT"),
          ssField(
            "Provider",
            h(
              "select",
              {
                className: "ss-select",
                value: agentProvider,
                onChange: (e) => onSaveAgentProvider(e.target.value),
              },
              AGENT_PROVIDERS.map((p) => h("option", { key: p.value, value: p.value }, p.label)),
            ),
          ),
          ssField(
            "Model",
            agentProvider === "ollama"
              ? h("input", {
                  className: "ss-select",
                  type: "text",
                  value: agentModel,
                  placeholder: "e.g. llama3.2",
                  onChange: (e) => onSaveAgentModel(e.target.value),
                })
              : LIVE_CATALOG_PROVIDERS.has(agentProvider)
                ? h(ModelCombobox, {
                    provider: agentProvider,
                    value: agentModel,
                    onCommit: onSaveAgentModel,
                  })
                : h(
                    "select",
                    {
                      className: "ss-select",
                      value: agentModel,
                      onChange: (e) => onSaveAgentModel(e.target.value),
                    },
                    ensureOption(agentModelOptions, agentModel).map((m) =>
                      h("option", { key: m, value: m }, m),
                    ),
                  ),
          ),
          providerUsesKey
            ? ssField(
                "API key",
                h("input", {
                  className: "ss-select",
                  type: "password",
                  value: apiKey,
                  placeholder: hasKey ? "configured (enter to replace)" : (AGENT_KEY_PLACEHOLDER[agentProvider] || "key"),
                  onChange: (e) => setApiKey(e.target.value),
                  onBlur: commitApiKey,
                  onKeyDown: (e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitApiKey();
                    }
                  },
                }),
              )
            : null,
          agentProvider === "openai"
            ? ssField(
                "Reasoning",
                h(
                  "select",
                  {
                    className: "ss-select",
                    value: reasoningEffort,
                    onChange: (e) => saveReasoningEffort(e.target.value),
                  },
                  REASONING_EFFORTS.map((r) => h("option", { key: r, value: r }, r)),
                ),
              )
            : null,
          providerUsesBaseURL
            ? ssField(
                "Base URL",
                h("input", {
                  className: "ss-select",
                  type: "text",
                  value: baseURL,
                  placeholder: AGENT_BASE_URL_DEFAULT[agentProvider] || "",
                  onChange: (e) => setBaseURL(e.target.value),
                  onBlur: commitBaseURL,
                  onKeyDown: (e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitBaseURL();
                    }
                  },
                }),
              )
            : null,
          h(
            "div",
            { className: "ss-help" },
            "Groq is free for 14,400 minutes a day. Swap providers any time, the canvas doesn't care.",
          ),
        ),

        h("div", { className: "ss-divider" }),

        // ---- TRANSCRIPTION ----
        h(
          "section",
          { className: "ss-group" },
          h("div", { className: "ss-group-label" }, "TRANSCRIPTION"),
          h(
            "div",
            { className: "ss-seg" },
            sttSegButton("Local", "free", sttProvider === "moonshine", () => onSaveSttProvider("moonshine")),
            sttSegButton("Groq LPU", "fastest", sttProvider === "groq", () => onSaveSttProvider("groq")),
            sttSegButton("Deepgram", "streaming", sttProvider === "deepgram", () => onSaveSttProvider("deepgram")),
            sttSegButton("OpenAI", "accurate", sttProvider === "openai", () => onSaveSttProvider("openai")),
          ),
          ssField(
            "Model",
            h(
              "select",
              {
                className: "ss-select",
                value: sttModel,
                onChange: (e) => onSaveSttModel(e.target.value),
              },
              ensureOption(sttModelOptions, sttModel).map((m) => h("option", { key: m, value: m }, m)),
            ),
          ),
          sttProvider === "deepgram"
            ? ssField(
                "API key",
                h("input", {
                  className: "ss-select",
                  type: "password",
                  value: deepgramKey,
                  placeholder: settings?.hasDeepgramKey ? "configured (enter to replace)" : "dg_...",
                  onChange: (e) => setDeepgramKey(e.target.value),
                  onBlur: commitDeepgramKey,
                  onKeyDown: (e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitDeepgramKey();
                    }
                  },
                }),
              )
            : null,
          h("div", { className: "ss-help" }, sttHelp),
        ),

        h("div", { className: "ss-divider" }),

        // ---- ASK AGENT ----
        // Deliberately its own section, not a sub-setting of AGENT. The
        // drawing agent wants the fastest silicon available; the ask agent
        // answers questions about the board and wants the best reasoning you
        // can give it. Keeping them separate is the whole point.
        h(
          "section",
          { className: "ss-group" },
          h("div", { className: "ss-group-label" }, "ASK AGENT"),
          h(
            "div",
            { className: "ss-help" },
            "Answers questions about the board without drawing on it. Hit the ? button on the steer bar during a session.",
          ),
          ssField(
            "Model",
            h(ModelCombobox, {
              provider: "openrouter",
              value: askModel,
              onCommit: (model) => onSaveSettings({ ask: { provider: "openrouter", model } }),
            }),
          ),
          ssField(
            "Web search",
            h(
              "label",
              { className: "ss-check" },
              h("input", {
                type: "checkbox",
                checked: askWebSearch,
                onChange: (e) => onSaveSettings({ ask: { webSearch: e.target.checked } }),
              }),
              h("span", null, askWebSearch ? "On" : "Off"),
            ),
          ),
          h(
            "div",
            { className: "ss-help" },
            "Web search runs through OpenRouter at roughly two cents a question. Needs an OpenRouter key.",
          ),
          ssField(
            "Knowledge base",
            h("input", {
              type: "text",
              className: "ss-input",
              value: kbFolders,
              placeholder: "~/Documents/ChampPreso-KB, ~/notes",
              onChange: (e) => setKbFolders(e.target.value),
              onBlur: () =>
                onSaveSettings({
                  knowledgeBase: {
                    folders: kbFolders
                      .split(",")
                      .map((f) => f.trim())
                      .filter(Boolean),
                  },
                }),
            }),
          ),
          h(
            "div",
            { className: "ss-help" },
            "Comma-separated folders. Markdown, text, CSV and HTML are indexed locally - nothing leaves this Mac to build the index.",
          ),
        ),

        h("div", { className: "ss-divider" }),

        // ---- MICROPHONE ----
        h(MicSection, { mic, onMicChange }),

        h("div", { className: "ss-divider" }),

        // ---- APPEARANCE ----
        h(
          "section",
          { className: "ss-group" },
          h("div", { className: "ss-group-label" }, "APPEARANCE"),
          h(
            "div",
            { className: "ss-row" },
            h("span", { className: "ss-row-label" }, "Panel theme"),
            h(
              "div",
              { className: "ss-seg ss-seg-compact" },
              themeSegButton("Dark", (uiPrefs?.panelTheme ?? "dark") === "dark", () => onPatchUiPref("panelTheme", "dark")),
              themeSegButton("Light", uiPrefs?.panelTheme === "light", () => onPatchUiPref("panelTheme", "light")),
            ),
          ),
          h(
            "div",
            { className: "ss-row" },
            h("span", { className: "ss-row-label" }, "Canvas palette"),
            h(
              "div",
              { className: "ss-swatches" },
              PALETTE_SWATCHES.map((p) =>
                h("button", {
                  key: p.key,
                  type: "button",
                  className: `ss-swatch${(uiPrefs?.themePrimary ?? "#FF6B35") === p.key ? " active" : ""}`,
                  style: { background: p.hex },
                  title: p.name,
                  "aria-label": p.name,
                  onClick: () => onPatchUiPref("themePrimary", p.hex),
                }),
              ),
            ),
          ),
          h(
            "label",
            { className: "ss-check" },
            h("input", {
              type: "checkbox",
              checked: uiPrefs?.captionsOn ?? true,
              onChange: (e) => onPatchUiPref("captionsOn", e.target.checked),
            }),
            "Live captions on by default",
          ),
        ),

        ] : []),
      ),

      readiness,
    ),
  );
}

function MicSection({ mic, onMicChange }) {
  const [devices, setDevices] = React.useState([]);
  const [needsPermission, setNeedsPermission] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  // Real mic level (0-1), driven by an AnalyserNode - not a CSS animation
  // that plays whether or not anyone is speaking or even has a mic granted.
  const [level, setLevel] = React.useState(0);
  const [meterError, setMeterError] = React.useState(false);

  // Live-meters the selected device while this section is mounted and
  // permission is already granted. Opens its own short-lived stream (not
  // the full mic-capture.js resample/encode pipeline - this only needs
  // amplitude) and tears it down on unmount or device/permission change.
  React.useEffect(() => {
    if (needsPermission) {
      setLevel(0);
      return;
    }
    let cancelled = false;
    let stream;
    let context;
    let rafId;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: mic?.deviceId ? { deviceId: { exact: mic.deviceId } } : true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        context = new AudioContext();
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sumSquares = 0;
          for (let i = 0; i < data.length; i += 1) {
            const centered = (data[i] - 128) / 128;
            sumSquares += centered * centered;
          }
          const rms = Math.sqrt(sumSquares / data.length);
          // RMS speech is quiet (~0.02-0.15); scale so a normal speaking
          // voice visibly moves the bars instead of barely registering.
          setLevel(Math.min(1, rms * 6));
          rafId = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        if (!cancelled) setMeterError(true);
      }
    })();
    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      stream?.getTracks().forEach((t) => t.stop());
      context?.close().catch(() => {});
      setLevel(0);
    };
  }, [needsPermission, mic?.deviceId]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        const inputs = list.filter((d) => d.kind === "audioinput");
        if (cancelled) return;
        setDevices(inputs);
        setNeedsPermission(inputs.length > 0 && inputs.every((d) => !d.label));
      } catch {
        /* enumerateDevices can fail in locked-down contexts; leave default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function grant() {
    setBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list.filter((d) => d.kind === "audioinput"));
      setNeedsPermission(false);
    } catch {
      /* user denied; keep the hint */
    } finally {
      setBusy(false);
    }
  }

  function pick(deviceId) {
    const device = devices.find((d) => d.deviceId === deviceId);
    onMicChange?.({ deviceId: deviceId || "", label: device?.label || "" });
  }

  return h(
    "section",
    { className: "ss-group" },
    h("div", { className: "ss-group-label" }, "MICROPHONE"),
    ssField(
      "Device",
      h(
        "select",
        {
          className: "ss-select",
          value: mic?.deviceId || "",
          onChange: (e) => pick(e.target.value),
        },
        h("option", { value: "" }, "System default"),
        devices.map((d) =>
          h("option", { key: d.deviceId, value: d.deviceId }, d.label || `Device ${d.deviceId.slice(0, 8)}`),
        ),
      ),
    ),
    needsPermission
      ? h(
          "div",
          { className: "ss-mic-grant" },
          "Grant microphone access to see device names.",
          h(
            "button",
            { type: "button", className: "ss-mic-grant-btn", onClick: grant, disabled: busy },
            busy ? "…" : "Grant",
          ),
        )
      : null,
    h(
      "div",
      { className: "ss-mic-level" },
      h("span", { className: "ss-mic-level-label" }, "Level"),
      h(
        "div",
        { className: "ss-mic-bars", "aria-hidden": "true" },
        // Heights driven by the real analyser reading (level, 0-1) - each
        // bar gets a slightly different multiplier so it reads as a level
        // meter rather than three identical blocks moving in lockstep.
        [1, 0.7, 1.3].map((mult, i) =>
          h("span", {
            key: i,
            style: { height: `${4 + Math.min(1, level * mult) * 12}px` },
          }),
        ),
      ),
      h(
        "span",
        { className: "ss-mic-hint" },
        needsPermission
          ? "Grant access above, then speak — bars react to your mic."
          : meterError
            ? "Couldn't read this device's level."
            : "Speak. The bars react to real input.",
      ),
    ),
  );
}

// ---- small helpers ------------------------------------------------------
function ssField(label, control) {
  return h(
    "div",
    { className: "ss-field" },
    h("label", { className: "ss-field-label" }, label),
    control,
  );
}

// Guarantee the currently-selected value is present as an option even when it
// isn't in the catalog (e.g. a persisted OpenRouter slug we don't list).
// Model combobox. A free-text input backed by a <datalist>, rather than a
// <select>: OpenRouter serves ~290 usable models, which is far too many to
// scroll, and typing to filter is what everyone expects from a model picker.
// Free text also means any slug works the moment a provider ships it, without
// waiting on us to update a list.
//
// PROPS:
//   provider   string   - which catalog to read
//   value      string   - the configured model id
//   onCommit(id)        - called on blur / Enter, not per keystroke
//   enabled    bool     - skip fetching while the sheet is closed
//   placeholder string
function ModelCombobox({ provider, value, onCommit, enabled = true, placeholder = "" }) {
  const { models, source, loading } = useModelCatalog(provider, { enabled });
  const [draft, setDraft] = React.useState(value ?? "");
  // Warn on what's being typed, not on what's already saved: catching a dead
  // slug before it's committed is the whole point. Because draft starts at the
  // saved value, this still fires immediately for an already-broken config.
  const { warning, suggestion } = useModelWarning(provider, draft, { enabled });
  // Unique per instance. Two comboboxes on the same provider (agent and ask
  // both use OpenRouter) would otherwise emit duplicate DOM ids, and every
  // input would bind to whichever datalist the browser saw first.
  const listId = React.useId ? `models-${React.useId()}` : `models-${provider}`;

  // Follow external changes (provider switch, settings rebroadcast) but never
  // stomp what someone is mid-way through typing.
  const [focused, setFocused] = React.useState(false);
  React.useEffect(() => {
    if (!focused) setDraft(value ?? "");
  }, [value, focused]);

  function commit(next) {
    const trimmed = String(next ?? "").trim();
    if (!trimmed || trimmed === value) return;
    onCommit?.(trimmed);
  }

  const match = models.find((m) => m.id === draft);
  const detail = match ? describeModel(match) : "";

  return h(
    React.Fragment,
    null,
    h("input", {
      className: "ss-input",
      type: "text",
      list: listId,
      value: draft,
      placeholder: placeholder || (loading ? "Loading models…" : "vendor/model"),
      spellCheck: false,
      autoComplete: "off",
      onChange: (e) => {
        setDraft(e.target.value);
        // Picking from the datalist fires change with a complete id and no
        // keystroke in between; commit those immediately so a click just works.
        if (models.some((m) => m.id === e.target.value)) commit(e.target.value);
      },
      onFocus: () => setFocused(true),
      onBlur: () => {
        setFocused(false);
        commit(draft);
      },
      onKeyDown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(draft);
          e.currentTarget.blur();
        }
      },
    }),
    h(
      "datalist",
      { id: listId },
      ...models.slice(0, 400).map((m) =>
        h("option", { key: m.id, value: m.id }, describeModel(m) || m.name),
      ),
    ),
    detail ? h("div", { className: "ss-model-detail" }, detail) : null,
    warning
      ? h(
          "div",
          { className: "ss-model-warning" },
          h("span", null, warning),
          suggestion
            ? h(
                "button",
                {
                  type: "button",
                  className: "ss-model-fix",
                  onClick: () => {
                    setDraft(suggestion);
                    commit(suggestion);
                  },
                },
                `Use ${suggestion}`,
              )
            : null,
        )
      : null,
    // Provenance, but only when it is not simply "we asked the provider".
    source === "fallback" || source === "stale-cache"
      ? h(
          "div",
          { className: "ss-help" },
          source === "fallback"
            ? "Couldn't reach the provider's model list - showing a bundled list, which may be out of date. Any valid slug still works."
            : "Showing the last model list we fetched; the provider is currently unreachable.",
        )
      : null,
  );
}

// Providers whose model list we can fetch. Everything else keeps its static
// dropdown (Moonshine ships three models; Ollama is free text by nature).
const LIVE_CATALOG_PROVIDERS = new Set(["openrouter", "groq"]);

function ensureOption(options, value) {
  if (!value || options.includes(value)) return options;
  return [value, ...options];
}

function sttSegButton(label, sub, active, onClick) {
  return h(
    "button",
    { type: "button", className: `ss-seg-btn${active ? " active" : ""}`, onClick },
    h("span", { className: "ss-seg-label" }, label),
    h("span", { className: "ss-seg-sub" }, sub),
  );
}

function themeSegButton(label, active, onClick) {
  return h(
    "button",
    { type: "button", className: `ss-seg-btn ss-seg-btn-compact${active ? " active" : ""}`, onClick },
    label,
  );
}

function svgIcon(children, size = 14) {
  return h(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.5,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    },
    ...children,
  );
}

function restoreIcon() {
  return svgIcon([
    h("path", { key: "a", d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }),
    h("path", { key: "b", d: "M3 3v5h5" }),
    h("path", { key: "c", d: "M12 7v5l4 2" }),
  ]);
}

function settingsIcon() {
  return svgIcon([
    h("path", {
      key: "a",
      d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
    }),
    h("circle", { key: "b", cx: "12", cy: "12", r: "3" }),
  ]);
}

function closeIcon() {
  return svgIcon(
    [
      h("path", { key: "a", d: "M18 6 6 18" }),
      h("path", { key: "b", d: "m6 6 12 12" }),
    ],
    15,
  );
}
