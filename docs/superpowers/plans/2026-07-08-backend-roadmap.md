# ChampPreso Backend Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the four remaining items from `docs/design-handoff/04-BACKEND-ROADMAP.md`: an always-warm agent (boot + re-warm on change), reliable steering (nudge + scoped-edit bug fixes), the lifecycle/mode-soup collapse (dead `sessionMode` removed, `multiSpeaker` added, `preso/*` endpoints renamed to `session/*` with compat aliases, WS `mode` values renamed), and a one-shot seed-ingestion endpoint.

**Architecture:** All work lands in `src/server.js` (route handlers, warmup wiring, system-prompt composition) and `src/whiteboard-session.js` (session state machine), following the existing patterns already in those files — this is incremental extension, not a rewrite. Every task is TDD: a failing test first, against the existing `node:test` + hand-rolled-mock conventions already used throughout `test/*.test.js`.

**Tech Stack:** Node.js (`node:test`, `node:assert/strict`), Express, `ai` SDK v6 (`generateText`/`streamText`), `ws`.

## Global Constraints

- Use Node's built-in test runner; no test framework dependency. Mocks are hand-rolled (see `test/scoped-edit.test.js` for the canonical `startTestServer` pattern).
- Per `AGENTS.md`: TDD for every fix/feature — write the failing test before the implementation.
- Do not touch the fixed-history prompt-cache pattern (`[primer, ...WARMUP_PRIMING_MESSAGES]`) or the per-preso `agentInstructions` snapshot semantics — only change *when* warmup fires, never *how* the cache priming works.
- Do not restructure `public/app.js` or any other frontend file — this plan is backend-only. The frontend redesign is a separate, parallel effort per `docs/design-handoff/02-FRONTEND-HANDOFF.md`.
- Keep `npm run typecheck` and `npm test` green after every task (run both before each commit).
- Commit after every task, following the existing commit style (`feat: ...` / `fix: ...`, one logical change per commit).

---

## Note: roadmap item 1.3 ("capture from click one") is already shipped

Commit `a414f57` ("perf: cap first-turn warmup wait and record per-turn latency", already on `main`) caps how long the first real transcript turn waits on warmup (`DEFAULT_FIRST_TURN_WARMUP_CAP_MS = 2500`, `src/whiteboard-session.js:41`) and proceeds anyway if warmup is still running, and the transcript-turn-queue's existing `pending`/`buffered` concatenation (`src/transcript-turn-queue.js:47-115`) already replays any speech that arrived while a turn was in flight into the next turn — together these already satisfy "mic capture and transcription begin the instant Start is clicked; if the primer swap is in flight, buffer transcripts and replay them into the first turn, zero speech lost." Tasks 1-2 below only need to cover the two genuinely-missing pieces: warm-on-boot and re-warm-on-change.

## Task 1: Warm the agent on server boot

**Files:**
- Modify: `src/server.js:77-437` (`startServer`), `src/server.js:859-864` (near `WARMUP_PRIMING_MESSAGES`)
- Modify: `src/cli.js:53-57` (the `startServer` call site)
- Test: `test/boot-warmup.test.js` (new)

**Interfaces:**
- Consumes: `state.startWarmupLoop`, `runWhiteboardWarmupOnce`, `WARMUP_PRIMING_MESSAGES` (all already exist, unchanged signatures).
- Produces: `startServer` accepts a new option `alwaysWarm` (boolean, default `false`). When `true`, boot triggers a background warmup immediately after the HTTP server starts listening. This same `alwaysWarm` flag also gates Task 2's re-warm-on-change behavior — both are the "always-warm agent" feature.

Today `runWhiteboardWarmupOnce` refuses to run until `state.agentHistory` is non-empty (`src/server.js:867`), and the only place that ever populates `agentHistory` is `state.startPreso` inside the `POST /api/preso/start` handler — so warmup currently cannot start until the user clicks "Start listening". This task seeds `agentHistory` with a neutral boot primer immediately on boot and kicks off the existing warmup loop against it, so the `[system, tools]` prefix (the expensive, static part of every request) is already cached by the time a real session starts.

`alwaysWarm` defaults to `false` (not `true`) specifically so the ~15 existing test files that call `startServer(...)` without expecting any background agent call keep working unmodified — only `src/cli.js` (the real product entry point) opts in.

- [ ] **Step 1: Write the failing test**

Create `test/boot-warmup.test.js`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { startServer } from "../src/server.js";

function makeTranscriptionMock() {
  const factory = () => ({
    ready: async () => {},
    sendAudio: () => {},
    stop: () => {},
    setSessionContext: () => {},
    close: () => {},
  });
  return { factory };
}

test("alwaysWarm: true fires a warmup turn immediately on boot, before any preso starts", async () => {
  const transcription = makeTranscriptionMock();
  let calls = 0;
  const { httpServer } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: transcription.factory,
    alwaysWarm: true,
    generateTextFn: async () => {
      calls += 1;
      return { text: "UNDERSTOOD", finishReason: "stop", usage: { inputTokens: 1000, outputTokens: 5, cachedInputTokens: 0 } };
    },
    streamTextFn: () => ({ consumeStream: async () => {} }),
    warmupMaxAttempts: 1,
    warmupDelays: [],
  });
  try {
    // Boot warmup runs in the background; give it a tick to fire.
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(calls >= 1, "expected a warmup call to fire on boot without /api/preso/start");
  } finally {
    httpServer.close();
  }
});

