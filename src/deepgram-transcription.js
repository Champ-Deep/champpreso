// Deepgram Nova-3 streaming transcription provider.
//
// The "reliable, really good voice API online" leg of the audio plan
// (docs/superpowers/specs/2026-09-01-gate-narrate-prune-design.md): sub-300ms
// time-to-final, interim results so live captions appear WHILE you speak,
// keyterm prompting fed from the user glossary, and server-side endpointing -
// Deepgram decides utterance boundaries, so none of our RMS heuristics run.
//
// Implements the same factory contract as the other providers (see
// createTranscriptionManager in server.js):
//   factory({ sendTranscript, queueTranscript, options, env })
//     -> { ready(), sendAudio(base64Pcm16), stop(), close(), setSessionContext() }

import { WebSocket as NodeWebSocket } from "ws";

const DEFAULT_MODEL = "nova-3";
const DEEPGRAM_LISTEN_URL = "wss://api.deepgram.com/v1/listen";
// The browser captures at 24 kHz mono PCM16 (see public/mic-capture.js).
const SAMPLE_RATE = 24000;
// Deepgram closes idle streams after ~10s of silence unless it hears a
// KeepAlive. 8s leaves margin without chattering.
const DEFAULT_KEEPALIVE_MS = 8000;
// Silence (ms) after speech before Deepgram finalizes the utterance. Matches
// the 600ms hangover the Groq provider uses, so turn pacing feels the same.
const ENDPOINTING_MS = 600;
// Nova-3 accepts up to ~100 keyterms; keep a margin and stable ordering.
const MAX_KEYTERMS = 50;

/**
 * @param {{
 *   sendTranscript: (message: { type: string, text: string }) => void,
 *   queueTranscript: (transcript: string) => Promise<unknown> | void,
 *   options?: any,
 *   env?: Record<string, string | undefined>,
 * }} deps
 */
export function createDeepgramTranscription({ sendTranscript, queueTranscript, options = {}, env = process.env }) {
  const WsClass = options.deepgramWs ?? NodeWebSocket;
  const model = options.deepgramModel || DEFAULT_MODEL;
  const keepAliveMs = options.deepgramKeepAliveMs ?? DEFAULT_KEEPALIVE_MS;
  const log = options.log ?? console;
  const apiKey = env?.DEEPGRAM_API_KEY ?? "";

  let ws = null;
  let readyPromise = null;
  let closed = false;
  let keepAliveTimer = null;
  let keywords = [];
  // is_final segments accumulate here until speech_final closes the utterance.
  let utteranceParts = [];

  function buildUrl() {
    const params = new URLSearchParams({
      model,
      encoding: "linear16",
      sample_rate: String(SAMPLE_RATE),
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
      endpointing: String(ENDPOINTING_MS),
    });
    let url = `${DEEPGRAM_LISTEN_URL}?${params.toString()}`;
    // keyterm is a repeated parameter, one per term (Nova-3 keyterm prompting).
    for (const term of keywords.slice(0, MAX_KEYTERMS)) {
      url += `&keyterm=${encodeURIComponent(term)}`;
    }
    return url;
  }

  function startKeepAlive(socket) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => {
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: "KeepAlive" }));
    }, keepAliveMs);
  }

  function handleMessage(socket, data) {
    if (socket !== ws) return; // stale socket after a reconnect
    let payload;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (payload?.type !== "Results") return;
    const text = String(payload?.channel?.alternatives?.[0]?.transcript ?? "").trim();
    if (payload.is_final) {
      if (text) utteranceParts.push(text);
      if (payload.speech_final && utteranceParts.length > 0) {
        const utterance = utteranceParts.join(" ").trim();
        utteranceParts = [];
        if (utterance) {
          sendTranscript({ type: "transcript:committed", text: utterance });
          queueTranscript(utterance);
        }
      }
      return;
    }
    // Interim: live caption only. Never fires a turn.
    if (text) sendTranscript({ type: "transcript:partial", text });
  }

  function connect() {
    if (!apiKey) {
      readyPromise = Promise.reject(new Error("Deepgram API key missing. Add it in Settings (or DEEPGRAM_API_KEY)."));
      readyPromise.catch(() => {}); // avoid unhandled rejection until ready() is awaited
      return;
    }
    const socket = new WsClass(buildUrl(), { headers: { Authorization: `Token ${apiKey}` } });
    ws = socket;
    utteranceParts = [];
    readyPromise = new Promise((resolve, reject) => {
      socket.on("open", () => {
        startKeepAlive(socket);
        resolve(undefined);
      });
      socket.on("error", (error) => {
        log.warn?.(`[deepgram-transcription] socket error: ${error?.message ?? error}`);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    readyPromise.catch(() => {});
    socket.on("message", (data) => handleMessage(socket, data));
    socket.on("close", () => {
      if (socket === ws) clearInterval(keepAliveTimer);
    });
  }

  connect();

  return {
    ready: () => readyPromise ?? Promise.reject(new Error("Deepgram connection not started")),

    /** @param {string} base64Pcm16 */
    sendAudio(base64Pcm16) {
      if (!ws || ws.readyState !== 1) return; // dropped while (re)connecting
      try {
        ws.send(Buffer.from(base64Pcm16, "base64"));
      } catch (error) {
        log.warn?.(`[deepgram-transcription] sendAudio failed: ${error.message}`);
      }
    },

    // Flush: Deepgram owns endpointing; closing the stream finalizes whatever
    // is pending server-side, but stop() here is a soft no-op like OpenAI's.
    stop() {},

    close() {
      closed = true;
      clearInterval(keepAliveTimer);
      const socket = ws;
      ws = null;
      try {
        if (socket && socket.readyState === 1) socket.send(JSON.stringify({ type: "CloseStream" }));
        socket?.close?.();
      } catch { /* best effort */ }
    },

    /**
     * Keyterms live in the connection URL, so a vocabulary change rebuilds the
     * socket. Frames arriving during the swap are dropped (~100-300ms); the
     * vocabulary is set at session boundaries, not mid-utterance.
     * @param {{ keywords?: string[] | null }} [ctx]
     */
    setSessionContext(ctx) {
      const next = Array.isArray(ctx?.keywords) ? ctx.keywords.filter((k) => typeof k === "string" && k.trim()) : [];
      if (JSON.stringify(next) === JSON.stringify(keywords)) return;
      keywords = next;
      if (closed) return;
      const old = ws;
      try {
        old?.close?.();
      } catch { /* best effort */ }
      connect();
      log.debug?.(`[deepgram-transcription] reconnected with ${keywords.length} keyterm(s)`);
    },
  };
}
