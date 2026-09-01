// Groq Whisper transcription provider.
//
// Groq serves Whisper Large v3 Turbo on LPU silicon, which returns a short
// utterance in a few hundred milliseconds - the single biggest perceived
// latency win available to us, and free up to 14,400 minutes/day.
//
// Unlike OpenAI Realtime (a streaming WSS session) Groq exposes a plain
// OpenAI-compatible /audio/transcriptions endpoint: you POST a complete audio
// file and get text back. So this provider does its own turn segmentation -
// it buffers incoming PCM frames and flushes an utterance when the speaker
// goes quiet, or when the buffer hits a ceiling, whichever comes first.
//
// Implements the same factory contract as the Moonshine and OpenAI providers
// (see createTranscriptionManager in server.js):
//   factory({ sendTranscript, queueTranscript, options, env })
//     -> { ready(), sendAudio(base64Pcm16), stop(), close(), setSessionContext() }

import { cleanTranscript } from "./transcript-hygiene.js";
import { buildTranscriptionVocabularyPrompt } from "./whiteboard-keywords.js";

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_MODEL = "whisper-large-v3-turbo";
// The browser captures at 24 kHz mono PCM16 (see public/mic-capture.js).
const SAMPLE_RATE = 24000;

// Mean absolute amplitude below which a frame counts as silence. PCM16 is
// -32768..32767, so this is roughly -46 dBFS - quiet room, not dead air.
// This is the BASE threshold; createNoiseFloorTracker scales it up in rooms
// with steady background hum so silence detection keeps working there.
const SILENCE_RMS = 180;
// How many recent frame levels the noise tracker remembers (~6s at the
// browser's ~100ms frames), which percentile counts as "ambient", how far
// above ambient speech must rise, and a cap so a pathologically loud room
// can never push the threshold beyond real speech levels.
const NOISE_WINDOW_FRAMES = 60;
const NOISE_PERCENTILE = 0.1;
const NOISE_MULTIPLIER = 2.5;
const NOISE_THRESHOLD_CAP = 4000;

/**
 * Rolling ambient-noise estimator. update(level) returns the silence
 * threshold to use for that frame: the base threshold in quiet rooms, or a
 * multiple of the learned ambient floor in humming ones. The floor is a low
 * percentile of recent levels, so speech bursts (a minority of frames across
 * the window) cannot drag it up, and the cap keeps even continuous loud
 * audio classifiable.
 */
export function createNoiseFloorTracker({
  base = SILENCE_RMS,
  windowSize = NOISE_WINDOW_FRAMES,
  percentile = NOISE_PERCENTILE,
  multiplier = NOISE_MULTIPLIER,
  cap = NOISE_THRESHOLD_CAP,
} = {}) {
  /** @type {number[]} */
  const levels = [];
  return {
    /** @param {number} level */
    update(level) {
      levels.push(level);
      if (levels.length > windowSize) levels.shift();
      const sorted = [...levels].sort((a, b) => a - b);
      const floor = sorted[Math.floor(sorted.length * percentile)] ?? 0;
      return Math.min(cap, Math.max(base, floor * multiplier));
    },
  };
}
// Trailing quiet needed before we treat the utterance as finished. Short
// enough to feel responsive, long enough not to cut mid-sentence.
const SILENCE_HOLD_MS = 600;
// Hard ceiling on one buffered utterance. Somebody talking without pause
// still gets transcribed in chunks rather than waiting for them to stop.
const MAX_UTTERANCE_MS = 6000;
// Don't bother posting an utterance shorter than this - it's a click or a
// breath, and Whisper reliably hallucinates on such clips.
const MIN_UTTERANCE_MS = 320;

/**
 * @param {{
 *   sendTranscript: (message: any) => void,
 *   queueTranscript: (text: string) => void,
 *   options?: { groqTranscriptionModel?: string, groqTranscriptionBaseURL?: string, groqApiKey?: string },
 *   env?: Record<string, string | undefined>,
 *   fetchImpl?: (url: string, init: any) => Promise<any>,
 *   log?: any,
 * }} deps
 */