test("alwaysWarm omitted (default false) does not fire a warmup turn on boot", async () => {
  const transcription = makeTranscriptionMock();
  let calls = 0;
  const { httpServer } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: transcription.factory,
    generateTextFn: async () => {
      calls += 1;
      return { text: "UNDERSTOOD", finishReason: "stop" };
    },
    streamTextFn: () => ({ consumeStream: async () => {} }),
    warmupMaxAttempts: 1,
    warmupDelays: [],
  });
  try {
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 0, "no warmup call should fire without alwaysWarm: true");
  } finally {
    httpServer.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/boot-warmup.test.js`
Expected: FAIL — first test fails with `calls >= 1` false (no boot warmup exists yet); second test already passes trivially (it's asserting current behavior).

- [ ] **Step 3: Add `BOOT_WARMUP_MESSAGE` and wire boot warmup into `startServer`**

In `src/server.js`, near the existing warmup message constants (currently at line 859-864), add:

```js
export const BOOT_WARMUP_MESSAGE = {
  role: "user",
  content: "Speaker turn:\n(boot warmup - server just started, no session yet; confirm readiness by responding UNDERSTOOD without calling tools)",
};
```

In `startServer`, immediately before the final `return { app, httpServer, state, url }` (currently line 431), add:

```js
  const alwaysWarm = options.alwaysWarm ?? false;
  if (alwaysWarm) {
    state.agentHistory = [BOOT_WARMUP_MESSAGE];
    state.startWarmupLoop({
      runOnce: ({ attempt }) =>
        runWhiteboardWarmupOnce({
          state,
          options,
          wss,
          attempt,
          generateTextFn: options.generateTextFn ?? generateText,
          streamTextFn: options.streamTextFn ?? streamText,
        }).catch((error) => {
          console.error(`Boot warmup attempt ${attempt} failed:`, error);
          options.onAgentEvent?.({ type: "warmup:error", attempt, error: error.message, timestamp: new Date().toISOString() });
          return { usage: { input: 0, cached: 0, output: 0, reasoning: 0 } };
        }),
      delays: options.warmupDelays,
      maxAttempts: options.warmupMaxAttempts,
      primingMessages: WARMUP_PRIMING_MESSAGES,
    });
  }
```

- [ ] **Step 4: Wire the CLI to opt in**

In `src/cli.js`, change the `startServer` call (currently lines 53-57):

```js
  const { url } = await startServer({
    ...options,
    settingsStore,
    onStatus: (message) => console.log(message),
    alwaysWarm: true,
  });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/boot-warmup.test.js`
Expected: PASS (both tests)

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: all existing tests still pass (they never pass `alwaysWarm`, so boot warmup never fires for them) plus the 2 new tests, and `npm run typecheck` is clean.

- [ ] **Step 7: Commit**

```bash
git add src/server.js src/cli.js test/boot-warmup.test.js
git commit -m "feat: warm the whiteboard agent on server boot

App open now primes the [system, tools] prompt-cache prefix in the
background from the moment the process starts, gated behind a new
alwaysWarm option (default off, on for the real CLI) so existing
tests keep their current no-network-call behavior unmodified."
```

---

## Task 2: Re-warm silently when session intent changes pre-session

**Files:**
- Modify: `src/server.js:338-350` (`PUT /api/settings`), `src/server.js:414-424` (WS `settings:update`)
- Test: `test/boot-warmup.test.js` (extend)

**Interfaces:**
- Consumes: `BOOT_WARMUP_MESSAGE`, `state.startWarmupLoop`, `alwaysWarm` (Task 1).
- Produces: a `scheduleReWarm(agentInstructions)` closure inside `startServer`, debounced by `options.reWarmDebounceMs` (default `1500`), called from both settings-change entry points whenever `state.mode !== "live"`.

The system prompt actually sent to the model is `base + "\n\nUser instructions:\n" + agentInstructions + "\n\n" + primerText` (`buildEffectiveSystemPrompt`, `src/server.js:1176-1186` — instructions come *before* primer text). That means editing the session-intent textarea in Setup invalidates the cached prefix for everything after `base`. Re-priming with the new instructions text (against the neutral boot primer, since staging content isn't known yet) re-establishes a `base + instructions` cache hit, so only the primer-text tail differs once the user actually clicks Start — a much smaller cache miss than today's full cold start.

- [ ] **Step 1: Write the failing test**

Append to `test/boot-warmup.test.js`:

```js
test("alwaysWarm: true re-warms (debounced) when agentInstructions changes via PUT /api/settings, before Start listening", async () => {
  const transcription = makeTranscriptionMock();
  const seenInstructions = [];
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: transcription.factory,
    alwaysWarm: true,
    reWarmDebounceMs: 10,
    settingsStore: {
      load: async () => ({ agentInstructions: "Get to a concrete Q3 plan" }),
      save: async () => {},
      getSanitized: async () => ({}),
    },
    generateTextFn: async () => {
      seenInstructions.push("called");
      return { text: "UNDERSTOOD", finishReason: "stop" };
    },
    streamTextFn: () => ({ consumeStream: async () => {} }),
    warmupMaxAttempts: 1,
    warmupDelays: [],
  });
  try {
    await new Promise((r) => setTimeout(r, 20)); // let boot warmup finish
    const callsBeforeChange = seenInstructions.length;

    const res = await fetch(`${url}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentInstructions: "Map every objection in this call" }),
    });
    assert.equal(res.status, 200);

    await new Promise((r) => setTimeout(r, 40)); // past the 10ms debounce
    assert.ok(seenInstructions.length > callsBeforeChange, "settings change should trigger a re-warm call");
  } finally {
    httpServer.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/boot-warmup.test.js`
Expected: FAIL — the third test's `seenInstructions.length > callsBeforeChange` assertion fails (no re-warm exists yet).

- [ ] **Step 3: Implement `scheduleReWarm` and call it from both settings entry points**

In `src/server.js`, inside `startServer`, right after the `alwaysWarm` block from Task 1, add:

```js
  const reWarmDebounceMs = options.reWarmDebounceMs ?? 1500;
  let reWarmTimer = null;
  function scheduleReWarm(agentInstructions) {
    if (!alwaysWarm) return;
    if (state.mode === "live") return; // a live session already has its own warmup lifecycle
    if (reWarmTimer) clearTimeout(reWarmTimer);
    reWarmTimer = setTimeout(() => {
      reWarmTimer = null;
      state.agentInstructions = typeof agentInstructions === "string" ? agentInstructions : "";
      state.agentHistory = [BOOT_WARMUP_MESSAGE];
      state.startWarmupLoop({
        runOnce: ({ attempt }) =>
          runWhiteboardWarmupOnce({
            state,
            options,
            wss,
            attempt,
            generateTextFn: options.generateTextFn ?? generateText,
            streamTextFn: options.streamTextFn ?? streamText,
          }).catch((error) => {
            console.error(`Re-warm attempt ${attempt} failed:`, error);
            return { usage: { input: 0, cached: 0, output: 0, reasoning: 0 } };
          }),
        delays: options.warmupDelays,
        maxAttempts: options.warmupMaxAttempts,
        primingMessages: WARMUP_PRIMING_MESSAGES,
      });
    }, reWarmDebounceMs);
  }
```

Then replace the boot-warmup block from Task 1 to call through the same helper for consistency:

```js
  if (alwaysWarm) {
    state.agentHistory = [BOOT_WARMUP_MESSAGE];
    state.startWarmupLoop({
      runOnce: ({ attempt }) =>
        runWhiteboardWarmupOnce({ state, options, wss, attempt,
          generateTextFn: options.generateTextFn ?? generateText,
          streamTextFn: options.streamTextFn ?? streamText,
        }).catch((error) => {
          console.error(`Boot warmup attempt ${attempt} failed:`, error);
          options.onAgentEvent?.({ type: "warmup:error", attempt, error: error.message, timestamp: new Date().toISOString() });
          return { usage: { input: 0, cached: 0, output: 0, reasoning: 0 } };
        }),
      delays: options.warmupDelays,
      maxAttempts: options.warmupMaxAttempts,
      primingMessages: WARMUP_PRIMING_MESSAGES,
    });
  }
```

(Boot warmup stays as its own immediate call — no debounce needed there since nothing preceded it. `scheduleReWarm` is the debounced path used only for post-boot changes.)

Now wire the two call sites. In `PUT /api/settings` (currently lines 338-350):

```js
  app.put("/api/settings", async (req, res) => {
    if (!options.settingsStore) return res.status(404).json({ error: "Settings store not available." });
    try {
      await options.settingsStore.save(req.body ?? {});
      await transcription.applyCurrent();
      const sanitized = await options.settingsStore.getSanitized();
      res.json({ settings: sanitized, transcriptionEngine: transcription.getLabel() });
      broadcast(wss, { type: "settings", settings: sanitized });
      broadcast(wss, { type: "config", transcriptionEngine: transcription.getLabel() });
      scheduleReWarm(sanitized.agentInstructions);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
```

In the WS `settings:update` handler (currently lines 414-424):

```js
      if (message.type === "settings:update" && options.settingsStore) {
        try {
          await options.settingsStore.save(message.patch ?? {});
          await transcription.applyCurrent();
          const sanitized = await options.settingsStore.getSanitized();
          broadcast(wss, { type: "settings", settings: sanitized });
          broadcast(wss, { type: "config", transcriptionEngine: transcription.getLabel() });
          scheduleReWarm(sanitized.agentInstructions);
        } catch (error) {
          client.send(JSON.stringify({ type: "error", message: `Failed to apply settings: ${error.message}` }));
        }
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/boot-warmup.test.js`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all green. (No other test passes `alwaysWarm: true`, so `scheduleReWarm` is a no-op everywhere else.)

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/boot-warmup.test.js
git commit -m "feat: silently re-warm the agent when session intent changes pre-session

Editing the Setup session-intent field now re-primes the prompt cache
in the background (debounced 1.5s) so the base+instructions prefix is
already hot by the time the user clicks Start listening, instead of
only being primed for whatever instructions existed at boot."
```

---

## Task 3: Fix nudge steering — stop injecting non-leading `role: system` messages

**Files:**
- Modify: `src/whiteboard-session.js:384-393` (`state.applyNudge`)
- Test: `test/nudge.test.js` (new)

**Interfaces:**
- Consumes: `state.agentHistory` (array), `broadcast`.
- Produces: `state.applyNudge(text)` unchanged signature/return (`boolean`), but the message it pushes onto `agentHistory` now has `role: "user"` instead of `role: "system"`.

Empirically confirmed (`node_modules/ai/dist/index.js:2189-2199`): the `ai` SDK v6 validates every `generateText`/`streamText` call and treats any `role: "system"` entry appearing inside `messages` (as opposed to the dedicated `system` option) as a flagged pattern — it logs `"AI SDK Warning: System messages in the prompt or messages fields can be a security risk..."` by default, and *throws* `InvalidPromptError` if the caller ever sets `allowSystemInMessages: false`. `state.applyNudge` (`src/whiteboard-session.js:384-393`) pushes exactly this shape today:

```js
state.agentHistory.push({
  role: "system",
  content: `STEER FROM USER: ${trimmed}\n\n...`,
});
```

This is fragile (a future stricter SDK config, or a provider that rejects embedded system turns outright, silently drops the steer) and is exactly what the roadmap flags as "nudge text must survive turn buffering." The fix: push it as a clearly-labeled `role: "user"` message instead — universally supported, and unambiguous to the model since it's still prefixed `STEER FROM USER:`.

- [ ] **Step 1: Write the failing test**

Create `test/nudge.test.js`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { createWhiteboardSession } from "../src/whiteboard-session.js";

function makeSession() {
  return createWhiteboardSession({
    options: {},
    wss: { clients: new Set() },
    runAgent: async () => {},
  });
}

test("applyNudge pushes a role:user message, never role:system, so the ai SDK never flags it", () => {
  const session = makeSession();
  session.agentHistory = [{ role: "user", content: "primer" }];
  const applied = session.applyNudge("focus on the budget numbers");
  assert.equal(applied, true);
  const pushed = session.agentHistory.at(-1);
  assert.equal(pushed.role, "user");
  assert.match(pushed.content, /focus on the budget numbers/);
  assert.ok(
    session.agentHistory.every((m) => m.role !== "system"),
    "no message in agentHistory should ever use role:system - the ai SDK warns/throws on that",
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/nudge.test.js`
Expected: FAIL — `pushed.role` is `"system"`, not `"user"`.

- [ ] **Step 3: Fix `applyNudge`**

In `src/whiteboard-session.js`, change (currently lines 384-393):

```js
  state.applyNudge = (text) => {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return false;
    state.agentHistory.push({
      role: "user",
      content: `STEER FROM USER: ${trimmed}\n\nApply this directive on the very next turn. It overrides previous behaviour when in conflict. Do not echo this directive to the canvas as a visual note; it is guidance, not content.`,
    });
    broadcast(wss, { type: "nudge:applied", text: trimmed, timestamp: new Date().toISOString() });
    return true;
  };
```

(Only the `role` field changes, from `"system"` to `"user"`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/nudge.test.js`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/whiteboard-session.js test/nudge.test.js
git commit -m "fix: steer nudges as role:user instead of role:system

The ai SDK (v6) flags/can reject role:system entries embedded in the
messages array outside the dedicated system option. Nudges now push a
clearly-labeled role:user message instead, which every provider
accepts unconditionally."
```

---

## Task 4: Fix scoped-edit — re-validate line numbers against the canvas as of execution

**Files:**
- Modify: `src/server.js:573-576` (turn-start scoped-edit read, inside `runWhiteboardAgent`)
- Test: `test/scoped-edit.test.js` (extend)

**Interfaces:**
- Consumes: `mapSelectedIdsToLineNumbers` (already imported in `src/server.js`, from `src/whiteboard-tools.js`), `state.scopedEdit`, `state.elements`.
- Produces: no signature changes — `state.scopedEdit.lineNumbers` is recomputed in place at the start of every turn instead of trusting the value frozen at request time.

Confirmed by direct read: `POST /api/preso/scoped-edit` (`src/server.js:301-322`) computes `lineNumbers` once, at HTTP-request time, and freezes it into `state.setScopedEdit({ selectedIds, lineNumbers, instruction })`. The instruction actually injected into the model's prompt (`src/server.js:1288-1289`) reads `state.scopedEdit.lineNumbers` directly — the *same* frozen array. If any other turn runs between the scoped-edit request and this turn's execution (e.g. the scoped-edit instruction gets queued behind an in-flight turn via `state.queueTranscript`, or buffered speech triggers an intervening turn), the canvas may have shifted — insertions/deletions renumber every line after them — and the model gets told to edit stale, now-wrong line numbers for the *right* element ids. This is exactly the bug the roadmap names: "scoped edits must re-validate line numbers against the canvas as of execution, not as of request."

- [ ] **Step 1: Write the failing test**

Append to `test/scoped-edit.test.js`:

```js
test("scoped-edit recomputes line numbers against the canvas as of execution, not as of request", async () => {
  const capturedInstructions = [];
  const { httpServer, url, state } = await startTestServer({
    generateTextFn: async ({ system }) => {
      capturedInstructions.push(system);
      return { text: "DONE", finishReason: "stop" };
    },
  });
  try {
    await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stagingElements: [] }),
    });
    state.elements = SCENE; // [a, b, c] -> "c" (Gamma) is line 3 right now

    const res = await scopedEdit(url, { selectedIds: ["c"], instruction: "make it red" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.lineNumbers[0], 3, "line 3 is correct at request time");

    // Simulate the canvas shifting BEFORE the scoped-edit turn actually runs:
    // insert a new element at the top, which pushes "c" from line 3 to line 4.
    state.elements = [
      { id: "z", type: "text", x: 0, y: -40, text: "Zero" },
      ...SCENE,
    ];

    // Now let the scoped-edit turn actually execute (it was queued by the POST above).
    await new Promise((r) => setTimeout(r, 20));

    const lastSystem = capturedInstructions.at(-1);
    assert.match(
      lastSystem,
      /Modify ONLY lines \[4\]/,
      `expected the re-validated line number (4, post-shift) in the prompt, got: ${lastSystem}`,
    );
  } finally {
    httpServer.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/scoped-edit.test.js`
Expected: FAIL — the prompt still says `Modify ONLY lines [3]` (the stale, request-time value), not `[4]`.

- [ ] **Step 3: Recompute line numbers at turn start**

In `src/server.js`, inside `runWhiteboardAgent`, change (currently lines 573-576):

```js
  const scopedEditForTurn = state.scopedEdit
    ? { ...state.scopedEdit, lineNumbers: mapSelectedIdsToLineNumbers(state.elements, state.scopedEdit.selectedIds) }
    : null;
  if (scopedEditForTurn) state.scopedEdit = scopedEditForTurn;
  const scopedBeforeElements = scopedEditForTurn ? [...state.elements] : null;
```

This keeps `state.scopedEdit` as the single source of truth that the prompt-building code at line 1288 already reads, but refreshes `lineNumbers` from the *current* `state.elements` right before that prompt gets built — closing the staleness window to zero.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/scoped-edit.test.js`
Expected: PASS (all tests in the file, including the new one)

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/scoped-edit.test.js
git commit -m "fix: recompute scoped-edit line numbers at turn execution, not request time

Line numbers were frozen when the scoped-edit HTTP request landed, so
any turn that ran before this one's execution (renumbering the canvas)
left the prompt pointing at the wrong lines for the right element ids.
Now recomputed from the live canvas immediately before the turn runs."
```

---

## Task 5: Broadcast `nudge:failed` so every steer gets an explicit result

**Files:**
- Modify: `src/server.js:282-295` (`POST /api/preso/nudge`)
- Test: `test/nudge.test.js` (extend)

**Interfaces:**
- Produces: a new WS broadcast `{ type: "nudge:failed", reason, timestamp }`, sent whenever the route rejects a nudge (mode gate, empty text, or `applyNudge` returning false). `nudge:applied` (already existing, unchanged) covers the success path.

Today the route already responds synchronously with an HTTP error status on rejection, but nothing goes out over the WS channel — any UI that reflects steering state purely from WS messages (as `03-API-CONTRACT.md` documents: "every steer gets an explicit `nudge:applied` or a new `nudge:failed`") has no signal on the failure path. This closes that gap.

- [ ] **Step 1: Write the failing test**

Append to `test/nudge.test.js`:

```js
import { startServer } from "../src/server.js";

function makeTranscriptionMock() {
  const factory = () => ({
    ready: async () => {},
    sendAudio: () => {},
    stop: () => {},
    setSessionContext: () => {},
    close: () => {},
  });
  return { factory };
}

test("POST /api/preso/nudge with empty text broadcasts nudge:failed over WS", async () => {
  const transcription = makeTranscriptionMock();
  const broadcasts = [];
  const { httpServer, url, wss } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: transcription.factory,
    generateTextFn: async () => ({ text: "DONE", finishReason: "stop" }),
    streamTextFn: () => ({ consumeStream: async () => {} }),
    warmupMaxAttempts: 1,
    warmupDelays: [],
  });
  wss.clients.add({ readyState: 1, send: (m) => broadcasts.push(JSON.parse(m)) });
  try {
    await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stagingElements: [] }),
    });
    broadcasts.length = 0;

    const res = await fetch(`${url}/api/preso/nudge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " }), // whitespace-only -> rejected
    });
    assert.equal(res.status, 400);

    const failedMsg = broadcasts.find((m) => m.type === "nudge:failed");
    assert.ok(failedMsg, `expected a nudge:failed broadcast, got: ${JSON.stringify(broadcasts)}`);
  } finally {
    httpServer.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/nudge.test.js`
Expected: FAIL — no `nudge:failed` message is broadcast today.

- [ ] **Step 3: Broadcast `nudge:failed` on rejection**

In `src/server.js`, change the `POST /api/preso/nudge` handler (currently lines 282-295):

```js
  app.post("/api/preso/nudge", express.json(), (req, res) => {
    if (state.mode !== "live") {
      broadcast(wss, { type: "nudge:failed", reason: "not-live", timestamp: new Date().toISOString() });
      return res.status(409).json({ error: "Not in PRESO mode. Start a preso first." });
    }
    const text = String(req.body?.text ?? "").trim().slice(0, 500);
    if (!text) {
      broadcast(wss, { type: "nudge:failed", reason: "empty-text", timestamp: new Date().toISOString() });
      return res.status(400).json({ error: "Nudge text required." });
    }
    const applied = state.applyNudge(text);
    if (!applied) {
      broadcast(wss, { type: "nudge:failed", reason: "apply-failed", timestamp: new Date().toISOString() });
      return res.status(400).json({ error: "Nudge could not be applied." });
    }
    res.json({ ok: true, text });
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/nudge.test.js`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/nudge.test.js
git commit -m "feat: broadcast nudge:failed so the UI never has to guess a steer's outcome

Matches the API contract: every steer now gets an explicit
nudge:applied or nudge:failed over WS, not just an HTTP status the
frontend may not be watching."
```

---

## Task 6: Remove dead `sessionMode`, add `multiSpeaker`

**Files:**
- Modify: `src/settings-store.js:67` (`DEFAULT_SETTINGS.ui`)
- Modify: `src/whiteboard-session.js:66-68` (state field), `src/whiteboard-session.js:414-428` (`startPreso`)
- Modify: `src/server.js:142-154` (`POST /api/preso/start`), `src/server.js:1176-1186` (`buildEffectiveSystemPrompt`)
- Test: `test/server-startup.test.js` (extend), `test/settings-store.test.js` if present (check first)

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildEffectiveSystemPrompt(systemPrompt, primerText, userInstructions, multiSpeaker)` — new 4th param, defaults `false`. `state.startPreso({ primerMessage, agentInstructions, notesAndTranscripts, multiSpeaker })` — new field, defaults `false`. Settings field `ui.multiSpeaker: boolean` replaces `ui.sessionMode: string`.

`sessionMode` (`"strategy" | "presentation" | "cothinking"`) is confirmed dead: it is set once in `DEFAULT_SETTINGS.ui` (`src/settings-store.js:67`) and once in the session state (`src/whiteboard-session.js:68`), but **never read anywhere in `src/server.js` or `src/whiteboard-session.js`** — no prompt branch, no conditional, nothing. It is pure unwired UI cosmetic state, exactly the "mode soup" the roadmap wants collapsed. Replace it with a real, wired `multiSpeaker` boolean that appends a short paragraph to the system prompt (the "Multiple speakers" checkbox the frontend handoff already names, replacing the co-think mode).

- [ ] **Step 1: Write the failing test**

Add to `test/server-startup.test.js` (near the other `buildEffectiveSystemPrompt`/system-prompt tests — search the file for `buildEffectiveSystemPrompt` to find existing neighbors and match their import style):

```js
test("buildEffectiveSystemPrompt appends a multi-speaker paragraph only when multiSpeaker is true", () => {
  const base = buildEffectiveSystemPrompt("BASE", "", "", false);
  assert.doesNotMatch(base, /[Mm]ultiple speakers/);

  const withFlag = buildEffectiveSystemPrompt("BASE", "", "", true);
  assert.match(withFlag, /[Mm]ultiple speakers/);
});

test("POST /api/preso/start reads multiSpeaker from settings and threads it into startPreso", async () => {
  const { httpServer, url, state } = await startTestServer({
    settingsStore: {
      load: async () => ({ agentInstructions: "", notesAndTranscripts: "", multiSpeaker: true }),
      save: async () => {},
      getSanitized: async () => ({}),
    },
  });
  try {
    await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stagingElements: [] }),
    });
    assert.equal(state.multiSpeaker, true);
  } finally {
    httpServer.close();
  }
});
```

(If `test/server-startup.test.js` does not already define a local `startTestServer` helper matching the one in `test/scoped-edit.test.js`, copy that helper in rather than inventing a new shape — check the file first.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/server-startup.test.js`
Expected: FAIL — `buildEffectiveSystemPrompt` doesn't accept a 4th param yet; `state.multiSpeaker` is `undefined`.

