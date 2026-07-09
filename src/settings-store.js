import fs from "node:fs/promises";
import path from "node:path";

import { readCodexCliAuthSync } from "./codex-auth.js";

export const MAX_AGENT_INSTRUCTIONS_CHARS = 100_000;

export const DEFAULT_SETTINGS = Object.freeze({
  agent: {
    provider: "openai",
    openai: { model: "gpt-5.5", reasoningEffort: "low", baseURL: "https://api.openai.com/v1" },
    codex: { model: "gpt-5.5-fast", baseURL: "https://chatgpt.com/backend-api/codex" },
    ollama: { model: "", baseURL: "http://localhost:11434/v1" },
    openrouter: { model: "deepseek/deepseek-v4-flash", baseURL: "https://openrouter.ai/api/v1" },
    // Fast inference providers. Same OpenAI-compatible API surface.
    groq: { model: "llama-3.3-70b-versatile", baseURL: "https://api.groq.com/openai/v1" },
    cerebras: { model: "llama-3.3-70b", baseURL: "https://api.cerebras.ai/v1" },
  },
  transcription: {
    provider: "moonshine",
    moonshine: { model: "medium" },
    openai: { model: "gpt-realtime-whisper" },
    // v0.11.0: Groq Whisper Large v3 Turbo. OpenAI-compatible /audio/transcriptions
    // endpoint. 14,400 free minutes per day. Strong on noisy real-life audio
    // because Whisper Large v3 is the SOTA Whisper variant.
    groq: { model: "whisper-large-v3-turbo", baseURL: "https://api.groq.com/openai/v1" },
  },
  apiKeys: {
    openai: "",
    openrouter: "",
    groq: "",
    cerebras: "",
  },
  agentInstructions: "",
  // Notes and transcripts. Free-form reference material the user drops into
  // the staging panel (typed or file-dropped). Cap is generous: 200K chars
  // (roughly a 50-page transcript). The primer message will surface this to
  // the agent on every preso.
  notesAndTranscripts: "",
  // Multiple speakers in the room. Top-level (not under ui) because
  // server.js reads settings.multiSpeaker directly in POST /api/session/start
  // and POST /api/session/seed, and the frontend Setup screen saves it
  // top-level via saveSettings({ multiSpeaker }). When true, the agent is
  // told to track and attribute distinct voices instead of assuming one
  // speaker.
  multiSpeaker: false,
  // UI preferences. Every Aegis-spec toggle so the user can adjust the entire
  // surface without editing CSS. Persisted via PUT /api/settings, rebroadcast
  // on every save so all WS clients converge instantly.
  ui: {
    // Champ Suite Ember by default. Switch to #F26722 (Champions Group parent)
    // or any of the world hues in the dropdown.
    themePrimary: "#FF6B35",
    // Backlog Pill placement relative to Pause Capture button.
    backlogPosition: "below", // "above" | "below"
    // Status Card density in PRESO. "expand" keeps all three rows; "collapse"
    // shrinks to a single line, click-to-expand.
    statusDensity: "expand", // "expand" | "collapse"
    // Live captions on/off and visual variant.
    captionsOn: true,
    captionMode: "presentation", // "presentation" | "working"
    // Floating Question Card anchor edge.
    questionPos: "top", // "top" | "bottom"
    // Canvas palette swatch row on/off + which palette is active.
    paletteRow: true,
    activePalette: "champions", // "champions" | "cool" | "warm" | "mono"
    // Mode toggle breathing underline micro-interaction.
    toggleBreathe: true,
    // First-launch onboarding ribbon. User dismisses; persists as false.
    onboarding: true,
    // Dark panel vs light panel. Aegis defaults to dark.
    panelTheme: "dark", // "dark" | "light"
    // Provider fallback chain. When the primary provider errors or times out,
    // the server tries the next in this list. Empty entries are skipped.
    providerFallback: ["groq", "openrouter", "openai", "ollama"],
    // Agent timeout per turn (ms). Lower than v0.6's 90s to fail fast.
    agentTimeoutMs: 30000,
    // Number of retries on a timed-out or failed turn before giving up.
    agentMaxRetries: 1,
  },
});

