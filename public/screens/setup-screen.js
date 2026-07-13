// Setup screen (redesign). Translates the design source's SETUP RAIL and
// consolidated SETTINGS SHEET (docs/design-handoff/frontend-source/
// ChampPreso-Shell.dc.html) into real React + wiring against the live backend.
//
// This replaces the old staging-mode side panel: the session-intent textarea,
// the multiple-speakers toggle, restore-last-session, a single scrollable
// settings sheet (agent / transcription / mic / appearance), a canvas seed
// affordance, the readiness glyph, and the "Start listening" button.
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
  REASONING_EFFORTS,
} from "../model-catalog.js";

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
    sttProvider === "moonshine" ? "LOCAL TRANSCRIPTION" : "CLOUD TRANSCRIPTION";
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
    const nextModel = nextProvider === "moonshine" ? "medium" : OPENAI_TRANSCRIPTION_MODELS[0];
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
      // scrollToContent centers on the full window, but the setup rail covers
      // the left ~284px - shift the content right by half the rail so it
      // centers within the visible canvas area instead (same correction the
      // .setup-canvas-hint CSS makes). Deferred so the fit commits first.
      setTimeout(() => {
        const appState = api.getAppState?.();
        if (!appState) return;
        const zoom = appState.zoom?.value ?? 1;
        api.updateScene({ appState: { scrollX: appState.scrollX + 142 / zoom } });
      }, 60);
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
    // Empty-canvas hint (design showCanvasHint). Non-interactive overlay.
    canvasEmpty
      ? h(
          "div",
          { className: "setup-canvas-hint", "aria-hidden": "true" },
          h("div", { className: "sch-lead" }, "Draw or paste what you have so far"),
          h(
            "div",
            { className: "sch-sub" },
            "Whatever is on this canvas when you start becomes the agent's starting state. Blank is fine too.",
          ),
        )
      : null,

    // ============ SETUP RAIL ============
    h(
      "div",
      { className: "setup-rail" },
      h(
        "div",
        { className: "setup-brand" },
        "Champ",
        h("span", { className: "setup-brand-mark" }, "Preso"),
      ),
      h("div", { className: "setup-eyebrow" }, "NEW SESSION"),

      h(
        "div",
        { className: "setup-intent" },
        h("label", { htmlFor: "setup-intent-input" }, "Where should this conversation land?"),
        h("textarea", {
          id: "setup-intent-input",
          value: agentInstructions ?? "",
          onChange: (e) => onAgentInstructionsChange?.(e.target.value),
          placeholder: "Get to a concrete Q3 plan for Lake Stream",
          spellCheck: true,
        }),
        h(
          "div",
          { className: "setup-intent-hint" },
          "The intent steers what gets drawn. A goal converges the canvas. A question maps it.",
        ),
        h(
          "div",
          { className: "setup-templates-label" },
          "OR START FROM A TEMPLATE",
        ),
        h(
          "div",
          { className: "setup-intent-templates" },
          BRAINSTORM_TEMPLATES.map((template) =>
            h(
              "button",
              {
                key: template.id,
                type: "button",
                className: `setup-intent-template${activeTemplateId === template.id ? " active" : ""}`,
                title: template.tagline,
                onClick: () => applyTemplate(template),
              },
              template.label,
            ),
          ),
          agentInstructions || activeTemplateId
            ? h(
                "button",
                {
                  type: "button",
                  className: "setup-intent-template setup-intent-template-clear",
                  onClick: clearTemplate,
                },
                "Clear",
              )
            : null,
        ),
      ),

      h(
        "label",
        { className: "setup-check" },
        h("input", {
          type: "checkbox",
          checked: multiSpeaker,
          onChange: toggleMulti,
        }),
        "Multiple speakers",
      ),

      h(
        "div",
        { className: "setup-restore-group" },
        h(
          "button",
          {
            type: "button",
            className: "setup-ghost-btn",
            onClick: restoreSession,
            disabled: restoring,
          },
          restoreIcon(),
          restoring ? "Restoring…" : "Restore last session",
        ),
        // Always rendered (space reserved via CSS min-height even when
        // empty) rather than only mounted once there's text - a
        // conditionally-mounted sibling here pushed the Settings button
        // (and everything after it) down every time a restore result
        // appeared, which read as the whole rail "glitching" on restore.
        h(
          "div",
          {
            className: `setup-restored${restoredText ? " visible" : ""}${/failed|no saved/i.test(restoredText) ? " err" : ""}`,
          },
          restoredText,
        ),
      ),

      h(
        "button",
        {
          type: "button",
          className: "setup-ghost-btn",
          onClick: () => setSettingsOpen(true),
        },
        settingsIcon(),
        h(
          "span",
          { className: "setup-ghost-btn-text" },
          h("span", { className: "setup-ghost-btn-title" }, "Settings"),
          h("span", { className: "setup-ghost-btn-sub" }, "Agent, transcription, mic"),
        ),
      ),

      h("div", { className: "setup-spacer" }),

      h(SeedArea, { excalidrawApi }),

      h(
        "button",
        {
          type: "button",
          className: "setup-start",
          onClick: startListening,
          disabled: starting,
        },
        starting ? "Starting…" : "Start listening",
      ),

      readinessGlyph(),
    ),

    // ============ SETTINGS SHEET ============
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
  const sttModelOptions =
    sttProvider === "moonshine" ? MOONSHINE_MODELS : OPENAI_TRANSCRIPTION_MODELS;
  const sttHelp =
    sttProvider === "moonshine"
      ? "Runs on this Mac. Free. Names come out mediocre."
      : "Cloud, low latency, nails names. Costs money per minute.";

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
            sttSegButton("Local", "free · runs on this Mac", sttProvider === "moonshine", () => onSaveSttProvider("moonshine")),
            sttSegButton("Cloud", "very accurate · paid", sttProvider === "openai", () => onSaveSttProvider("openai")),
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
          h("div", { className: "ss-help" }, sttHelp),
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
function ensureOption(options, value) {
  if (!value || options.includes(value)) return options;
  return [value, ...options];
}

function sttSegButton(label, sub, active, onClick) {
  return h(
    "button",
    { type: "button", className: `ss-seg-btn${active ? " active" : ""}`, onClick },
    label,
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