- [ ] **Step 3: Update settings schema**

In `src/settings-store.js`, replace line 67:

```js
    // v0.7.0: Session Mode. Three behaviors the agent adapts to.
    sessionMode: "strategy", // "strategy" | "presentation" | "cothinking"
```

with:

```js
    // Multiple speakers in the room. When true, the agent is told to track
    // and attribute distinct voices instead of assuming one speaker.
    multiSpeaker: false,
```

- [ ] **Step 4: Remove the dead state field, thread `multiSpeaker` through `startPreso`**

In `src/whiteboard-session.js`, remove lines 66-68:

```js
    // Session Mode snapshot. Frozen at startPreso so the cached system prompt
    // prefix stays stable; mid-preso changes only take effect on next preso.
    sessionMode: "strategy",
```

In the same file, update `startPreso` (currently lines 414-428):

```js
  state.startPreso = ({ primerMessage, agentInstructions = "", notesAndTranscripts = "", multiSpeaker = false }) => {
    state.endSession();
    state.mode = "live";
    state.elements = seedElements();
    state.latestScreenshot = undefined;
    state.agentHistory = [primerMessage];
    state.agentInstructions = typeof agentInstructions === "string" ? agentInstructions : "";
    state.notesAndTranscripts = typeof notesAndTranscripts === "string" ? notesAndTranscripts : "";
    state.multiSpeaker = Boolean(multiSpeaker);
    state.warmupPromise = Promise.resolve();
    state.canvasDirtyForAgent = false;
    state.cost.reset();
    state.warmupState = { state: "idle", attempt: 0, maxAttempts: DEFAULT_WARMUP_MAX_ATTEMPTS };
  };
```