export function createSettingsStore({ filePath, env = process.env, readCodexAuth = readCodexCliAuthSync }) {
  let cached = null;

  async function readFromDisk() {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return deepMerge(cloneDefaults(), JSON.parse(raw));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function writeToDisk(settings) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(settings, null, 2), { mode: 0o600 });
    try {
      await fs.chmod(filePath, 0o600);
    } catch {}
  }

  async function load() {
    if (cached) return cached;
    const fromDisk = await readFromDisk();
    if (fromDisk) {
      cached = fromDisk;
      return cached;
    }
    const seeded = seedFromEnv(cloneDefaults(), env, readCodexAuth);
    await writeToDisk(seeded);
    cached = seeded;
    return cached;
  }

  async function save(partial) {
    if (!cached) await load();
    validateAgentInstructions(partial?.agentInstructions);
    cached = deepMerge(cached, partial);
    await writeToDisk(cached);
    return cached;
  }

  async function getSanitized() {
    const settings = await load();
    const { apiKeys, ...rest } = settings;
    return {
      ...rest,
      hasOpenAIKey: Boolean(apiKeys?.openai),
      hasOpenRouterKey: Boolean(apiKeys?.openrouter),
      hasGroqKey: Boolean(apiKeys?.groq),
      hasCerebrasKey: Boolean(apiKeys?.cerebras),
    };
  }

  return { load, save, getSanitized };
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function deepMerge(target, source) {
  if (!source || typeof source !== "object") return target;
  const result = Array.isArray(target) ? [...target] : { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(result[key] ?? {}, value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function seedFromEnv(settings, env, readCodexAuth) {
  const next = settings;
  const openaiKey = trimOrEmpty(env.OPENAI_API_KEY);
  if (openaiKey) next.apiKeys.openai = openaiKey;

  const openrouterKey = trimOrEmpty(env.OPENROUTER_API_KEY);
  if (openrouterKey) next.apiKeys.openrouter = openrouterKey;

  const groqKey = trimOrEmpty(env.GROQ_API_KEY);
  if (groqKey) next.apiKeys.groq = groqKey;
  const groqModel = trimOrEmpty(env.GROQ_MODEL);
  if (groqModel) next.agent.groq.model = groqModel;

  const cerebrasKey = trimOrEmpty(env.CEREBRAS_API_KEY);
  if (cerebrasKey) next.apiKeys.cerebras = cerebrasKey;
  const cerebrasModel = trimOrEmpty(env.CEREBRAS_MODEL);
  if (cerebrasModel) next.agent.cerebras.model = cerebrasModel;

  const openaiModel = trimOrEmpty(env.OPENAI_MODEL);
  if (openaiModel) next.agent.openai.model = openaiModel;

  const openaiBaseURL = trimOrEmpty(env.OPENAI_BASE_URL);
  if (openaiBaseURL) next.agent.openai.baseURL = openaiBaseURL;

  const reasoningEffort = trimOrEmpty(env.OPENAI_REASONING_EFFORT);
  if (reasoningEffort) next.agent.openai.reasoningEffort = reasoningEffort;

  const codexModel = trimOrEmpty(env.CODEX_MODEL);
  if (codexModel) next.agent.codex.model = codexModel;

  const codexBaseURL = trimOrEmpty(env.CODEX_BASE_URL);
  if (codexBaseURL) next.agent.codex.baseURL = codexBaseURL;

  const ollamaModel = trimOrEmpty(env.OLLAMA_MODEL);
  if (ollamaModel) next.agent.ollama.model = ollamaModel;

  const ollamaBaseURL = trimOrEmpty(env.OLLAMA_BASE_URL);
  if (ollamaBaseURL) next.agent.ollama.baseURL = ollamaBaseURL;

  const openrouterModel = trimOrEmpty(env.OPENROUTER_MODEL);
  if (openrouterModel) next.agent.openrouter.model = openrouterModel;

  const openrouterBaseURL = trimOrEmpty(env.OPENROUTER_BASE_URL);
  if (openrouterBaseURL) next.agent.openrouter.baseURL = openrouterBaseURL;

  // First-run provider precedence:
  // Groq > Cerebras > Codex CLI > OpenRouter > Ollama > OpenAI.
  // Fast inference providers win when present because brainstorming feels
  // qualitatively different at 400+ tok/s.
  const codexAuth = safeReadCodexAuth(readCodexAuth, env);
  if (groqKey) next.agent.provider = "groq";
  else if (cerebrasKey) next.agent.provider = "cerebras";
  else if (codexAuth) next.agent.provider = "codex";
  else if (openrouterKey) next.agent.provider = "openrouter";
  else if (ollamaModel) next.agent.provider = "ollama";
  else next.agent.provider = "openai";

  if (openaiKey) next.transcription.provider = "openai";

  return next;
}

function safeReadCodexAuth(readCodexAuth, env) {
  try {
    return readCodexAuth(env);
  } catch {
    return null;
  }
}

function trimOrEmpty(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

export function validateAgentInstructions(value) {
  if (typeof value === "string" && value.length > MAX_AGENT_INSTRUCTIONS_CHARS) {
    throw new Error(`Agent instructions must be ${MAX_AGENT_INSTRUCTIONS_CHARS} characters or fewer.`);
  }
}
