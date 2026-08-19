import { createOpenAI } from "@ai-sdk/openai";

import { DEFAULT_CODEX_BASE_URL, createCodexFetch, readCodexCliAuthSync } from "./codex-auth.js";

const DEFAULT_OPENAI_AGENT_MODEL = "gpt-5.5";
const DEFAULT_CODEX_AGENT_MODEL = "gpt-5.5-fast";
// DeepSeek V4 Flash: tool-calling capable, 1M context, ~$0.09/$0.18 per 1M
// tokens - dramatically cheaper than the Claude/GPT tier for realtime
// whiteboarding. This is the cost-effective default for OpenRouter.
const DEFAULT_OPENROUTER_AGENT_MODEL = "deepseek/deepseek-v4-flash";
// Groq runs Llama-class models on LPU silicon at 400-800 tok/s. Llama 3.3 70B
// Versatile is the sweet spot for tool-calling under realtime pressure.
const DEFAULT_GROQ_AGENT_MODEL = "llama-3.3-70b-versatile";
// Cerebras serves Llama on wafer-scale chips. Even faster than Groq on the
// shared 70B model. Slightly tighter rate limits.
const DEFAULT_CEREBRAS_AGENT_MODEL = "llama-3.3-70b";
const DEFAULT_OPENAI_REASONING_EFFORT = "low";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";
const OPENAI_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh"]);

export function defaultWhiteboardAgentProvider(options = {}) {
  return {
    provider: "openai",
    model: DEFAULT_OPENAI_AGENT_MODEL,
    apiKey: options.openaiApiKey,
    baseURL: DEFAULT_OPENAI_BASE_URL,
    reasoningEffort: DEFAULT_OPENAI_REASONING_EFFORT,
  };
}

export function resolveAgentProviderFromSettings({ settings, env = process.env }) {
  const provider = settings.agent.provider;

  if (provider === "ollama") {
    const model = (settings.agent.ollama.model ?? "").trim();
    if (!model) throw new Error("Ollama model is not configured. Set it in the agent settings.");
    return {
      provider: "ollama",
      model,
      baseURL: withoutTrailingSlash(settings.agent.ollama.baseURL ?? DEFAULT_OLLAMA_BASE_URL),
      apiKey: "ollama",
    };
  }

  if (provider === "openrouter") {
    const model = (settings.agent.openrouter?.model ?? "").trim() || DEFAULT_OPENROUTER_AGENT_MODEL;
    const apiKey = (settings.apiKeys?.openrouter ?? "").trim() || cleanEnvValue(env.OPENROUTER_API_KEY);
    if (!apiKey) {
      throw new Error("OpenRouter API key is not configured. Add it in the agent settings or set OPENROUTER_API_KEY.");
    }
    return {
      provider: "openrouter",
      model,
      apiKey,
      baseURL: withoutTrailingSlash(settings.agent.openrouter?.baseURL ?? DEFAULT_OPENROUTER_BASE_URL),
    };
  }

  if (provider === "groq") {
    const model = (settings.agent.groq?.model ?? "").trim() || DEFAULT_GROQ_AGENT_MODEL;
    const apiKey = (settings.apiKeys?.groq ?? "").trim() || cleanEnvValue(env.GROQ_API_KEY);
    if (!apiKey) {
      throw new Error("Groq API key is not configured. Add it in the agent settings or set GROQ_API_KEY.");
    }
    return {
      provider: "groq",
      model,
      apiKey,
      baseURL: withoutTrailingSlash(settings.agent.groq?.baseURL ?? DEFAULT_GROQ_BASE_URL),
    };
  }

  if (provider === "cerebras") {
    const model = (settings.agent.cerebras?.model ?? "").trim() || DEFAULT_CEREBRAS_AGENT_MODEL;
    const apiKey = (settings.apiKeys?.cerebras ?? "").trim() || cleanEnvValue(env.CEREBRAS_API_KEY);
    if (!apiKey) {
      throw new Error("Cerebras API key is not configured. Add it in the agent settings or set CEREBRAS_API_KEY.");
    }
    return {
      provider: "cerebras",
      model,
      apiKey,
      baseURL: withoutTrailingSlash(settings.agent.cerebras?.baseURL ?? DEFAULT_CEREBRAS_BASE_URL),
    };
  }

  if (provider === "codex") {
    const codexAuth = readCodexCliAuthSync(env);
    if (!codexAuth) throw new Error("Codex CLI auth not found. Run `codex` and sign in with ChatGPT.");
    const codexModel = resolveCodexModel(settings.agent.codex.model || DEFAULT_CODEX_AGENT_MODEL);
    return {
      provider: "codex",
      ...codexModel,
      baseURL: withoutTrailingSlash(settings.agent.codex.baseURL ?? DEFAULT_CODEX_BASE_URL),
      apiKey: codexAuth.accessToken,
      reasoningEffort: validateReasoningEffort(settings.agent.openai.reasoningEffort),
    };
  }

  const apiKey = (settings.apiKeys?.openai ?? "").trim() || cleanEnvValue(env.OPENAI_API_KEY);
  if (!apiKey) throw new Error("OpenAI API key is not configured. Add it in the agent settings.");
  return {
    provider: "openai",
    model: settings.agent.openai.model || DEFAULT_OPENAI_AGENT_MODEL,
    apiKey,
    reasoningEffort: validateReasoningEffort(settings.agent.openai.reasoningEffort),
    baseURL: withoutTrailingSlash(cleanEnvValue(settings.agent.openai.baseURL) ?? DEFAULT_OPENAI_BASE_URL),
  };
}