- [ ] **Step 5: Extend `buildEffectiveSystemPrompt` and thread it through both call sites**

In `src/server.js`, change (currently lines 1176-1186):

```js
export function buildEffectiveSystemPrompt(systemPrompt, primerText, userInstructions = "", multiSpeaker = false) {
  let result = systemPrompt;
  const trimmedUserInstructions = typeof userInstructions === "string" ? userInstructions.trim() : "";
  if (trimmedUserInstructions) {
    result = `${result}\n\nUser instructions:\n${trimmedUserInstructions}`;
  }
  if (multiSpeaker) {
    result = `${result}\n\nMultiple speakers: this session has more than one person talking. Track who is saying what where it matters (e.g. label contributions or use distinct visual grouping per speaker) rather than assuming a single voice.`;
  }
  if (primerText) {
    result = `${result}\n\n${primerText}`;
  }
  return result;
}
```

Then update both call sites (`src/server.js:613` inside `runWhiteboardAgent`, and `src/server.js:875` inside `runWhiteboardWarmupOnce`) from:

```js
  const effectiveSystem = buildEffectiveSystemPrompt(baseSystem, primerText, state.agentInstructions);
```

to:

```js
  const effectiveSystem = buildEffectiveSystemPrompt(baseSystem, primerText, state.agentInstructions, state.multiSpeaker);
```

