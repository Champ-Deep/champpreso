import { WebSocket } from "ws";

import { createSessionCostTracker } from "./session-cost.js";
import { createTranscriptTurnQueue } from "./transcript-turn-queue.js";
import { cleanTranscript, explainRejection } from "./transcript-hygiene.js";

const FILLER_WORDS = new Set([
  "uh", "uhh", "uhhh", "um", "umm", "ummm", "ah", "ahh", "er", "erm",
  "hmm", "hm", "huh", "mm", "mhm",
  "yeah", "yep", "yup", "yes", "ok", "okay", "right", "alright",
  "so", "well", "like",
]);

export function isTrivialTranscript(text) {
  if (typeof text !== "string") return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  // Strip common punctuation and lowercase, then split into words.
  const cleaned = trimmed.replace(/[.,!?;:'"()\-]/g, " ").toLowerCase();
  const words = cleaned.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return true;
  // Single word: skip if it's filler or very short (1-2 chars).
  if (words.length === 1) {
    return FILLER_WORDS.has(words[0]) || words[0].length <= 2;
  }
  // 2-3 words and ALL are filler: skip ("you know", "uh well").
  if (words.length <= 3 && words.every((w) => FILLER_WORDS.has(w))) return true;
  return false;
}

// Default backoff between warmup attempts (after attempt N completes, wait
// delays[N-1] ms before the next). Total budget with 8 attempts: ~120s.
const DEFAULT_WARMUP_DELAYS = [2000, 4000, 8000, 16000, 30000, 30000, 30000];
const DEFAULT_WARMUP_MAX_ATTEMPTS = 8;

export function createWhiteboardSession({ options, wss, runAgent }) {
  const state = {
    mode: "staging",
    elements: seedElements(),
    turnIdCounter: 0,
    agentHistory: [],
    agentStatus: "idle",
    agentBusy: false,
    warmupBusy: false,
    latestScreenshot: undefined,
    // Snapshot of the user's free-form "Agent instructions" textarea taken at
    // /api/preso/start. Frozen for the duration of the preso so the cached
    // system-prompt prefix the warmup loop primes stays stable; mid-preso edits
    // to the textarea only take effect on the next Start Preso.
    agentInstructions: "",
    // Snapshot of the Notes and Transcripts pane, set at /api/preso/start.
    // Surfaced inside the primer message; not re-read mid-preso.
    notesAndTranscripts: "",
    // Mid-session question state. When the agent calls ask_user_question, this
    // gets populated; cleared when the user answers via /api/preso/answer.
    pendingQuestion: null,
    queueStats: null,
    // v0.7.0: agent's declared current zone (SKETCHES/STRUCTURED/NOTES). The
    // frontend renders a small floating chip on the canvas showing this.
    activeZone: "structured",
    // Session Mode snapshot. Frozen at startPreso so the cached system prompt
    // prefix stays stable; mid-preso changes only take effect on next preso.
    sessionMode: "strategy",
    // v0.8.0: pinned element IDs. The agent is instructed not to modify or
    // delete these. Mutated by /api/preso/pin and /api/preso/unpin.
    pinnedIds: new Set(),
    // v0.8.0: interrupt signal. When set, the in-flight runAgent loop should
    // abort at the next tool boundary. Cleared after every turn boundary.
    interruptSignal: { aborted: false, reason: null },
    // v0.8.0: loop detection. Track last few tool call signatures; if the
    // same one appears 3 times in a row, abort with a "loop detected" error.
    recentToolSignatures: [],
    // v0.9.0: turn history stack for Undo Last Agent Turn. Each entry is
    // { id, savedAt, elements } - a snapshot taken just before runAgent.
    // Capped at 20 entries to bound memory.
    turnHistory: [],
    warmupPromise: Promise.resolve(),
    // Snapshot of the warmup loop state, also broadcast to clients via WS.
    warmupState: { state: "idle", attempt: 0, maxAttempts: DEFAULT_WARMUP_MAX_ATTEMPTS },
    // True iff the canvas was edited since the last time a screenshot was
    // sent to the agent. We only attach the live screenshot when this is true
    // (saves ~7-10k tokens per turn on DONE-only turns when nothing changed).
    canvasDirtyForAgent: false,
    cost: createSessionCostTracker(),
    // Session token. In-flight operations capture this object at start and
    // check `mySession.active` before mutating shared state. endSession()
    // flips the captured token's active to false and swaps in a new token,
    // so anything still in flight (LLM response, tool execute, queued turn,
    // late delta flush) becomes a no-op for state mutation. Cost tracking
    // does NOT consult this - we record what we paid for regardless.
    session: { id: 0, active: true },
  };

  let warmupCancelled = false;
  let warmupRunning = false;

  function publishAgentStatus() {
    const status = (state.agentBusy || state.warmupBusy) ? "thinking" : "idle";
    if (state.agentStatus === status) return;
    state.agentStatus = status;
    broadcast(wss, { type: "agent:status", status });
  }

  const queue = createTranscriptTurnQueue({
    // No queue-level debounce: turn boundaries are decided upstream by the
    // transcription provider (delta-quiet for OpenAI; per-chunk commits for
    // Moonshine), so by the time queueTranscript fires, the chunk represents
    // a complete utterance and should run immediately.
    debounceMs: 0,
    // A turn is "ready" only when the accumulated buffer has at least one
    // substantive (non-filler) word. Pure fillers ("uh", "uh um") keep
    // accumulating until the speaker says something real, then fire as one
    // combined turn ("uh\num\nOpenAI just released...").
    isReady: (text) => !isTrivialTranscript(text),
    // Surface backlog and pause state to the side panel. The frontend renders
    // an indicator pill showing how many phrases are queued and an estimated
    // catch-up time.
    onStats: (stats) => {
      state.queueStats = stats;
      broadcast(wss, { type: "queue:stats", ...stats });
    },
    runTurn: async (transcript) => {
      if (state.mode !== "live") return;
      // Capture the session at the moment the turn begins. If endSession()
      // fires while we're awaiting warmup or the agent call, mySession.active
      // flips to false and we bail without mutating anything.
      const mySession = state.session;
      // Wait for any in-flight prompt-cache warmup so the cache is primed
      // before we send the first real transcript turn through.
      try { await state.warmupPromise; } catch { /* warmup errors are logged elsewhere */ }
      if (state.mode !== "live") return;
      if (!mySession.active) return;
      state.agentBusy = true;
      publishAgentStatus();
      state.turnIdCounter = (state.turnIdCounter || 0) + 1;
      const turnId = `turn-${state.turnIdCounter}-${Date.now()}`;
      broadcast(wss, { type: "agent:turn-start", turnId, transcript, timestamp: new Date().toISOString() });
      options.onAgentEvent?.({ type: "turn:start", transcript, timestamp: new Date().toISOString() });
      try {
        await runAgent({ transcript, state, wss, options });
        broadcast(wss, { type: "agent:turn-end", turnId, transcript, timestamp: new Date().toISOString() });
        options.onAgentEvent?.({ type: "turn:end", transcript, timestamp: new Date().toISOString() });
      } catch (error) {
        console.error("Whiteboard agent failed:", error);
        broadcast(wss, { type: "error", message: `Whiteboard agent failed: ${error.message}` });
        broadcast(wss, { type: "agent:turn-error", turnId, transcript, error: error.message, timestamp: new Date().toISOString() });
        options.onAgentEvent?.({ type: "turn:error", transcript, error: error.message, timestamp: new Date().toISOString() });
      } finally {
        state.agentBusy = false;
        publishAgentStatus();
      }
    },
  });

  // v0.11.0: apply transcript hygiene before queueing. This filters known
  // Whisper hallucinations ("Thanks for watching", music tags, repeated
  // tokens) and drops very short chunks. Toggle via state.smartSttEnabled.
  // Inspired by Mega-ASR's semantic recovery principle.
  state.smartSttEnabled = true;
  state.smartSttLog = { dropped: 0, lastReason: null, lastDropped: "" };
  state.queueTranscript = (text) => {
    if (!state.smartSttEnabled) return queue.enqueue(text);
    const reason = explainRejection(text);
    if (reason) {
      state.smartSttLog.dropped += 1;
      state.smartSttLog.lastReason = reason;
      state.smartSttLog.lastDropped = String(text).slice(0, 80);
      broadcast(wss, { type: "stt:dropped", reason, text: state.smartSttLog.lastDropped });
      return Promise.resolve();
    }
    const cleaned = cleanTranscript(text);
    if (!cleaned) return Promise.resolve();
    return queue.enqueue(cleaned);
  };
  state.setSmartStt = (enabled) => {
    state.smartSttEnabled = !!enabled;
    broadcast(wss, { type: "stt:smart-mode", enabled: state.smartSttEnabled });
    return state.smartSttEnabled;
  };
  state.idle = () => queue.idle();
  state.endSession = () => {
    state.session.active = false;
    state.session = { id: state.session.id + 1, active: true };
    // Drop any pending/buffered transcript chunks from the old session so
    // they can't bleed into the new one. The session-token check stops
    // in-flight turns from mutating state; this stops queued ones from ever
    // firing in the first place.
    queue.reset();
    state.interruptSignal = { aborted: false, reason: null };
    state.recentToolSignatures = [];
    state.pinnedIds = new Set();
  };
  state.updateLatestScreenshot = (image) => {
    state.latestScreenshot = image;
    // A fresh screenshot means the canvas changed (either the agent just
    // edited or the user drew something pre-listening). Mark dirty so the
    // next agent turn includes it.
    state.canvasDirtyForAgent = true;
  };
  state.reset = () => {
    // endSession() already calls queue.reset() so the pending/buffered piles
    // get cleared too. Any in-flight turn that captured the prior session
    // token will no-op on completion.
    state.endSession();
    state.elements = seedElements();
    state.agentHistory = [];
    state.latestScreenshot = undefined;
    state.canvasDirtyForAgent = false;
    state.cost.reset();
  };
  // Pause/resume the transcript pipeline without ending the preso. When paused,
  // incoming chunks are dropped (NOT buffered) so the user can speak through
  // something without it landing on the whiteboard. Resume to capture again.
  state.pauseCapture = () => {
    queue.setPaused(true);
    broadcast(wss, { type: "capture:paused", paused: true, timestamp: new Date().toISOString() });
    return true;
  };
  state.resumeCapture = () => {
    queue.setPaused(false);
    broadcast(wss, { type: "capture:paused", paused: false, timestamp: new Date().toISOString() });
    return true;
  };
  // Surface a clarifying question raised by the agent's ask_user_question
  // tool. The frontend renders a non-blocking question card; user clicks an
  // option or types a custom answer, which lands at /api/preso/answer.
  state.askUserQuestion = ({ question, options: choices = [] }) => {
    const id = `q-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const safeOptions = Array.isArray(choices)
      ? choices.map((c) => String(c).slice(0, 120)).filter(Boolean).slice(0, 6)
      : [];
    state.pendingQuestion = {
      id,
      question: String(question ?? "").slice(0, 500),
      options: safeOptions,
      askedAt: new Date().toISOString(),
    };
    broadcast(wss, { type: "agent:question", ...state.pendingQuestion });
    return state.pendingQuestion;
  };
  state.answerQuestion = ({ id, text }) => {
    if (!state.pendingQuestion) return { ok: false, reason: "no-pending-question" };
    if (id && id !== state.pendingQuestion.id) {
      return { ok: false, reason: "stale-question" };
    }
    const answer = String(text ?? "").trim().slice(0, 500);
    if (!answer) return { ok: false, reason: "empty-answer" };
    const q = state.pendingQuestion;
    state.agentHistory.push({
      role: "user",
      content: `ANSWER TO YOUR QUESTION (asked at ${q.askedAt}):\nQ: ${q.question}\nA: ${answer}\n\nContinue normally with this answer in mind.`,
    });
    state.pendingQuestion = null;
    broadcast(wss, { type: "agent:question-resolved", id: q.id, answer });
    return { ok: true };
  };
  // Apply a one-line steer from the user without restarting the preso. The
  // nudge is appended to agentHistory as a system message so the very next
  // turn sees it as authoritative direction. Idempotent: caller is responsible
  // for not spamming duplicates.
  // v0.9.0: Snapshot the current canvas before a turn starts. Push onto the
  // turnHistory stack so Undo can revert what the agent just drew without
  // affecting user edits made afterward.
  state.snapshotForUndo = () => {
    const snap = {
      id: `t-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      savedAt: Date.now(),
      elements: JSON.parse(JSON.stringify(state.elements ?? [])),
    };
    state.turnHistory.push(snap);
    if (state.turnHistory.length > 20) state.turnHistory.shift();
    return snap.id;
  };
  state.undoLastAgentTurn = () => {
    if (state.turnHistory.length === 0) {
      return { ok: false, reason: "no-history" };
    }
    const snap = state.turnHistory.pop();
    state.elements = snap.elements;
    state.canvasDirtyForAgent = true;
    broadcast(wss, { type: "whiteboard:update", elements: state.elements });
    broadcast(wss, { type: "agent:undone", id: snap.id, timestamp: new Date().toISOString() });
    return { ok: true, id: snap.id, remaining: state.turnHistory.length };
  };
  // v0.8.0: pin / unpin canvas elements. The agent's system prompt receives
  // a "PINNED IDS" list every turn and is instructed not to modify or delete
  // these shapes. Useful for "this part is right, please don't trash it".
  state.pinElement = (id) => {
    if (!id || typeof id !== "string") return false;
    state.pinnedIds.add(id);
    broadcast(wss, { type: "pin:changed", id, pinned: true, all: Array.from(state.pinnedIds) });
    return true;
  };
  state.unpinElement = (id) => {
    if (!id || typeof id !== "string") return false;
    const had = state.pinnedIds.delete(id);
    if (had) broadcast(wss, { type: "pin:changed", id, pinned: false, all: Array.from(state.pinnedIds) });
    return had;
  };
  state.clearPins = () => {
    if (state.pinnedIds.size === 0) return false;
    state.pinnedIds.clear();
    broadcast(wss, { type: "pin:changed", id: null, pinned: false, all: [] });
    return true;
  };
  // v0.8.0: interrupt the in-flight agent turn. Tool execute functions check
  // state.interruptSignal.aborted and bail with STALE_SESSION_TOOL_RESULT.
  state.interruptCurrentTurn = (reason = "user-interrupt") => {
    state.interruptSignal = { aborted: true, reason };
    broadcast(wss, { type: "agent:interrupted", reason, timestamp: new Date().toISOString() });
    return true;
  };
  state.clearInterruptSignal = () => {
    state.interruptSignal = { aborted: false, reason: null };
  };
  // v0.8.0: loop detection. Returns true if this tool call has been seen 3
  // times in a row, indicating the agent is stuck. Caller should abort.
  state.checkToolCallLoop = (signature) => {
    if (!signature) return false;
    state.recentToolSignatures.push(signature);
    if (state.recentToolSignatures.length > 6) state.recentToolSignatures.shift();
    const last3 = state.recentToolSignatures.slice(-3);
    return last3.length === 3 && last3.every((s) => s === signature);
  };
  state.resetToolCallHistory = () => {
    state.recentToolSignatures = [];
  };
  // v0.7.0: agent declares its current canvas zone. Frontend shows it as a
  // small floating chip on the canvas. Helps the user understand what region
  // of the canvas the agent considers active for the current topic.
  state.declareZone = (zone) => {
    const allowed = new Set(["sketches", "structured", "notes"]);
    const next = allowed.has(zone) ? zone : "structured";
    state.activeZone = next;
    broadcast(wss, { type: "agent:zone", zone: next, timestamp: new Date().toISOString() });
    return next;
  };
  // Render a Mermaid diagram. The actual parsing + Excalidraw element creation
  // happens client-side (Mermaid runs in the browser via mermaid-to-excalidraw),
  // so this just broadcasts the request. The frontend handles the rest, then
  // syncs the new elements back via the normal whiteboard:user-elements path.
  state.renderMermaid = ({ syntax, anchor, scale = 1 }) => {
    const id = `m-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const safeSyntax = String(syntax ?? "").slice(0, 8000);
    const safeAnchor = anchor && typeof anchor === "object" ? anchor : { x: 200, y: 200 };
    broadcast(wss, {
      type: "mermaid:render",
      id,
      syntax: safeSyntax,
      anchor: { x: Number(safeAnchor.x) || 0, y: Number(safeAnchor.y) || 0 },
      scale: Math.max(0.4, Math.min(3, Number(scale) || 1)),
    });
    return id;
  };
  state.applyNudge = (text) => {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return false;
    state.agentHistory.push({
      role: "system",
      content: `STEER FROM USER: ${trimmed}\n\nApply this directive on the very next turn. It overrides previous behaviour when in conflict. Do not echo this directive to the canvas as a visual note; it is guidance, not content.`,
    });
    broadcast(wss, { type: "nudge:applied", text: trimmed, timestamp: new Date().toISOString() });
    return true;
  };
  state.startPreso = ({ primerMessage, agentInstructions = "", notesAndTranscripts = "" }) => {
    state.endSession();
    state.mode = "live";
    state.elements = seedElements();
    state.latestScreenshot = undefined;
    state.agentHistory = [primerMessage];
    state.agentInstructions = typeof agentInstructions === "string" ? agentInstructions : "";
    state.notesAndTranscripts = typeof notesAndTranscripts === "string" ? notesAndTranscripts : "";
    state.warmupPromise = Promise.resolve();
    state.canvasDirtyForAgent = false;
    state.cost.reset();
    // Reset warmup state for this preso. The startWarmupLoop call that follows
    // will publish the first "running" broadcast.
    state.warmupState = { state: "idle", attempt: 0, maxAttempts: DEFAULT_WARMUP_MAX_ATTEMPTS };
  };
  function publishWarmupState(next) {
    state.warmupState = { ...state.warmupState, ...next };
    broadcast(wss, { type: "warmup", ...state.warmupState });
  }

  state.startWarmupLoop = ({
    runOnce,
    delays = DEFAULT_WARMUP_DELAYS,
    maxAttempts = DEFAULT_WARMUP_MAX_ATTEMPTS,
    primingMessages = null,
  }) => {
    // Ignore overlapping calls. The previous loop must finish (or be cancelled)
    // before a new one starts, otherwise multiple loops would race for cache
    // confirmation on the same session.
    if (warmupRunning) return state.warmupPromise;

    warmupRunning = true;
    warmupCancelled = false;
    state.warmupBusy = true;
    publishAgentStatus();

    const promise = (async () => {
      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          if (warmupCancelled) {
            publishWarmupState({ state: "cancelled", attempt: attempt - 1, maxAttempts });
            return;
          }
          publishWarmupState({ state: "running", attempt, maxAttempts });
          let cached = 0;
          let input = 0;
          try {
            const result = await runOnce({ attempt, maxAttempts });
            cached = Number(result?.usage?.cached) || 0;
            input = Number(result?.usage?.input) || 0;
          } catch (error) {
            // Swallow per-attempt errors; loop should still progress to the
            // next attempt. The actual error is logged by the caller.
            cached = 0;
            input = 0;
          }
          if (warmupCancelled) {
            publishWarmupState({ state: "cancelled", attempt, maxAttempts });
            return;
          }
          // Require >=50% of the prefix to be cached. A small `cached` value
          // (e.g., the static system+tools chunk only) doesn't mean the primer
          // and warmup_user prefix are primed, so keep retrying.
          if (input > 0 && cached >= input * 0.5) {
            publishWarmupState({ state: "confirmed", attempt, maxAttempts });
            return;
          }
          if (attempt >= maxAttempts) {
            publishWarmupState({ state: "exhausted", attempt, maxAttempts });
            return;
          }
          // Wait before the next attempt, but bail early if cancelled mid-sleep.
          const delay = delays[attempt - 1] ?? delays.at(-1) ?? 0;
          await sleepCancellable(delay, () => warmupCancelled);
        }
      } finally {
        // Append the priming pair AFTER all warmup attempts finish (regardless
        // of confirmed/exhausted/cancelled). This makes every subsequent turn's
        // request prefix start with the EXACT bytes warmup just wrote to cache:
        //   warmup wrote: [primer, warmup_user_msg]
        //   turn sends:   [primer, warmup_user_msg, assistant("UNDERSTOOD"), transcript, currentBoard]
        // Without this, turn 1 diverges from warmup at messages[1] and never
        // hits the cache that warmup just primed.
        if (Array.isArray(primingMessages) && primingMessages.length > 0) {
          state.agentHistory = [...state.agentHistory, ...primingMessages];
        }
        warmupRunning = false;
        state.warmupBusy = false;
        publishAgentStatus();
      }
    })();

    state.warmupPromise = promise;
    return promise;
  };

  state.cancelWarmup = () => {
    if (!warmupRunning) return;
    warmupCancelled = true;
  };

  state.backToStaging = () => {
    state.endSession();
    state.mode = "staging";
    state.cancelWarmup();
  };
  return state;
}

function sleepCancellable(ms, isCancelled) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (isCancelled() || Date.now() - start >= ms) return resolve();
      setTimeout(tick, Math.min(50, ms));
    };
    tick();
  });
}

export function broadcast(wss, message) {
  const serialized = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(serialized);
    }
  }
}

function seedElements() {
  // Live canvas starts blank. The user may draw on it before clicking Start
  // listening; those edits are pushed to the server via whiteboard:user-elements
  // and will be in state.elements by the first transcript turn.
  return [];
}
