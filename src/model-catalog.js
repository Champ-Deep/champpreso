// Live model catalog.
//
// Model names go stale fast, and a stale one fails in the worst possible way:
// the config looks fine, tests pass, typecheck passes, and then a real session
// dies with "No endpoints found for <slug>". That already happened once here.
//
// So the pickers pull from the provider instead of from a list we hand-edit.
// OpenRouter's /models endpoint is public (no key needed), which makes it the
// natural source of truth - and it also tells us which models support tool
// calling, which matters more than it sounds: the drawing agent works entirely
// through tools, so a model without them produces a whiteboard that silently
// never updates. We filter those out rather than let someone pick one.
//
// Degradation ladder, best to worst:
//   live        - fetched just now
//   cache       - fetched within the TTL
//   stale-cache - refresh failed, but we hold a real list from earlier
//   fallback    - never reached the network; bundled list (may itself be stale)
//   static      - provider has no live endpoint (Moonshine, Ollama)
//
// A picker must never be empty, so every rung still returns models.

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FETCH_TIMEOUT_MS = 8000;

// Bundled last-resort list. Only used when the network is unreachable on a
// cold start. Kept short on purpose: a long hand-maintained list is exactly
// the thing this module exists to stop us from relying on.
export const OPENROUTER_FALLBACK_MODELS = Object.freeze([
  { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5" },
  { id: "anthropic/claude-opus-5", name: "Anthropic: Claude Opus 5" },
  { id: "openai/gpt-5.6-terra", name: "OpenAI: GPT-5.6 Terra" },
  { id: "google/gemini-3.7-flash", name: "Google: Gemini 3.7 Flash" },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek: V4 Flash" },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek: V4 Pro" },
  { id: "x-ai/grok-4.6", name: "xAI: Grok 4.6" },
].map((m) => Object.freeze({ ...m, contextLength: null, promptPerMillion: null, completionPerMillion: null, free: false })));

export const STATIC_MODELS = Object.freeze({
  moonshine: ["tiny", "small", "medium"],
  "moonshine-transcription": ["tiny", "small", "medium"],
  "openai-transcription": [
    "gpt-realtime-whisper",
    "gpt-4o-transcribe",
    "gpt-4o-mini-transcribe",
    "whisper-1",
  ],
  "groq-transcription": [
    "whisper-large-v3-turbo",
    "whisper-large-v3",
    "distil-whisper-large-v3-en",
  ],
  openai: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
  codex: ["gpt-5.5-fast", "gpt-5.5", "gpt-5.4"],
  cerebras: ["llama-3.3-70b", "llama3.1-70b", "llama3.1-8b", "qwen-3-32b"],
  ollama: [],
});

/**
 * @param {{
 *   fetchImpl?: (url: string, init?: any) => Promise<any>,
 *   now?: () => number,
 *   ttlMs?: number,
 *   log?: any,
 * }} [deps]
 */