- [ ] **Step 6: Read `multiSpeaker` from settings in `POST /api/preso/start`**

In `src/server.js`, in the `/api/preso/start` handler, change (currently lines 142-144 and 154):

```js
    const agentInstructions = typeof settings?.agentInstructions === "string" ? settings.agentInstructions : "";
    const notesAndTranscripts =
      typeof settings?.notesAndTranscripts === "string" ? settings.notesAndTranscripts : "";
    const multiSpeaker = Boolean(settings?.multiSpeaker);
```

and:

```js
    state.startPreso({ primerMessage, agentInstructions, notesAndTranscripts, multiSpeaker });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/server-startup.test.js`
Expected: PASS

- [ ] **Step 8: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all green. Grep to confirm no leftover references: `grep -rn "sessionMode" src/` should return nothing.

- [ ] **Step 9: Commit**

```bash
git add src/settings-store.js src/whiteboard-session.js src/server.js test/server-startup.test.js
git commit -m "refactor: replace dead sessionMode with a wired multiSpeaker flag

sessionMode (strategy/presentation/cothinking) was set in two places
and read in zero - pure unwired UI cosmetic state. Replaced with a
real multiSpeaker boolean that's threaded from settings through
startPreso into the system prompt, matching the frontend handoff's
'Multiple speakers' Setup checkbox."
```