export function createGroqTranscription({
  sendTranscript,
  queueTranscript,
  options = {},
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console,
}) {
  const model = options.groqTranscriptionModel || DEFAULT_MODEL;
  const baseURL = withoutTrailingSlash(options.groqTranscriptionBaseURL || DEFAULT_BASE_URL);

  let apiKey = "";
  let vocabularyPrompt = "";
  let closed = false;

  // Buffered audio for the utterance currently being spoken.
  /** @type {Buffer[]} */
  let chunks = [];
  let bufferedMs = 0;
  let quietMs = 0;
  let sawSpeech = false;
  // Serializes in-flight posts so turns reach the queue in spoken order.
  let pending = Promise.resolve();
  // Learns the room's ambient level so background hum reads as silence.
  const noiseFloor = createNoiseFloorTracker();

  function resolveApiKey() {
    const key = (options.groqApiKey ?? env.GROQ_API_KEY ?? "").trim();
    if (!key) {
      throw new Error("GROQ_API_KEY is required for the Groq transcription provider.");
    }
    return key;
  }

  function resetBuffer() {
    chunks = [];
    bufferedMs = 0;
    quietMs = 0;
    sawSpeech = false;
  }

  // Take everything buffered so far and post it. Returns immediately; the
  // actual request is chained onto `pending`.
  function flush() {
    if (chunks.length === 0) return;
    const audio = Buffer.concat(chunks);
    const durationMs = bufferedMs;
    const hadSpeech = sawSpeech;
    resetBuffer();

    if (!hadSpeech || durationMs < MIN_UTTERANCE_MS) return;

    pending = pending.then(() => transcribe(audio)).catch(() => {});
  }

  async function transcribe(audio) {
    if (closed) return;
    let key;
    try {
      key = apiKey || resolveApiKey();
    } catch (error) {
      sendTranscript({ type: "error", message: error.message });
      return;
    }

    const form = new FormData();
    form.append("file", new Blob([pcm16ToWav(audio, SAMPLE_RATE)], { type: "audio/wav" }), "audio.wav");
    form.append("model", model);
    form.append("response_format", "json");
    // Whisper's `prompt` biases decoding toward the supplied vocabulary. We
    // feed it the terms already on the staging canvas so product names and
    // jargon come back spelled the way the room writes them.
    if (vocabularyPrompt) form.append("prompt", vocabularyPrompt);

    let response;
    try {
      response = await fetchImpl(`${baseURL}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
    } catch (error) {
      log.warn?.(`[groq-transcription] request failed: ${error.message}`);
      sendTranscript({ type: "error", message: `Groq transcription request failed: ${error.message}` });
      return;
    }

    if (!response.ok) {
      const detail = await safeText(response);
      log.warn?.(`[groq-transcription] HTTP ${response.status}: ${detail}`);
      sendTranscript({
        type: "error",
        message: `Groq transcription failed (HTTP ${response.status}). ${detail}`.trim(),
      });
      return;
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      sendTranscript({ type: "error", message: `Groq returned an unreadable response: ${error.message}` });
      return;
    }

    // Same hygiene pass the other providers use, so "uh", "thanks for
    // watching" and other Whisper filler never reach the agent as a turn.
    const text = cleanTranscript(String(payload?.text ?? ""));
    if (!text) return;

    sendTranscript({ type: "transcript:committed", text });
    queueTranscript(text);
  }

  return {
    ready: async () => {
      apiKey = resolveApiKey();
      closed = false;
    },

    sendAudio: (audio) => {
      if (closed || !audio) return;
      const pcm = Buffer.from(audio, "base64");
      if (pcm.length === 0) return;

      const frameMs = (pcm.length / 2 / SAMPLE_RATE) * 1000;
      const level = meanAmplitude(pcm);
      const loud = level >= noiseFloor.update(level);

      // Drop leading silence so an utterance starts at the first real sound.
      if (!sawSpeech && !loud) return;

      chunks.push(pcm);
      bufferedMs += frameMs;
      if (loud) {
        sawSpeech = true;
        quietMs = 0;
      } else {
        quietMs += frameMs;
      }

      if (sawSpeech && quietMs >= SILENCE_HOLD_MS) {
        flush();
        return;
      }
      if (bufferedMs >= MAX_UTTERANCE_MS) flush();
    },

    /** @param {{ keywords?: string[] | null }} [ctx] */
    setSessionContext: (ctx) => {
      vocabularyPrompt = buildTranscriptionVocabularyPrompt(ctx?.keywords ?? []);
      if (vocabularyPrompt) {
        log.debug?.(
          `[groq-transcription] vocabulary prompt set (${(ctx?.keywords ?? []).length} terms, ${vocabularyPrompt.length} chars)`,
        );
      }
    },

    // Stop is a hard signal that whatever has been said should be queued now.
    stop: () => {
      if (chunks.length === 0) return;
      // A deliberate stop bypasses the minimum-length gate for real speech.
      if (sawSpeech) bufferedMs = Math.max(bufferedMs, MIN_UTTERANCE_MS);
      flush();
    },

    close: () => {
      closed = true;
      resetBuffer();
    },

    // Test seam: await every in-flight transcription. Also flushes whatever
    // is still buffered, so a test can assert without racing the timers.
    flushPending: async () => {
      flush();
      await pending;
    },
  };
}

// Wrap raw PCM16 mono samples in a minimal 44-byte RIFF/WAVE header. Groq's
// endpoint needs a real audio container; PCM on its own is rejected.
export function pcm16ToWav(pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2; // mono, 2 bytes per sample
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(1, 22); // channels: mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function meanAmplitude(pcm) {
  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount === 0) return 0;
  let total = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    total += Math.abs(pcm.readInt16LE(i * 2));
  }
  return total / sampleCount;
}

async function safeText(response) {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function withoutTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}