export function createModelCatalog({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  log = console,
} = {}) {
  /** @type {Map<string, {models: any[], fetchedAt: number}>} */
  const cache = new Map();
  /** @type {Map<string, Promise<any>>} */
  const inFlight = new Map();

  async function fetchLive(provider, apiKey) {
    const url = provider === "groq" ? GROQ_MODELS_URL : OPENROUTER_MODELS_URL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const models =
        provider === "groq" ? normalizeGroq(payload) : normalizeOpenRouter(payload);
      if (models.length === 0) throw new Error("provider returned no usable models");
      return models;
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh(provider, apiKey) {
    const key = `${provider}`;
    if (inFlight.has(key)) return inFlight.get(key);

    const promise = (async () => {
      const models = await fetchLive(provider, apiKey);
      cache.set(key, { models, fetchedAt: now() });
      log.debug?.(`[model-catalog] ${provider}: ${models.length} model(s) live`);
      return models;
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, promise);
    return promise;
  }

  async function list(provider, { apiKey = "" } = {}) {
    const staticList = STATIC_MODELS[provider];
    if (staticList) {
      return {
        provider,
        source: "static",
        fetchedAt: null,
        error: null,
        models: staticList.map((id) => ({
          id,
          name: id,
          contextLength: null,
          promptPerMillion: null,
          completionPerMillion: null,
          free: true,
        })),
      };
    }
    // Groq's model list needs a key; without one we have nothing live to show.
    if (provider === "groq" && !apiKey) {
      return {
        provider,
        source: "static",
        fetchedAt: null,
        error: null,
        models: [],
      };
    }

    const cached = cache.get(provider);
    if (cached && now() - cached.fetchedAt < ttlMs) {
      return { provider, source: "cache", fetchedAt: cached.fetchedAt, error: null, models: cached.models };
    }

    try {
      const models = await refresh(provider, apiKey);
      return { provider, source: "live", fetchedAt: cache.get(provider).fetchedAt, error: null, models };
    } catch (error) {
      const message = error?.name === "AbortError" ? `timed out after ${FETCH_TIMEOUT_MS}ms` : error.message;
      log.warn?.(`[model-catalog] ${provider} refresh failed: ${message}`);
      // A real list from an hour ago beats a hardcoded list from last release.
      if (cached) {
        return {
          provider,
          source: "stale-cache",
          fetchedAt: cached.fetchedAt,
          error: message,
          models: cached.models,
        };
      }
      return {
        provider,
        source: "fallback",
        fetchedAt: null,
        error: message,
        models: provider === "openrouter" ? [...OPENROUTER_FALLBACK_MODELS] : [],
      };
    }
  }

  // Is the configured model still real? Used to warn before a session dies on
  // "No endpoints found". Returns known: null when we genuinely could not check
  // - claiming a model is dead because our own network is down would be worse
  // than saying nothing.
  async function verify(provider, modelId, { apiKey = "" } = {}) {
    const id = String(modelId ?? "").trim();
    if (!id) return { known: null, warning: null, suggestion: null, source: null };

    const result = await list(provider, { apiKey });
    if (result.source === "fallback" || result.models.length === 0) {
      return { known: null, warning: null, suggestion: null, source: result.source };
    }
    if (result.models.some((m) => m.id === id)) {
      return { known: true, warning: null, suggestion: null, source: result.source };
    }

    const suggestion = nearestFromSameVendor(id, result.models);
    return {
      known: false,
      source: result.source,
      warning:
        `"${id}" is no longer offered by ${provider}. Sessions using it will fail.` +
        (suggestion ? ` Closest current model: ${suggestion}.` : ""),
      suggestion,
    };
  }

  return {
    list,
    verify,
    invalidate: (provider) => (provider ? cache.delete(provider) : cache.clear()),
  };
}

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

function normalizeOpenRouter(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data
    .filter(usableForAgent)
    .map((model) => {
      const prompt = Number(model.pricing?.prompt ?? 0);
      const completion = Number(model.pricing?.completion ?? 0);
      return {
        id: model.id,
        name: model.name || model.id,
        contextLength: model.context_length ?? model.top_provider?.context_length ?? null,
        // Per million tokens: the unit a human can actually compare.
        promptPerMillion: round(prompt * 1_000_000),
        completionPerMillion: round(completion * 1_000_000),
        free: prompt === 0 && completion === 0,
        created: model.created ?? 0,
      };
    })
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
}

function usableForAgent(model) {
  if (!model?.id) return false;
  // Batch variants are async - useless when someone is mid-sentence.
  if (model.id.endsWith(":batch")) return false;
  // Both agents work through tools. A model without them draws nothing and
  // answers nothing from the knowledge base, while looking configured.
  const params = model.supported_parameters ?? [];
  if (!params.includes("tools")) return false;
  const outputs = model.architecture?.output_modalities ?? ["text"];
  return outputs.includes("text");
}

function normalizeGroq(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data
    .filter((m) => m?.id && !/whisper|tts|guard/i.test(m.id))
    .map((m) => ({
      id: m.id,
      name: m.id,
      contextLength: m.context_window ?? null,
      promptPerMillion: null,
      completionPerMillion: null,
      free: false,
      created: m.created ?? 0,
    }))
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
}

// When a configured model has disappeared, suggest its likely successor.
//
// Same vendor is the first filter, but "newest from this vendor" alone gives
// bad advice: it would answer a retired claude-3.7-SONNET with claude-opus-5,
// a different tier at five times the price. So we prefer a survivor sharing a
// family word (sonnet / opus / flash / mini / turbo / pro), and only fall back
// to newest-from-vendor when nothing in the family survives.
const FAMILY_WORDS = ["sonnet", "opus", "haiku", "flash", "mini", "turbo", "pro", "lite", "instant"];

function nearestFromSameVendor(modelId, models) {
  const [vendor, rest = ""] = modelId.split("/");
  if (!vendor) return null;
  const sameVendor = models.filter((m) => m.id.startsWith(`${vendor}/`));
  if (sameVendor.length === 0) return null;

  const family = FAMILY_WORDS.find((word) => rest.toLowerCase().includes(word));
  if (family) {
    const sameFamily = sameVendor.filter((m) => m.id.toLowerCase().includes(family));
    if (sameFamily.length > 0) return sameFamily[0].id;
  }
  return sameVendor[0].id;
}

function round(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}