---

## Task 7: Rename `preso/*` endpoints to `session/*`, keep old paths as aliases

**Files:**
- Modify: `src/server.js:78-80` (middleware registration), and every `app.get`/`app.post` call whose path starts with `/api/preso/` (lines 126, 182, 187, 195, 203, 233, 241, 247, 253, 260, 265, 273, 282, 301, 326 — 15 routes; verify the exact current line numbers with `grep -n '"/api/preso/'` before editing, since earlier tasks in this plan shift some line numbers)
- Test: `test/session-endpoint-aliases.test.js` (new)

**Interfaces:** none — purely a routing change, no function signatures move.

Rather than duplicating all 15 route registrations, add a single rewrite middleware that maps any `/api/preso/...` request onto `/api/session/...` before Express routes it, then rename every route registration to its `/api/session/...` form. Both paths work identically with zero duplicated logic, satisfying the roadmap's "rename endpoints `preso/*` → `session/*` with aliases kept one version for compatibility."

- [ ] **Step 1: Write the failing test**

Create `test/session-endpoint-aliases.test.js`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { startServer } from "../src/server.js";

function makeTranscriptionMock() {
  const factory = () => ({
    ready: async () => {},
    sendAudio: () => {},
    stop: () => {},
    setSessionContext: () => {},
    close: () => {},
  });
  return { factory };
}

async function startTestServer(extraOptions = {}) {
  const transcription = makeTranscriptionMock();
  return startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: transcription.factory,
    generateTextFn: async () => ({ text: "DONE", finishReason: "stop" }),
    streamTextFn: () => ({ consumeStream: async () => {} }),
    warmupMaxAttempts: 1,
    warmupDelays: [],
    ...extraOptions,
  });
}

test("both /api/session/start and the legacy /api/preso/start reach the same handler", async () => {
  const { httpServer, url } = await startTestServer();
  try {
    const viaSession = await fetch(`${url}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stagingElements: [] }),
    });
    assert.equal(viaSession.status, 200);

    const viaLegacyPreso = await fetch(`${url}/api/preso/back-to-staging`, { method: "POST" });
    assert.equal(viaLegacyPreso.status, 200);

    const viaSessionBackToStaging = await fetch(`${url}/api/session/back-to-staging`, { method: "POST" });
    assert.equal(viaSessionBackToStaging.status, 200);
  } finally {
    httpServer.close();
  }
});

test("both /api/session/nudge and legacy /api/preso/nudge reach the same handler", async () => {
  const { httpServer, url } = await startTestServer();
  try {
    await fetch(`${url}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stagingElements: [] }),
    });
    const viaLegacy = await fetch(`${url}/api/preso/nudge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "steer this" }),
    });
    assert.equal(viaLegacy.status, 200);
  } finally {
    httpServer.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/session-endpoint-aliases.test.js`
Expected: FAIL — `POST /api/session/start` currently 404s (only `/api/preso/start` exists).

- [ ] **Step 3: Add the rewrite middleware**

In `src/server.js`, immediately after the existing middleware registration (currently lines 78-80):

```js
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(PUBLIC_DIR));
  // Endpoint rename: preso/* -> session/*. Kept as a transparent alias for one
  // release so existing clients (and the frontend redesign, mid-migration)
  // don't break. See docs/design-handoff/04-BACKEND-ROADMAP.md item 4.
  app.use((req, _res, next) => {
    if (req.path.startsWith("/api/preso/")) {
      req.url = "/api/session/" + req.url.slice("/api/preso/".length);
    }
    next();
  });
```

- [ ] **Step 4: Rename every `/api/preso/...` route registration to `/api/session/...`**

Run `grep -n '"/api/preso/' src/server.js` to get the current, accurate list (earlier tasks in this plan may have shifted line numbers), then for each match change only the path string, e.g.:

```js
app.post("/api/preso/start", async (req, res) => {
```
becomes
```js
app.post("/api/session/start", async (req, res) => {
```

Apply the same one-word substitution (`preso` → `session`) to all remaining matches: `warmup/cancel`, `back-to-staging`, `smart-stt`, `undo-turn`, `interrupt`, `pin`, `unpin`, `pins/clear`, `pause`, `resume`, `answer`, `nudge`, `scoped-edit`, `say`. Do not change any route that is already `/api/session/...` (`reset`, `current-canvas`, `last-backup`, `restore-backup`) or unrelated routes (`/api/config`, `/api/settings`).

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/session-endpoint-aliases.test.js`
Expected: PASS

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`

Every existing test that hits `/api/preso/...` paths (`test/scoped-edit.test.js`, `test/session-boundary.test.js`, `test/staging-mode.test.js`, etc.) must still pass unmodified — they now go through the alias rewrite. This is the regression check that proves the alias actually works end-to-end, not just for the two paths the new test exercises.

- [ ] **Step 7: Commit**

```bash
git add src/server.js test/session-endpoint-aliases.test.js
git commit -m "refactor: rename /api/preso/* endpoints to /api/session/*, alias the old paths

Session-language rename per the repositioning: preso/* is legacy
naming from the presentation-tool framing. Old paths are transparently
rewritten to the new ones by a single middleware, so no client breaks
during the frontend migration."
```

---

## Task 8: Rename WS `mode` values to `setup` / `listening`

**Files:**
- Modify: `src/server.js:176, 190, 362` (the three `broadcast`/`send` sites for `type: "mode"`)
- Test: `test/staging-mode.test.js` or `test/session-boundary.test.js` (extend — check which already asserts on `mode` WS messages and add there)

**Interfaces:**
- Produces: a `toWireMode(mode)` helper (`"staging" -> "setup"`, `"live" -> "listening"`) used at all three WS `mode` broadcast/send sites. `state.mode` itself keeps its internal `"staging"`/`"live"` values unchanged — this is a wire-format rename only, so every other reference to `state.mode` in `src/server.js` and `src/whiteboard-session.js` (the `state.mode !== "live"` gates, etc.) is untouched.

Scoped deliberately narrow: the frontend handoff's target vocabulary is `setup / listening / paused / review`, but only `setup`/`listening` correspond to real, already-implemented backend states today (`state.mode`'s only two values). `paused` already has its own dedicated WS message (`capture:paused`) and stays that way — folding it into `mode` would be a breaking data-model change with no clear backend trigger defined yet. `review` has no backend concept or trigger at all today (no "end session" endpoint produces it) — inventing one here would be unspecified, speculative behavior. Both are flagged as follow-up work below rather than guessed at.

