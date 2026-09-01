// Shared model / option catalogs for the agent + transcription pickers.
//
// These lists were previously module-level constants inside app.js. They are
// now shared between the legacy status-card editors (AgentEditor /
// TranscriptionEditor in app.js) and the consolidated Setup screen settings
// sheet (public/screens/setup-screen.js) so the two surfaces cannot drift.

export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"];

export const OPENAI_AGENT_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
export const CODEX_AGENT_MODELS = ["gpt-5.5-fast", "gpt-5.5", "gpt-5.4"];
// Groq's fast catalog. llama-3.3-70b-versatile is the strongest tool-caller.
// llama-3.3-70b-specdec is even faster (~750 tok/s) via speculative decoding.
export const GROQ_AGENT_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.3-70b-specdec",
  "llama-3.1-70b-versatile",
  "llama-3.1-8b-instant",
  "qwen-2.5-32b",
  "deepseek-r1-distill-llama-70b",
];
// Cerebras catalog. llama-3.3-70b runs ~2000 tok/s. The smaller models are
// useful when rate limits become the bottleneck.
export const CEREBRAS_AGENT_MODELS = [
  "llama-3.3-70b",
  "llama3.1-70b",
  "llama3.1-8b",
  "qwen-3-32b",
];
// Common OpenRouter model slugs. The picker accepts free text so any
// OpenRouter slug works; these are just sensible defaults for the dropdown.
export const OPENROUTER_AGENT_MODELS = [
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "anthropic/claude-3.5-sonnet",
  "anthropic/claude-3.7-sonnet",
  "anthropic/claude-haiku-4.5",
  "openai/gpt-5.5",
  "openai/gpt-5.4-mini",
  "google/gemini-2.5-pro",
  "meta-llama/llama-3.3-70b-instruct",
  "x-ai/grok-3",
];
export const OPENAI_TRANSCRIPTION_MODELS = [
  "gpt-realtime-whisper",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "whisper-1",
];
export const MOONSHINE_MODELS = ["tiny", "small", "medium"];
// Groq Whisper on LPU silicon. Large v3 Turbo is the default: near-Large-v3
// accuracy at a fraction of the latency, and covered by the free daily tier.
export const GROQ_TRANSCRIPTION_MODELS = [
  "whisper-large-v3-turbo",
  "whisper-large-v3",
  "distil-whisper-large-v3-en",
];
// Models worth escalating a question to. The ask agent answers questions
// about the board rather than drawing it, so reasoning quality matters more
// than tokens per second. Free text is accepted too - any OpenRouter slug works.
export const ASK_MODELS = [
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-5",
  "openai/gpt-5.6-terra",
  "google/gemini-3.7-flash",
  "deepseek/deepseek-v4-pro",
  "x-ai/grok-4.6",
];

// Deepgram streaming models (static: no public list endpoint to poll).
export const DEEPGRAM_TRANSCRIPTION_MODELS = ["nova-3", "nova-2"];