// The ASK agent's provider. Deliberately separate from the drawing agent: the
// drawing agent wants the fastest silicon it can get, while a question about
// the board wants the most capable model available. Falls back to the drawing
// agent's provider when settings.ask isn't configured.
export function resolveAskProviderFromSettings({ settings, env = process.env }) {
  const ask = settings?.ask ?? {};
  const provider = (ask.provider ?? "").trim();
  if (!provider) return resolveAgentProviderFromSettings({ settings, env });

  // Reuse the main resolver by presenting it a settings object whose agent
  // block is the ask block, so key lookup, base URLs, and every provider's
  // error message stay identical across both paths.
  const model = (ask.model ?? "").trim();
  const shimmed = {
    ...settings,
    agent: {
      ...settings.agent,
      provider,
      [provider]: {
        ...(settings.agent?.[provider] ?? {}),
        ...(model ? { model } : {}),
      },
    },
  };
  return resolveAgentProviderFromSettings({ settings: shimmed, env });
}

function validateReasoningEffort(reasoningEffort) {
  const value = reasoningEffort || DEFAULT_OPENAI_REASONING_EFFORT;
  if (!OPENAI_REASONING_EFFORTS.has(value)) {
    throw new Error(`Unsupported reasoning effort "${value}". Use none, low, medium, high, or xhigh.`);
  }
  return value;
}

export function createWhiteboardAgentModel(agentProvider) {
  if (agentProvider.provider === "ollama") {
    const ollama = createOpenAI({
      name: "ollama",
      baseURL: agentProvider.baseURL,
      apiKey: agentProvider.apiKey,
    });
    return ollama.chat(agentProvider.model);
  }

  if (agentProvider.provider === "openrouter") {
    // OpenRouter is OpenAI-compatible. Use the OpenAI provider with a custom
    // baseURL pointed at openrouter.ai and the OpenRouter API key.
    // The HTTP-Referer and X-Title headers let OpenRouter attribute traffic
    // to ChampPreso, which improves rate limits and shows up in your dashboard.
    const openrouter = createOpenAI({
      name: "openrouter",
      baseURL: agentProvider.baseURL,
      apiKey: agentProvider.apiKey,
      headers: {
        "HTTP-Referer": "https://github.com/Champ-Deep/champpreso",
        "X-Title": "ChampPreso (Champions Group)",
      },
    });
    return openrouter.chat(agentProvider.model);
  }

  if (agentProvider.provider === "groq") {
    // Groq's chat-completions endpoint is OpenAI-compatible. Llama 3.3 70B
    // Versatile streams at 400-800 tok/s on their LPU silicon - the biggest
    // perceptual latency win we can land for free-tier brainstorming.
    const groq = createOpenAI({
      name: "groq",
      baseURL: agentProvider.baseURL,
      apiKey: agentProvider.apiKey,
    });
    return groq.chat(agentProvider.model);
  }

  if (agentProvider.provider === "cerebras") {
    // Cerebras Inference. Llama 3.3 70B at 2000+ tok/s on wafer-scale chips.
    // OpenAI-compatible endpoint.
    const cerebras = createOpenAI({
      name: "cerebras",
      baseURL: agentProvider.baseURL,
      apiKey: agentProvider.apiKey,
    });
    return cerebras.chat(agentProvider.model);
  }

  if (agentProvider.provider === "codex") {
    const codex = createOpenAI({
      name: "openai-codex",
      baseURL: agentProvider.baseURL,
      apiKey: agentProvider.apiKey,
      fetch: createCodexFetch(),
    });
    return codex.responses(agentProvider.model);
  }

  const openai = createOpenAI({
    apiKey: agentProvider.apiKey,
    baseURL: agentProvider.baseURL,
  });
  return openai(agentProvider.model);
}

function cleanEnvValue(value) {
  const trimmedValue = value?.trim();
  return trimmedValue || undefined;
}

function withoutTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function resolveCodexModel(requestedModel) {
  if (requestedModel.endsWith("-fast")) {
    return {
      model: requestedModel.slice(0, -"-fast".length),
      requestedModel,
      serviceTier: "priority",
    };
  }
  return { model: requestedModel };
}