- [ ] **Step 1: Write the failing test**

Add to `test/staging-mode.test.js` (check the file first for its existing `startTestServer`/WS-capture helper pattern and match it; if it doesn't already capture WS broadcasts, mirror the pattern from `test/nudge.test.js`'s Task 5 addition):

```js
test("WS mode broadcasts use the new setup/listening vocabulary, not staging/live", async () => {
  const { httpServer, url, wss } = await startTestServer();
  const broadcasts = [];
  wss.clients.add({ readyState: 1, send: (m) => broadcasts.push(JSON.parse(m)) });
  try {
    const startRes = await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stagingElements: [] }),
    });
    assert.equal(startRes.status, 200);
    const modeMsg = broadcasts.find((m) => m.type === "mode");
    assert.equal(modeMsg.mode, "listening");

    broadcasts.length = 0;
    await fetch(`${url}/api/preso/back-to-staging`, { method: "POST" });
    const backMsg = broadcasts.find((m) => m.type === "mode");
    assert.equal(backMsg.mode, "setup");
  } finally {
    httpServer.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/staging-mode.test.js`
Expected: FAIL — `modeMsg.mode` is `"live"`, not `"listening"`.

- [ ] **Step 3: Add `toWireMode` and use it at all three broadcast sites**

In `src/server.js`, near the top-level helper functions (alongside `broadcast`/`broadcastCost`), add:

```js
function toWireMode(mode) {
  return mode === "live" ? "listening" : "setup";
}
```

Change the three sites:

`POST /api/session/start` (was `/api/preso/start`, currently line 176):
```js
    broadcast(wss, { type: "mode", mode: toWireMode(state.mode) });
```

`POST /api/session/back-to-staging` (was `/api/preso/back-to-staging`, currently line 190):
```js
    broadcast(wss, { type: "mode", mode: toWireMode(state.mode) });
```

New-connection handler (currently line 362):
```js
    client.send(JSON.stringify({ type: "mode", mode: toWireMode(state.mode) }));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/staging-mode.test.js`
Expected: PASS

- [ ] **Step 5: Run the full suite and check for stale assertions**

Run: `npm test && npm run typecheck`

Grep for any other test asserting `mode: "live"` or `mode: "staging"` on a WS payload (as opposed to `state.mode`, which is unaffected): `grep -rn '"mode".*"live"\|"mode".*"staging"' test/`. Update any such assertions to `"listening"`/`"setup"` — they were asserting the old wire vocabulary.

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/staging-mode.test.js
git commit -m "refactor: rename WS mode wire values staging/live to setup/listening

