export function createTranscriptTurnQueue({ runTurn, debounceMs = 150, isReady = (_text) => true, onStats = null }) {
  let running = false;
  let buffered = [];
  let current = Promise.resolve();
  // Pending bucket holds chunks that arrived too recently to fire yet. Waiting
  // a short window lets bursts of small transcript chunks coalesce into one
  // turn. The isReady predicate gates whether the accumulated buffer has
  // enough substantive content to actually fire - if not, we keep accumulating
  // until the next chunk arrives.
  let pending = [];
  let debounceTimer = null;
  // When true, enqueue() drops chunks silently. Used by the side-panel
  // Pause Capture button so the user can speak through something without it
  // landing on the whiteboard. Resume to start capturing again.
  let paused = false;
  // Rolling average of recent turn durations. Powers the "rough time to catch
  // up" estimate the side panel renders. Seeded with a 6s prior; the EWMA
  // alpha biases toward recent measurements.
  let avgTurnMs = 6000;
  const TURN_EWMA_ALPHA = 0.4;
  // Timestamp the oldest chunk in pending landed at. Used to surface "agent
  // is N seconds behind the speaker" in the UI.
  let oldestPendingAt = null;
  let oldestBufferedAt = null;
  let lastTurnFinishedAt = null;
  function emitStats() {
    if (typeof onStats !== "function") return;
    const now = Date.now();
    const oldest = oldestPendingAt ?? oldestBufferedAt ?? null;
    const ageMs = oldest ? now - oldest : 0;
    const totalBacklog = pending.length + buffered.length;
    const estimatedCatchupMs = Math.round(
      (running ? avgTurnMs : 0) + totalBacklog * avgTurnMs,
    );
    onStats({
      pending: pending.length,
      buffered: buffered.length,
      running,
      paused,
      avgTurnMs: Math.round(avgTurnMs),
      ageMs,
      estimatedCatchupMs,
      lastTurnFinishedAt,
    });
  }

  function flushPending({ force = false } = {}) {
    debounceTimer = null;
    if (pending.length === 0) return;
    const text = pending.join("\n");
    if (!force && !isReady(text)) {
      // Not enough content yet - keep pending, wait for more chunks. The next
      // enqueue will restart the debounce timer and we'll re-check then.
      return;
    }
    pending = [];
    oldestPendingAt = null;
    if (running) {
      buffered.push(text);
      if (!oldestBufferedAt) oldestBufferedAt = Date.now();
    } else {
      current = drain(text);
    }
    emitStats();
  }

  async function drain(text) {
    running = true;
    const startedAt = Date.now();
    emitStats();
    try {
      await runTurn(text);
    } finally {
      const elapsed = Date.now() - startedAt;
      // EWMA: smooths jitter while still adapting to model speed changes.
      avgTurnMs = TURN_EWMA_ALPHA * elapsed + (1 - TURN_EWMA_ALPHA) * avgTurnMs;
      lastTurnFinishedAt = Date.now();
      if (buffered.length > 0) {
        const next = buffered.join("\n");
        buffered = [];
        oldestBufferedAt = null;
        current = drain(next);
      } else {
        running = false;
        // If pending arrived during the turn and is now ready, flush it. If
        // it's still not ready (only fillers), leave it accumulating.
        if (pending.length > 0) {
          if (debounceTimer) clearTimeout(debounceTimer);
          flushPending();
        }
      }
      emitStats();
    }
  }

  function enqueue(text) {
    const trimmed = text.trim();
    if (!trimmed) return current;
    // While paused, silently drop incoming chunks. The user explicitly asked
    // for this so we do NOT buffer for later - paused means "ignore my speech".
    if (paused) {
      emitStats();
      return current;
    }
    pending.push(trimmed);
    if (!oldestPendingAt) oldestPendingAt = Date.now();
    if (debounceMs > 0) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushPending, debounceMs);
    } else {
      flushPending();
    }
    emitStats();
    return current;
  }

  async function idle() {
    // Force-flush any pending content (bypassing isReady) so idle() always
    // terminates - tests and shutdown paths shouldn't hang on a buffer that
    // happens to contain only fillers.
    while (debounceTimer || running || buffered.length > 0 || pending.length > 0) {
      if (debounceTimer || pending.length > 0) {
        if (debounceTimer) clearTimeout(debounceTimer);
        flushPending({ force: true });
      }
      await current;
    }
  }

  // Drop any chunks still in the pending or buffered piles. Call this from
  // state.reset() / state.endSession() so transcripts captured under the old
  // session can never bleed into the new one. Anything currently running is
  // NOT cancelled here; the caller is responsible for flipping the session
  // token so the in-flight turn no-ops on completion.
  function reset() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    pending = [];
    buffered = [];
    paused = false;
    oldestPendingAt = null;
    oldestBufferedAt = null;
    emitStats();
  }

  function setPaused(value) {
    const next = Boolean(value);
    if (next === paused) return paused;
    paused = next;
    emitStats();
    return paused;
  }

  function getStats() {
    return {
      pending: pending.length,
      buffered: buffered.length,
      running,
      paused,
      avgTurnMs: Math.round(avgTurnMs),
    };
  }

  return { enqueue, idle, reset, setPaused, getStats };
}