Wire-format rename only - state.mode keeps its internal staging/live
values everywhere else. paused and review are not modeled as mode
values yet (paused already has its own capture:paused message with no
reason to merge; review has no backend trigger defined) - flagged as
follow-up, not guessed at here."
```

---

## Task 9: Seed ingestion — `POST /api/session/seed`

**Files:**
- Modify: `src/server.js` (new route, alongside the other `/api/session/*` routes from Task 7 — add after the last one)
- Test: `test/seed.test.js` (new)

**Interfaces:**
- Consumes: `runWhiteboardAgent` (unchanged signature, `src/server.js:550`), `normalizeWhiteboardElements` (already imported), `options.settingsStore`.
- Produces: `POST /api/session/seed` — body `{ text: string, existingElements?: array }`, response `{ ok: true, elementCount: number }` on success.

Confirmed by direct read that `runWhiteboardAgent` has no internal `state.mode` gate (all mode gating lives at the HTTP-route layer) and gracefully defaults every optional piece of session state it touches (`mySession = state.session ?? { active: true }`, `typeof state.snapshotForUndo === "function"` guards, etc. — see `src/server.js:550-576`). That means it can be invoked directly against the live session `state` object, before any `startPreso` call, exactly as `test/server-startup.test.js:300-318` already does in isolation with a bare `{ elements, agentHistory }` state object. This task builds the one-shot seeding turn on top of that same call, reusing the real session `state` so results land in `state.elements` and broadcast to any connected client via the existing `whiteboard_overwrite`/edit-op tool broadcasts (`src/server.js:632, 741` roughly — already fire `broadcast(wss, {type:"whiteboard:update",...})` internally, no extra broadcast needed here).

- [ ] **Step 1: Write the failing test**

Create `test/seed.test.js`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { startServer } from "../src/server.js";

function makeTranscriptionMock() {
  const factory = () => ({
    ready: async () => {},
    sendAudio: () => {},
    stop: () => {},
    setSessionContext: () => {},
    close: () => {},
  });
  return { factory };
}

async function startTestServer(extraOptions = {}) {
  const transcription = makeTranscriptionMock();
  return startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: transcription.factory,
    generateTextFn: async () => ({ text: "DONE", finishReason: "stop" }),
    streamTextFn: () => ({ consumeStream: async () => {} }),
    warmupMaxAttempts: 1,
    warmupDelays: [],
    ...extraOptions,
  });
}

test("POST /api/session/seed requires non-empty text", async () => {
  const { httpServer, url } = await startTestServer();
  try {
    const res = await fetch(`${url}/api/session/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    assert.equal(res.status, 400);
  } finally {
    httpServer.close();
  }
});

test("POST /api/session/seed is rejected while a session is live", async () => {
  const { httpServer, url } = await startTestServer();
  try {
    await fetch(`${url}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stagingElements: [] }),
    });
    const res = await fetch(`${url}/api/session/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Q3 roadmap: hiring, budget, launch" }),
    });
    assert.equal(res.status, 409);
  } finally {
    httpServer.close();
  }
});

test("POST /api/session/seed runs a one-shot layout turn and lands elements on state.elements", async () => {
  const { httpServer, url, state } = await startTestServer({
    generateTextFn: async ({ tools, messages }) => {
      const joined = JSON.stringify(messages);
      assert.match(joined, /Q3 roadmap: hiring, budget, launch/, "seed text should reach the model");
      await tools.whiteboard_apply.execute({
        operations: [
          { type: "insert_after", line: 0, element: { type: "text", id: "seed-1", x: 0, y: 0, text: "Q3 roadmap" } },
        ],
      });
      return { text: "DONE", finishReason: "stop" };
    },
  });
  try {
    const res = await fetch(`${url}/api/session/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Q3 roadmap: hiring, budget, launch" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.elementCount, 1);
    assert.equal(state.elements[0].id, "seed-1");
  } finally {
    httpServer.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/seed.test.js`
Expected: FAIL — `POST /api/session/seed` 404s (route doesn't exist yet).

- [ ] **Step 3: Add `buildSeedingTranscript` and the route**

In `src/server.js`, near `buildStagingPrimerMessage` (currently around line 1249), add:

```js
const MAX_SEED_TEXT_CHARS = 200_000;

export function buildSeedingTranscript(text) {
  return `The user is setting up before the session starts and dropped in notes to seed the canvas with. Lay this out as a well-organized starting structure - group related points, use a rough diagram or clustered layout where it helps, don't just dump a wall of text. Primarily organize what's given; only add connective structure (headers, groupings, light connecting arrows), not new unrelated content.

Notes to lay out:
${text}`;
}
```

Then, after the last `/api/session/*` route from Task 7 (find it with `grep -n '"/api/session/' src/server.js` to get the current end of that block):

```js
  app.post("/api/session/seed", express.json(), async (req, res) => {
    if (state.mode === "live") {
      return res.status(409).json({ error: "Cannot seed while a session is live." });
    }
    const text = String(req.body?.text ?? "").trim();
    if (!text) {
      return res.status(400).json({ error: "Seed text required." });
    }
    if (text.length > MAX_SEED_TEXT_CHARS) {
      return res.status(400).json({ error: `Seed text must be ${MAX_SEED_TEXT_CHARS} characters or fewer.` });
    }
    const existingElements = Array.isArray(req.body?.existingElements)
      ? normalizeWhiteboardElements(req.body.existingElements)
      : [];
    let settings;
    try {
      settings = options.settingsStore ? await options.settingsStore.load() : null;
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    state.elements = existingElements;
    state.agentHistory = [];
    state.agentInstructions = typeof settings?.agentInstructions === "string" ? settings.agentInstructions : "";
    state.multiSpeaker = Boolean(settings?.multiSpeaker);
    try {
      await runWhiteboardAgent({
        transcript: buildSeedingTranscript(text),
        state,
        wss,
        options,
        generateTextFn: options.generateTextFn ?? generateText,
        streamTextFn: options.streamTextFn ?? streamText,
      });
    } catch (error) {
      return res.status(500).json({ error: `Seeding turn failed: ${error.message}` });
    }
    res.json({ ok: true, elementCount: state.elements.length });
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/seed.test.js`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/seed.test.js
git commit -m "feat: add POST /api/session/seed for one-shot canvas seeding

Accepts raw notes/bullets and runs the same whiteboard agent through
one layout-focused turn to lay them out on the canvas before a session
starts - the backend half of the Setup screen's seed area."
```

---

## Task 10: Update architecture docs and push

**Files:**
- Modify: `AGENTS.md` (two-mode session model section, endpoint references)
- Modify: `docs/design-handoff/04-BACKEND-ROADMAP.md` (mark items 1-4 done, matching the existing "DONE in v0.17.1" style for item 5)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update `AGENTS.md`**

In the "Two-mode session model" section, add a short note after the existing paragraph about `state.mode`:

```markdown
As of the backend roadmap pass, `/api/preso/*` endpoints are aliased to `/api/session/*` (the old paths still work via a rewrite middleware in `src/server.js`; new code should call the `/api/session/*` form). The WS `mode` broadcast now carries `"setup"`/`"listening"` on the wire (mapped from the same internal `state.mode` values `"staging"`/`"live"` via `toWireMode`).
```

Add a short paragraph after the "Warmup loop" section:

```markdown
### Always-warm agent

`startServer({ alwaysWarm: true, ... })` (set by `src/cli.js`, off by default so tests are unaffected) primes the `[system, tools]` prompt-cache prefix immediately on boot against a neutral `BOOT_WARMUP_MESSAGE`, and silently re-primes (debounced `reWarmDebounceMs`, default 1500ms) whenever `agentInstructions` changes pre-session via `PUT /api/settings` or the `settings:update` WS message. This does not change the fixed-history pattern once a real preso starts — see the Warmup loop section above.
```

- [ ] **Step 2: Update the roadmap doc**

In `docs/design-handoff/04-BACKEND-ROADMAP.md`, mark items 1-4 as done using the same convention item 5 already uses, e.g. change the "## 1. Always-warm agent..." heading to "## 1. Always-warm agent (fixes the missed-context problem) — DONE" and add one line per sub-item noting what shipped and what's explicitly deferred (the `paused`/`review` mode-value follow-up from Task 8).

- [ ] **Step 3: Final full-suite check**

Run: `npm test && npm run typecheck`
Expected: all green — this is the last gate before pushing.

- [ ] **Step 4: Commit and push**

```bash
git add AGENTS.md docs/design-handoff/04-BACKEND-ROADMAP.md
git commit -m "docs: record the backend roadmap items 1-4 as shipped"
git push origin main
```

---

## Deferred / explicitly out of scope

- **`paused`/`review` as WS `mode` values** (Task 8's note): `paused` already has a working dedicated `capture:paused` message; `review` has no backend trigger or semantics defined anywhere yet. Needs a product decision (what ends a session into "review"? Is there a Stop endpoint yet?) before it's implementable, not just guessable.
- **Frontend work**: everything in `02-FRONTEND-HANDOFF.md` — separate track, explicitly out of scope for this plan per `AGENTS.md`'s "What NOT to touch."
- **`notesAndTranscripts`'s documented-but-unenforced 200K char cap** (`src/settings-store.js:35-39`): noticed during Task 4/9 research — the comment claims a cap that `validateAgentInstructions`-style enforcement never actually applies. Real, but unrelated to any of the four roadmap items; flag as a follow-up rather than scope-creeping it in here.
