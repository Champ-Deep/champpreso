# ChampPreso Frontend Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the "brainstorming partner" frontend redesign (`docs/design-handoff/frontend-source/ChampPreso-Shell.dc.html`, a pixel/motion-complete but fully simulated design prototype) into the real, working `public/` frontend — real Excalidraw, real WebSocket protocol, real REST calls against `src/server.js` — replacing the current presentation-era chrome. Add one new backend endpoint (`POST /api/session/review`) the design requires that doesn't exist yet.

**Architecture:** One small backend task (Task 1, TDD, same conventions as the prior backend-roadmap plan) followed by nine frontend tasks that split the current 4061-line `public/app.js` monolith into focused ES modules: an API client, a WS client, a mic-capture module, an Excalidraw-sync module, three lifecycle-screen components (Setup, Listening/Paused, Review), and a slimmed-down `app.js` orchestrator. No build step, no bundler, no JSX anywhere — `React.createElement` calls only, ES modules loaded via the existing importmap in `public/index.html`.

**Tech Stack:** Plain ES modules, React 19.2.0 + Excalidraw 0.18.0 (both pinned via esm.sh in the importmap — do not change these pins), `ai` SDK v6 (`generateObject` for the new backend endpoint), Node's built-in test runner for the backend task.

## Global Constraints

- No build step, no bundler, no JSX, no npm frontend deps — `React.createElement(...)` only, exactly like the current `public/app.js`. New files are plain `.js` ES modules loaded the same way.
- Keep the React/Excalidraw/mermaid version pins in `public/index.html`'s importmap unchanged unless a task explicitly says otherwise.
- Match `docs/design-handoff/frontend-source/ChampPreso-Shell.dc.html` **pixel- and motion-for-pixel-and-motion**: exact colors (via the Aegis token file, also copied into `docs/design-handoff/frontend-source/_ds/aegis-design-system/`), exact spacing/radii/shadows, exact animation keyframes and easing curves, exact copy strings, exact layout per lifecycle state. That file is titled "ChampPreso Shell" and is the **chosen, final design** — `Wireframes.dc.html` in the same folder is earlier exploratory scratch work (labeled 1a-1h); it is background context only, not something to implement. The Shell file's own inline comments reference which wireframe option it descended from (e.g. "1b halo", "1f") — that lineage is already resolved in the Shell file itself.
- The Shell prototype's `DCLogic`/`x-dc`/`sc-for`/`sc-if`/`{{ }}` templating is a proprietary design-tool runtime (`support.js` in the same folder) — **do not use this runtime or any of its markup syntax in the real app.** Translate the *rendered visual result and interaction logic* into ordinary `React.createElement` + CSS, not the templating mechanism.
- The Shell prototype's `simScript()`/`runSim()` (a hardcoded, timer-driven fake meeting transcript) and the "DEMO ·" corner buttons (`demoMcq`, `demoFreeform`, `demoFailSteer`) are prototyping scaffolding only — **do not port these into the real app.** Real data comes from the WS/REST backend exclusively.
- Endpoint paths: use the canonical `/api/session/*` forms everywhere in new frontend code (not the legacy `/api/preso/*` aliases — those exist only for backward compatibility with old clients, per `AGENTS.md`).
- The WS `mode` broadcast now carries both `mode` (`"staging"`/`"live"`, unchanged) and `lifecycleMode` (`"setup"`/`"listening"`, new) — see `AGENTS.md`'s "Two-mode session model" section. New frontend code should key its 4-phase UI state (`setup` / `listening` / `paused` / `review`) off `lifecycleMode` plus the existing `capture:paused` WS message for the paused/listening distinction, not off the raw `mode` field.
- Keep `npm run typecheck` and `npm test` green after every task (the backend task adds a test; frontend tasks must not break the existing `test/browser-smoke.test.js`, which drives the real app in a real Chrome browser via `webapp-testing`/Playwright-style automation).
- Commit after every task (`feat: ...` / `refactor: ...`, one logical change per commit).
- This plan continues on the same branch as the prior backend-roadmap plan (`worktree-backend-roadmap`) per explicit instruction — do not create a new branch.

---

## Task 1: `POST /api/session/review` — decisions + summary extraction

**Files:**
- Modify: `src/server.js` (new route, near the other `/api/session/*` routes added in the prior plan's Task 7/9)
- Test: `test/session-review.test.js` (new)

**Interfaces:**
- Consumes: `generateObject` (from `ai`, already available — `node_modules/ai` exports it, `zod` v4 already imported as `z` in `src/server.js`), `resolveAgentProviderFromSettings`, `createWhiteboardAgentModel`, `createWhiteboardAgentProviderOptions` (all exist, unchanged), `formatLineNumberedWhiteboard` (from `src/whiteboard-tools.js`, already imported), `recordAgentCost` (existing helper at `src/server.js:1106`, reuse — do not reimplement cost recording).
- Produces: `POST /api/session/review` — no request body needed. Response `{ ok: true, decisions: string[], summary: string }` on success.

This is the backend piece the design's Review panel needs (flagged directly in the design source as `"backend ask: summary + decisions extraction turn"`). It is a **read-only extraction** — unlike the seed endpoint (Task 9 of the prior plan), it must never call whiteboard-editing tools or mutate `state.elements`/`state.agentHistory`. It runs a single `generateObject` call (structured output, not tool-calling) against the current canvas text and the turn-by-turn speaker record already accumulated in `state.agentHistory`.

- [ ] **Step 1: Write the failing test**

Create `test/session-review.test.js`:

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

test("POST /api/session/review is rejected outside live mode", async () => {
  const { httpServer, url } = await startTestServer();
  try {
    const res = await fetch(`${url}/api/session/review`, { method: "POST" });
    assert.equal(res.status, 409);
  } finally {
    httpServer.close();
  }
});

test("POST /api/session/review extracts decisions and a summary via generateObject, and records cost", async () => {
  let capturedPrompt = "";
  const { httpServer, url, state } = await startTestServer({
    generateObjectFn: async (opts) => {
      capturedPrompt = opts.prompt;
      return {
        object: { decisions: ["Priya owns onboarding", "Pilot launches in Q3"], summary: "The team locked a Q3 pilot plan." },
        usage: { inputTokens: 800, outputTokens: 40 },
      };
    },
  });
  try {
    await fetch(`${url}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stagingElements: [] }),
    });
    state.elements = [{ id: "a", type: "text", x: 0, y: 0, text: "Q3 goal" }];
    state.agentHistory.push({ role: "user", content: "Speaker turn:\nlet's lock the pilot for Q3" });

    const res = await fetch(`${url}/api/session/review`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.decisions, ["Priya owns onboarding", "Pilot launches in Q3"]);
    assert.equal(body.summary, "The team locked a Q3 pilot plan.");
    assert.match(capturedPrompt, /Q3 goal/);
    assert.match(capturedPrompt, /lock the pilot for Q3/);

    // Read-only: must not have mutated the canvas or history.
    assert.equal(state.elements.length, 1);
  } finally {
    httpServer.close();
  }
});

test("POST /api/session/review surfaces a clean 500 if the model call throws", async () => {
  const { httpServer, url } = await startTestServer({
    generateObjectFn: async () => { throw new Error("provider timeout"); },
  });
  try {
    await fetch(`${url}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stagingElements: [] }),
    });
    const res = await fetch(`${url}/api/session/review`, { method: "POST" });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /provider timeout/);
  } finally {
    httpServer.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/session-review.test.js`
Expected: FAIL — `POST /api/session/review` 404s (route doesn't exist yet).

- [ ] **Step 3: Add the route**

In `src/server.js`, add `generateObject` to the existing `ai` import (currently `import { generateText, stepCountIs, streamText, tool } from "ai";`):

```js
import { generateObject, generateText, stepCountIs, streamText, tool } from "ai";
```

Add a schema constant near the other `z.object({...})` schemas already in the file, and the route after the last `/api/session/*` route (find it with `grep -n '"/api/session/' src/server.js` to get the current end of that block — Task 9's `/api/session/seed` route from the prior plan should be the immediately preceding route):

```js
const SESSION_REVIEW_SCHEMA = z.object({
  decisions: z.array(z.string().min(1).max(160)).max(6).describe("Concrete things the group decided or agreed on, most important first. Empty array if nothing was decided yet."),
  summary: z.string().min(1).max(600).describe("A 2-4 sentence plain-language summary of what this session covered."),
});

app.post("/api/session/review", express.json(), async (req, res) => {
  if (state.mode !== "live") {
    return res.status(409).json({ error: "Review is only available for a session that has gone live." });
  }
  try {
    const agentProvider = options.agentProvider
      ?? (options.settingsStore
        ? resolveAgentProviderFromSettings({ settings: await options.settingsStore.load(), env: options.env ?? process.env })
        : defaultWhiteboardAgentProvider(options));
    const boardText = formatLineNumberedWhiteboard(state.elements);
    const transcriptSoFar = state.agentHistory
      .filter((m) => m.role === "user" && typeof m.content === "string")
      .map((m) => m.content)
      .join("\n\n");
    const reviewPrompt = `You are summarizing a live brainstorm session for the person who ran it, right after they ended it.

Canvas as it stands now (line-numbered):
${boardText}

Turn-by-turn record of what was said and drawn:
${transcriptSoFar || "(nothing was said yet)"}

Extract the concrete decisions this group actually made (not aspirations, not open questions - decided things), and write a short summary of what the session covered. If nothing concrete was decided, return an empty decisions array and say so plainly in the summary.`;
    const generateObjectFn = options.generateObjectFn ?? generateObject;
    const result = await generateObjectFn({
      model: createWhiteboardAgentModel(agentProvider),
      providerOptions: createWhiteboardAgentProviderOptions(agentProvider, "You extract concrete decisions and a short summary from a brainstorm session transcript. Be terse and concrete."),
      schema: SESSION_REVIEW_SCHEMA,
      prompt: reviewPrompt,
    });
    recordAgentCost(state, wss, agentProvider, result);
    res.json({ ok: true, decisions: result.object.decisions, summary: result.object.summary });
  } catch (error) {
    res.status(500).json({ error: `Review summary failed: ${error.message}` });
  }
});
```

`defaultWhiteboardAgentProvider` is the existing fallback already used at the top of `runWhiteboardAgent` (`src/server.js` — search for it) — reuse it exactly as that function does, do not reimplement provider resolution.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/session-review.test.js`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/session-review.test.js
git commit -m "feat: add POST /api/session/review for decisions + summary extraction

Read-only generateObject call over the current canvas and turn history
- the backend piece the redesign's Review panel needs. Never mutates
state.elements or state.agentHistory, unlike the seed endpoint."
```

---

## Task 2: Design tokens + CSS foundation

**Files:**
- Modify: `public/style.css` (the `:root` token block at the top, currently lines 9-78; remove the `CHAMPPRESO` patch blocks, currently lines ~2705-2887)
- Reference (read, do not modify): `docs/design-handoff/frontend-source/_ds/aegis-design-system/colors_and_type.css`, `docs/design-handoff/frontend-source/ChampPreso-Shell.dc.html` (the `<style>` block inside `<helmet>`, near the top of the file, for the extra keyframes and base resets)

**Interfaces:**
- Produces: every CSS custom property the Shell design references via `var(--champ-*)`, `var(--font-*)`, plus the keyframes `ppPulse`, `ppPopIn`, `ppFadeUp`, `ppDropIn`, `ppWave1`, `ppWave2`, `ppWave3` (exact names — later tasks' components reference these keyframe names directly in their CSS).

This task lands the visual foundation everything else builds on, with zero component changes yet — the app should look and behave identically after this task (verify with the existing browser-smoke test), it's purely additive/cleanup at the token layer.

- [ ] **Step 1: Merge the Aegis token file into `public/style.css`'s `:root` block**

Read `docs/design-handoff/frontend-source/_ds/aegis-design-system/colors_and_type.css` in full. Read the current `:root { ... }` block in `public/style.css` (lines 9-78) in full. Merge them: keep every existing Champions Group parent-brand variable already in `public/style.css` (the frontend handoff doc explicitly says keep these "for back-compat with existing classes" — do not delete `--cg-orange` etc.), and add/reconcile every `--champ-*`, `--font-*`, `--fs-*`, `--lh-*`, `--ls-*`, `--s-*`, `--r-*`, `--t-*`, `--ease-*`, `--shadow-*` token from the Aegis file. Where a token already exists in `public/style.css` under the same name with the same value, don't duplicate it — where the Aegis file's value differs from what's currently in `public/style.css`, the Aegis file wins (it's the canonical source for this redesign). Add the `[data-theme="light"]` override block from the Aegis file too (currently absent from `public/style.css`).

Do not import Google Fonts via `@import url(...)` inside `style.css` — instead add the same `<link>` tags the Aegis file's stylesheet comment describes to `public/index.html`'s `<head>` (Space Grotesk, Inter, JetBrains Mono, Fraunces, plus Caveat which the Shell file also loads for the hand-drawn canvas label styling — check the Shell file's `<helmet>` for the exact Google Fonts URL and copy it verbatim). This matches how `public/index.html` already loads the Excalidraw CSS via `<link>`, not via a `style.css` `@import`.

- [ ] **Step 2: Add the animation keyframes**

Copy the seven `@keyframes` rules (`ppPulse`, `ppPopIn`, `ppFadeUp`, `ppDropIn`, `ppWave1`, `ppWave2`, `ppWave3`) verbatim from the Shell file's `<style>` block into `public/style.css`, plus the `@media (prefers-reduced-motion: reduce)` rule right after them (same block in the Shell file) — this repo's own base already respects `prefers-reduced-motion` in a couple of places per the structural map (`public/style.css`'s existing rules), keep both mechanisms, they don't conflict.

- [ ] **Step 3: Remove the legacy `CHAMPPRESO` patch blocks**

Delete the three `CHAMPPRESO` patch blocks (`v0.15 PATCH`, `v0.16 STREAMLINE`, `v0.17` — currently around lines 2705-2887, confirm exact current line numbers with `grep -n "CHAMPPRESO" public/style.css` since other edits in this task shift line numbers). These exist only to fight the current Live Transcript History component's fragile class-substring targeting (`[class*="transcript" i]` etc.) — the redesign gives that content a real home (the Listening screen's status drawer, per the Shell design) with stable class names in a later task, so these `!important`-heavy overrides become dead weight. Do not delete anything else in the file yet — later tasks will remove specific component CSS as those components get rewritten (Task 8 for Setup, Task 9 for Listening, Task 10 for Review). For now the old JS components (`CaptionFab`, `NudgeBar`, etc.) are all still present and still rendering with their old CSS, since `public/app.js` hasn't been touched by this task — only the deleted patch blocks (which target content that will be rebuilt in later tasks anyway, so their removal has no visible effect until those tasks land).

- [ ] **Step 4: Verify nothing broke**

Run: `npm test` (in particular `node --test test/browser-smoke.test.js`, the real Chrome-driven test) — must still pass, since this task should be visually inert except for the (currently invisible, because no component targets them yet) new keyframes and tokens.

Use the `run` skill or `webapp-testing` skill to boot the app locally and take a screenshot of the current (still old-chrome) UI in both Setup and Listening states, confirming nothing visually broke from the token merge (e.g. no missing CSS variable causing a `color: ` fallback to black/transparent).

- [ ] **Step 5: Commit**

```bash
git add public/style.css public/index.html
git commit -m "feat: merge Aegis design tokens into style.css, remove legacy CSS patches

Foundation for the frontend redesign - full Champ Suite token set
(neutrals, Ember family, semantic signals, type scale, spacing, radii,
motion, shadows) plus the redesign's animation keyframes. Removes the
v0.15-v0.17 CHAMPPRESO !important patch blocks, dead weight once the
Live Transcript History gets real markup in a later task."
```

---

## Task 3: API client module

**Files:**
- Create: `public/api-client.js`
- Modify: `public/app.js` (replace inline `fetch()` calls with imports from the new module — this task ONLY does the extraction, no behavior change)

**Interfaces:**
- Produces: a single default export (or named exports, implementer's choice, but document which) covering every REST call `public/app.js` currently makes, using canonical `/api/session/*` paths, PLUS the two new endpoints:
  - `getConfig()` → `GET /api/config`
  - `getSettings()` / `saveSettings(patch)` → `GET`/`PUT /api/settings`
  - `startSession({ stagingElements, stagingScreenshot })` → `POST /api/session/start`
  - `backToSetup()` → `POST /api/session/back-to-staging`
  - `pauseSession()` / `resumeSession()` → `POST /api/session/pause` / `/resume`
  - `undoTurn()` → `POST /api/session/undo-turn`
  - `interruptTurn()` → `POST /api/session/interrupt`
  - `pinElement(id)` / `unpinElement(id)` / `clearPins()` → `POST /api/session/pin` / `/unpin` / `/pins/clear`
  - `answerQuestion({ id, text })` → `POST /api/session/answer`
  - `sendNudge(text)` → `POST /api/session/nudge`
  - `sendScopedEdit({ selectedIds, instruction })` → `POST /api/session/scoped-edit`
  - `sendTypedTurn(text)` → `POST /api/session/say`
  - `resetSession()` → `POST /api/session/reset`
  - `getLastBackup()` → `GET /api/session/last-backup`
  - `restoreBackup()` → `POST /api/session/restore-backup`
  - `getCurrentCanvas()` → `GET /api/session/current-canvas`
  - `seedCanvas({ text, existingElements })` → `POST /api/session/seed` (new, Task 9 of the prior backend-roadmap plan)
  - `reviewSession()` → `POST /api/session/review` (new, this plan's Task 1)

**Interfaces:**
- Consumes: nothing external — plain `fetch` wrapping.

Every function returns the parsed JSON body on success and throws an `Error` with the server's `{error}` message on a non-2xx response (a single shared helper, e.g. `async function request(path, options)`, used by every exported function — do not duplicate the fetch/error-handling boilerplate 18 times).

- [ ] **Step 1: Write `public/api-client.js`**

Read every current `fetch(` call site in `public/app.js` (14 of them, listed in the structural map: lines ~439, 451, 475, 488, 510, 535, 676, 693, 1027, 1038, 1168, 1192, 1231, plus the two `nudge` calls at ~3284/3588) to get each call's exact method, headers, and body shape before writing the wrapper — match them exactly (e.g. the pin endpoint's exact body shape, the pause/resume endpoint selection logic currently at line 676). Write the module with a shared request helper:

```js
async function request(path, options = {}) {
  const res = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const contentType = res.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await res.json() : null;
  if (!res.ok) {
    throw new Error(payload?.error ?? `${path} failed with status ${res.status}`);
  }
  return payload;
}
```

Then one exported function per endpoint in the list above, each a thin call to `request(...)`.

- [ ] **Step 2: Wire `public/app.js` to use the new module for all 14+ current call sites**

Add `import * as api from "./api-client.js";` (or named imports) at the top of `public/app.js`, and replace each inline `fetch(...)` block with the corresponding `api.xxx(...)` call, preserving the exact same error handling / state updates around each call site (only the fetch mechanics move, not the surrounding logic). Also update the two currently-legacy `/api/preso/nudge` call sites (structural map lines 3284, 3588) to go through `api.sendNudge(...)`.

- [ ] **Step 3: Verify nothing broke**

Run `npm test` (browser-smoke must still pass — this is a pure refactor of the current app, not yet touching the new design). Manually smoke-test locally via the `run` skill: start a session, send a nudge, pause/resume, undo, end — confirm every action that used to work still works identically.

- [ ] **Step 4: Commit**

```bash
git add public/api-client.js public/app.js
git commit -m "refactor: extract all REST calls into public/api-client.js

Pure extraction, no behavior change - centralizes 16 fetch call sites
(14 existing + the new seed/review endpoints) behind one module with
shared request/error handling, using canonical /api/session/* paths."
```

---

## Task 4: WebSocket client module

**Files:**
- Create: `public/ws-client.js`
- Modify: `public/app.js` (replace the inline WS `useEffect` — structural map lines 791-1000 — with the new module; no behavior change)

**Interfaces:**
- Produces: `createWsClient({ onMessage, onOpen, onClose, onError })` returning `{ send(obj), close() }`. `onMessage` receives the already-`JSON.parse`d message object — `public/app.js` keeps its existing `if (message.type === ...)` chain (or converts it to a lookup table — implementer's choice, but do not change which message types are handled or how, only where the connection/parsing lives) as the body of `onMessage`.
- Consumes: nothing external.

This module owns exactly what the current inline effect owns: opening the `ws://.../ws` (or `wss://`) connection, JSON-parsing inbound frames, and exposing a `send` that JSON-stringifies outbound frames. It does NOT own message routing/business logic — that stays in `app.js` (or moves into the screen components in later tasks), passed in as the `onMessage` callback.

- [ ] **Step 1: Write `public/ws-client.js`**

```js
export function createWsClient({ onMessage, onOpen, onClose, onError }) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener("open", () => onOpen?.());
  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    onMessage?.(message);
  });
  ws.addEventListener("close", () => onClose?.());
  ws.addEventListener("error", (event) => onError?.(event));
  return {
    send(obj) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
    close() {
      ws.close();
    },
    get readyState() {
      return ws.readyState;
    },
  };
}
```

- [ ] **Step 2: Wire `public/app.js` to use it**

Replace the inline `useEffect` (structural map lines 791-1000) with a call to `createWsClient(...)` inside the same effect, moving the existing `if (message.type === "...")` chain verbatim into the `onMessage` callback. Replace every `ws.send(JSON.stringify(...))` call site elsewhere in `app.js` (mic streaming at ~1092/1095, `stop` at ~1116, `warmup:cancel` at ~1054, `whiteboard:user-elements` sync in `handleExcalidrawChange`) with `wsClient.send({...})`. Keep `wsRef` (or rename it) pointing at the object `createWsClient` returns, since other code reads `wsRef.current.readyState`/`wsRef.current` for guards.

While you're in this code, key the app's phase state off the new `lifecycleMode` field in the `mode` WS message (added by the additive Task 8 of the prior backend plan) instead of the raw `mode` field — `lifecycleMode` is exactly `"setup"` or `"listening"`, matching this redesign's vocabulary; combine it with the existing `capture:paused` message to derive the 4th phase, `paused` (phase is `paused` when `lifecycleMode === "listening"` AND the last `capture:paused` message had `paused: true`). There is no `"review"` value from the server — `review` is a purely client-side phase entered when the user clicks "End" (see Task 9), not something the WS `mode` message ever carries.

- [ ] **Step 3: Verify nothing broke**

Run `npm test` (browser-smoke must still pass). Manually verify locally: every WS-driven UI update (captions, agent status, cost, questions) still works.

- [ ] **Step 4: Commit**

```bash
git add public/ws-client.js public/app.js
git commit -m "refactor: extract WS connection handling into public/ws-client.js

Pure extraction - connection/parse/send mechanics move out of the
791-line inline useEffect into a small reusable module; message
routing logic is unchanged, just relocated into the onMessage callback.
Phase derivation now keys off the new lifecycleMode field."
```

---

## Task 5: Mic capture module

**Files:**
- Create: `public/mic-capture.js`
- Modify: `public/app.js` (replace inline mic code — structural map lines 3059-3135 plus the `getUserMedia`/streaming wiring in `startListening()`/`stopListening()` — with imports; no behavior change)

**Interfaces:**
- Produces: `startMicCapture({ deviceId, onChunk })` returning `Promise<{ analyser: AnalyserNode, close(): void }>` (matching the current `createAudioStreamer`'s return shape plus lifecycle), and `resample`/`pcm16ToBase64` as either internal helpers or named exports if `MicEditor`'s preview flow (structural map line 2549, its own separate `getUserMedia` call) needs them too — check whether `MicEditor` needs to import from this module or can stay using its own simpler preview-only `getUserMedia` call (likely the latter, since it doesn't need the resample/encode pipeline, just a level meter — verify against the current `MicEditor` code before deciding).

This is the most mechanically self-contained extraction in this plan — the audio pipeline (`AudioContext`, `ScriptProcessorNode`, resampling, PCM16 encoding) has no dependency on React state or the redesign's visual changes at all.

- [ ] **Step 1: Write `public/mic-capture.js`**

Move `createAudioStreamer` (lines 3059-3091), `resample` (3092-3112), `pcm16ToBase64` (3113-3135) verbatim into the new module, renaming `createAudioStreamer` to `startMicCapture` if you change its signature to take `{ deviceId, onChunk }` directly (folding in the `getUserMedia` call itself, currently at line 1087, so callers don't need to call `getUserMedia` separately) — implementer's judgment on the exact signature, but document it clearly in a comment at the top of the file, since Task 9 (Listening screen) depends on it directly.

- [ ] **Step 2: Wire `public/app.js` to use it**

Replace the inline audio pipeline in `startListening()`/`stopListening()` (structural map lines 1065-1125) with calls into the new module. `Waveform` (structural map lines 2234-2327) keeps consuming the returned `analyser` exactly as today.

- [ ] **Step 3: Verify nothing broke**

Run `npm test`. Manually verify locally: mic capture still starts on Start listening, the waveform still animates, audio still streams to the server (confirm via server logs or a real transcript appearing).

- [ ] **Step 4: Commit**

```bash
git add public/mic-capture.js public/app.js
git commit -m "refactor: extract mic capture pipeline into public/mic-capture.js

Pure extraction - AudioContext/ScriptProcessorNode/resample/PCM16
encoding move out of app.js into a self-contained module with no
React dependency."
```

---

## Task 6: Excalidraw sync module

**Files:**
- Create: `public/excalidraw-sync.js`
- Modify: `public/app.js` (replace inline sync logic — structural map lines 1241-1268, 762-788, 3136-3196, 1270-1300+ — with imports; no behavior change)

**Interfaces:**
- Produces: functions matching the current `applyScene`, `handleExcalidrawChange`, `nativeElementsToSkeletonForSync`, `stripInternalFields`, `applyWhiteboardViewportCommand` — same signatures, same guards (`modeRef.current`, `agentStatusRef.current === "thinking"`), moved verbatim. This is the highest-risk extraction in the plan (per the structural map's own warning: "any state-management refactor must preserve those guards exactly or the live-edit sync will race the agent") — copy the logic exactly, do not "clean it up" or change behavior while moving it.

**This task is extraction only, byte-for-byte behavior preservation.** Do not attempt to improve or simplify this code as part of the move — it directly owns the delicate mode/status-aware sync contract between the client's Excalidraw instance and the server's canvas state, and any subtle behavior change here would be very hard to notice until a real session hits the exact race it guards against.

- [ ] **Step 1: Write `public/excalidraw-sync.js`**

Move the five functions verbatim, taking their current closure dependencies (`modeRef`, `agentStatusRef`, `stagingSceneRef`, `selectedIdsRef`, `lastSyncedElementsHashRef`, `userElementsSyncTimerRef`, `screenshotTimerRef`, the `wsClient`/`send` reference, `excalidrawAPI`) as explicit parameters instead of closure captures, since they now live in a different module — e.g. `createExcalidrawSync({ getMode, getAgentStatus, getExcalidrawApi, wsSend, scheduleScreenshot })` returning `{ applyScene, handleExcalidrawChange, ... }`, with the refs it needs passed in as getter functions so it always reads the current value rather than a stale closure (the exact pattern the ref-mirror convention in the current code exists to avoid).

- [ ] **Step 2: Wire `public/app.js` to use it**

Replace the five inline functions with calls into the module, keeping every call site (the `onChange` prop on the `Excalidraw` component at line 1522, the `whiteboard:update`/`whiteboard:viewport` WS handlers, the mermaid-render handler) pointed at the same behavior.

- [ ] **Step 3: Verify nothing broke — this is the task to test most carefully**

Run `npm test` (browser-smoke). Then manually verify locally, exercising every mode/status combination the guards protect:
- Draw on the canvas in Setup (staging) mode — confirm nothing is sent to the server (the early-return guard).
- Start a session, let the agent draw something (confirm `whiteboard:update` still renders correctly, ids preserved for `focus_ids`).
- While the agent is "thinking" (mid-turn), try editing the canvas locally — confirm the sync is still suppressed until the turn finishes (the `agentStatusRef.current === "thinking"` guard).
- Go back to Setup from a live session — confirm the staging snapshot restore still works (`stagingSceneRef`).

- [ ] **Step 4: Commit**

```bash
git add public/excalidraw-sync.js public/app.js
git commit -m "refactor: extract Excalidraw sync logic into public/excalidraw-sync.js

Byte-for-byte extraction of the mode/status-aware canvas sync contract
(applyScene, handleExcalidrawChange, skeleton conversion, viewport
commands) - no behavior change, verified against every mode/status
guard combination manually."
```

---

## Task 7: Delete dead code

**Files:**
- Delete: `public/transcript-panel.js`
- Modify: `public/app.js` (remove the now-unused `STARTER_STAGING_ELEMENTS` empty-array special case if Task 6/9 subsumes it — check first)

**Interfaces:** none.

`public/transcript-panel.js` is confirmed dead (not imported anywhere, per the structural map). Delete it as part of this cleanup pass now that the modules that might plausibly have wanted it (Tasks 4-6) are done, so its absence is easy to verify didn't break an import.

- [ ] **Step 1: Confirm it's still unimported**

Run: `grep -rn "transcript-panel" public/` — expect zero matches after Tasks 3-6 (they shouldn't have introduced a new import of it; if one did, stop and figure out why before deleting).

- [ ] **Step 2: Delete and verify**

```bash
git rm public/transcript-panel.js
npm test
```

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: remove dead public/transcript-panel.js

Confirmed unimported anywhere in public/ (superseded by inline
transcriptHistory state/logic in app.js)."
```

---

## Task 8: Setup screen

**Files:**
- Create: `public/screens/setup-screen.js`
- Modify: `public/app.js` (mount the new component when `phase === "setup"`, remove the old inline Setup-mode rendering + the old `mode-toggle`/`sm-tab` JSX and the components it fully replaces: the old staging-canvas side panel, `OnboardingRibbon`)

**Interfaces:**
- Consumes: `api-client.js` (`startSession`, `saveSettings`, `getSettings`, `seedCanvas`, `getLastBackup`, `restoreBackup`), the design tokens from Task 2.
- Produces: `SetupScreen({ excalidrawApi, onStarted, wsClient })` — a component `app.js` mounts when phase is `setup`. Manages its own local UI state (intent text, multiSpeaker checkbox, settings-sheet open/closed, restore feedback) and calls the provided callbacks/API client for anything that needs to leave the component.

Translate `docs/design-handoff/frontend-source/ChampPreso-Shell.dc.html`'s **SETUP RAIL** section (search the file for `SETUP RAIL (1f)`, roughly lines 62-104) and **SETTINGS SHEET** section (`SETTINGS SHEET`, roughly lines 106-223) into real `React.createElement` + CSS matching the file's inline styles exactly (colors via the Task 2 tokens — e.g. `background:var(--champ-ink,#0B0D12)` becomes a CSS class using `var(--champ-ink)`, not a hardcoded hex). Read those two sections in the Shell file directly for the exact copy strings, layout, spacing, and conditional rendering (`sc-if value="{{ ... }}"` blocks map to plain `condition && React.createElement(...)` or ternaries) — this plan does not re-transcribe the file's markup because the file itself is the authoritative source; translate it faithfully rather than approximating from memory.

Real wiring, replacing the mockup's fake `state`:
- **Session intent textarea** → local component state, saved via `api.saveSettings({ agentInstructions: text })` on change (debounced ~400ms, matching the current app's existing debounce convention for this exact field — check `agentInstructionsSaveTimerRef` in the current `app.js` before this task's edits land, for the debounce interval to match).
- **Multiple speakers checkbox** → local state, saved via `api.saveSettings({ multiSpeaker: checked })` (the new settings field from the prior backend plan's Task 6 — note the settings schema key is `multiSpeaker`, a top-level boolean per that task, not nested under `ui`).
- **Restore last session button** → `api.getLastBackup()` then, if found, `api.restoreBackup()` and reflect the restored element count/timestamp in the `restoredText` UI feedback line (the design shows `"RESTORED · YESTERDAY 4:12 PM · 9 DRAWINGS"` — build the real equivalent string from the backup's `savedAt` timestamp and element count, format `"RESTORED · {relative or absolute time} · {N} DRAWINGS"`).
- **Settings button / sheet** → opens the sheet the design specifies (Agent provider/model/API key, Transcription local/cloud + model, Mic device + level, Appearance theme/palette/captions). This CONSOLIDATES the current app's three separate editor components (`AgentEditor`, `TranscriptionEditor`, `MicEditor`, structural map lines 2626-3039, 2520-2625) into one sheet matching the design's single-scroll layout — reuse those components' existing option-list constants (`OPENAI_AGENT_MODELS`, `GROQ_AGENT_MODELS`, etc. — module-level constants in the current `app.js`, lines 26-75) rather than re-deriving the model lists, but rebuild the actual form markup to match the Shell design's settings-sheet layout exactly (single scrollable sheet, not three separate popovers). Every change calls `api.saveSettings(patch)` immediately (design copy: "Changes apply now. The agent re-warms in the background, nothing blocks." — this is literally true given the prior backend plan's Task 2 debounced re-warm).
- **Readiness glyph** (`readyDotColor`/`readyText` in the mockup) → real warmth state from the `warmup` WS message (already handled somewhere in the current `app.js`, structural map line 869 — thread that state into this component) instead of the mockup's fake `warmState`/`rewarm()` timer simulation.
- **Seed area** (present in this Shell version as the closing line "Seed the canvas: paste or draw directly on it" plus the canvas hint overlay `showCanvasHint`) → add a real seed text-drop affordance calling `api.seedCanvas({ text, existingElements: excalidrawApi.getSceneElements() })` — the Shell's setup rail in this exact version doesn't show a dedicated seed textarea (compare against wireframe option `1e`/`1d` for a fuller seed-area treatment referenced in `Wireframes.dc.html` if you want a richer affordance) — at minimum wire a way to paste text that calls the seed endpoint; if the Shell file's DOM has no explicit seed input element, add a minimal one (a text area behind a "Seed with notes" disclosure, or accept a paste event directly on the canvas-hint region) rather than skipping the capability entirely, since the seed endpoint exists specifically to serve this screen. Use your judgment on the exact UI treatment but do not skip wiring it — flag your choice in the task report.
- **Start listening button** → `api.startSession({ stagingElements: excalidrawApi.getSceneElements(), stagingScreenshot: ... })` (match the current app's existing screenshot-capture-before-start logic, structural map line 1147 region) then `onStarted()` to flip `app.js`'s phase state to `listening`.

- [ ] **Step 1: Build the component**

Write `public/screens/setup-screen.js` per the above, adding corresponding CSS classes to `public/style.css` (new section, comment-header it clearly e.g. `/* === Setup screen (redesign) === */`) matching the Shell file's exact visual values.

- [ ] **Step 2: Mount it from `app.js`**

Replace the old inline Setup-mode markup in `App()`'s render tree with `phase === "setup" && React.createElement(SetupScreen, {...})`. Remove the old `mode-toggle`/`sm-tab` inline JSX (structural map lines 1620-1681) and `OnboardingRibbon` (3714-3752, used at 1397) — both are fully superseded by the new Setup screen and its lifecycle model.

- [ ] **Step 3: Verify against the real backend, locally**

Use the `run` skill (or manually: `npm run dev`) to boot the real server with a local/free transcription+agent config (Moonshine + whatever free-tier agent provider is configured), and drive the Setup screen in a real browser: type a session intent, toggle multi-speaker, open/close settings and change a value, click Restore (with and without a prior session on disk), seed with pasted text, click Start listening — confirm each does what the design specifies and the server receives the expected requests (check server logs / `test/browser-smoke.test.js`-style verification).

- [ ] **Step 4: Commit**

```bash
git add public/screens/setup-screen.js public/app.js public/style.css
git commit -m "feat: real Setup screen matching the redesign

Session intent, multi-speaker toggle, restore-last-session, a
consolidated settings sheet, canvas seeding, and Start listening -
wired to the real backend, replacing the old staging-mode panel,
mode-toggle tabs, session-mode tabs, and onboarding ribbon."
```

---

## Task 9: Listening/Paused screen

**Files:**
- Create: `public/screens/listening-screen.js`
- Modify: `public/app.js` (mount the new component for `phase === "listening" | "paused"`, remove everything it replaces: the old live-mode action row, `NudgeBar`, `QuestionCard` mounting — keep the `QuestionCard` component itself if its markup already matches, or rebuild it to match — `CaptionFab`, `ZoneChip`, `PaletteRow`, `BacklogPill`'s old mounting, `QuickActions`, the old cost-card mounting)

**Interfaces:**
- Consumes: `api-client.js` (`pauseSession`, `resumeSession`, `undoTurn`, `sendNudge`, `answerQuestion`, `reviewSession` is Task 10's concern not this one — this screen's "End" button just flips phase, it does not itself call the review endpoint, that call belongs in the Review screen so it can show a loading state while the summary generates), `ws-client.js` messages already flowing into `app.js` (agent status, captions, questions, cost, zone, queue stats, `nudge:applied`/`nudge:failed`), `mic-capture.js` (indirectly, via `app.js` — this screen doesn't start/stop mic capture itself, `app.js`'s phase transitions do, but this screen shows the waveform/listening indicator).
- Produces: `ListeningScreen({ paused, statusText, zoneText, caption, question, cost, ... })` — a large prop surface since this screen aggregates most of the live-session UI; document the full prop list at the top of the file as a comment for the next reader.

Translate the Shell file's **TOP STATUS STRIP** (`TOP STATUS STRIP (1b halo)`, ~lines 225-271), **STATUS DRAWER** (~273-289), **QUESTION CARD** (~291-334), **CAPTION PILL** (~336-339), and **STEER BAR** (~341-366) sections. This is the "halo" layout (thin top strip + floating bottom steer bar), chosen over the "dock"/"satellite" alternatives shown in `Wireframes.dc.html` — the Shell file is definitive, don't second-guess the choice.

Real wiring, replacing the mockup's fake `state`:
- **State dot + label + clock** → derive from real phase (`paused` prop) and a real elapsed-time clock the component owns (started when phase enters `listening`, paused when `paused` — this timer is purely a client-side display, not from the server).
- **Listening waveform** (the four animated bars next to the state label) → only shown while actually listening (not paused); can reuse `mic-capture.js`'s `analyser` via a small canvas/bar visualization, or reuse the pattern already in the current `Waveform` component (structural map 2234-2327) restyled to the halo's compact 4-bar look rather than duplicating audio-analysis logic.
- **Status text** (`"listening"` / `"thinking"` / `"drawing the plan"` etc.) → the real `agent:status` WS message's status string, not the mockup's scripted sequence.
- **Zone chip** → the real `agent:zone` WS message (`ZoneChip`'s existing logic/markup, structural map 3697-3713, can likely be reused near-verbatim, restyled to the halo's chip look).
- **Pause/Resume button** → `api.pauseSession()` / `api.resumeSession()`.
- **Undo button** → `api.undoTurn()` (existing `handleUndoTurn`, structural map lines 437-447, logic reused, restyled).
- **End button** → flips `app.js`'s phase to `review` (stops mic capture, matching what `pauseSession` already does for audio teardown) — does NOT itself call the review endpoint (see Task 10).
- **Cost pill / status drawer** → real `cost` WS message data (existing `CostCard`/`CostRow` helpers, 2328-2412, reusable for the numbers, restyled to the drawer's compact layout) plus the captions-on toggle (existing `uiPrefs.captionsOn`-equivalent, saved via `api.saveSettings`).
- **Caption pill** → real `transcript:partial`/`transcript:committed` WS messages driving the caption text + a 4.5s auto-fade timer (matching the mockup's `capInt` interval logic, but real data).
- **Steer bar** → `api.sendNudge(text)` on submit; `applied`/`failed` visual states driven by the real `nudge:applied`/`nudge:failed` WS messages (both exist now, from the prior backend plan's Tasks 3/5) instead of the mockup's fake `failNext` toggle. The `/` keyboard shortcut to focus the steer input (existing `NudgeBar`'s `champpreso:focus-nudge` window-event pattern, structural map line 3258-3262, or the Shell's simpler direct-DOM-query approach at Shell file lines 486-489 — either is fine, keep it working) and placeholder-rotation (the Shell's `placeholderIdx` timer cycling through 5 example steers every 4s) should both be ported — this is exactly the kind of micro-interaction the pixel/motion-perfect fidelity requirement covers.
- **Question card** → real `agent:question` / `agent:question-resolved` WS messages driving `question`, `api.answerQuestion({id, text})` on submit, the 20s countdown-bar-then-auto-skip behavior (`qInt` timer in the mockup) ported with real timing, `Escape` key to skip (existing keyboard handler pattern).

Live Transcript History (mentioned in the structural map's CSS analysis as the reason for the deleted `CHAMPPRESO` patch blocks in Task 2) is not a section named in the Shell file's chrome — the redesign's Status Drawer replaces its role with the compact per-session cost/captions summary shown there. If you judge that losing the scrollable transcript history entirely is a regression worth flagging, note it in your task report as a concern rather than inventing new UI the design doesn't specify.

- [ ] **Step 1: Build the component**

Write `public/screens/listening-screen.js` and the corresponding CSS (new `style.css` section).

- [ ] **Step 2: Mount it from `app.js`**

Replace the old live-mode inline markup and the components it fully supersedes. Keep `QuestionCard`'s underlying answer/dismiss logic if reusable, restyled; same for `Waveform`, `CostCard`/`CostRow`, `ZoneChip` — reuse logic, rebuild markup/CSS to match the halo design exactly.

- [ ] **Step 3: Verify against the real backend, locally**

Drive a full live session in a real browser: speak or type a turn, watch status/zone/captions update, trigger a question (if your test setup can produce one) and answer it, send a steer and watch it apply, send a steer that's engineered to fail (e.g. empty text bypass, or mode check) and watch the failed state + retry, pause and resume, undo, and click End (confirm it transitions to Review with mic capture stopped).

- [ ] **Step 4: Commit**

```bash
git add public/screens/listening-screen.js public/app.js public/style.css
git commit -m "feat: real Listening/Paused screen matching the redesign (halo layout)

Top status strip, status drawer, caption pill, steer bar with real
applied/failed states, question card - wired to real WS messages,
replacing the old live-mode action row, nudge bar, caption FAB, quick
actions, and pattern picker."
```

---

## Task 10: Review screen

**Files:**
- Create: `public/screens/review-screen.js`
- Modify: `public/app.js` (mount the new component for `phase === "review"`, remove `ExportMenu`'s old mounting if fully superseded — check whether its export logic is reusable first)

**Interfaces:**
- Consumes: `api-client.js` (`reviewSession()` — the new endpoint from Task 1 of this plan — plus whatever the existing `exportCanvas(format)` logic uses, structural map "line 555+", for PNG/SVG export), `excalidrawApi` (for exports and for keeping the canvas editable per the design's "Reviewing. Canvas is still editable" — this means `excalidraw-sync.js`'s live sync must keep working in Review phase; verify `state.mode` stays `"live"` server-side through Review per this plan's architecture note below).
- Produces: `ReviewScreen({ excalidrawApi })` — calls `api.reviewSession()` once on mount, shows a loading state while the summary generates, then renders decisions + summary once resolved (or a graceful error state if the call fails — the backend endpoint can 500, e.g. on a provider timeout, per Task 1's third test).

**Architecture note:** entering Review is a **client-side-only** phase transition — there is no server-side "end session" call. `app.js`'s "End" handler (Task 9) stops mic capture exactly like Pause does, and sets local phase to `review`; the server's `state.mode` stays `"live"` throughout Review, which is precisely why manual canvas edits keep syncing via the existing `whiteboard:user-elements` WS path (`excalidraw-sync.js`, Task 6) with no special-casing needed — the design's "canvas still editable" claim is already true for free once Review is purely a client concept.

Translate the Shell file's **REVIEW PANEL** section (`REVIEW PANEL (1h)`, ~lines 368-412).

Real wiring, replacing the mockup's fake `state`:
- **Decisions list + summary** → `api.reviewSession()`'s response (`decisions: string[]`, `summary: string`), not the mockup's hardcoded `this.decidedAudit()`/scripted array.
- **Review title / meta** (session duration, cost, drawing count) → real client-side elapsed time (from the Listening screen's clock, threaded through or recomputed from `phase` transition timestamps) + real `cost`/turn-count state already flowing through `app.js` from WS messages.
- **PNG / SVG export** → reuse the current app's existing `exportCanvas(format)` logic (`ExportMenu`, structural map 3494-3577) — this logic doesn't need rebuilding, just re-triggering from the new buttons' `onClick`.
- **Copy summary** → `navigator.clipboard.writeText(summary)` using the real summary text from `api.reviewSession()`.
- **"Browse snapshots · soon"** → render as `disabled`, exactly like the mockup (this is intentionally a placeholder in the design itself, matching `04-BACKEND-ROADMAP.md` item 5's "Later: a Review-state UI to browse the 20 snapshots" note — do not build snapshot browsing, it's explicitly out of scope).
- **New session button** → `api.resetSession()` (or `api.backToSetup()` — check which one actually clears `state.elements`/cost/turn history per the backend; `resetSession` per the structural map's REST table is the one used in the current app's live-mode "reset" branch, likely the right one) then flip `app.js`'s phase back to `setup`.

- [ ] **Step 1: Build the component**

Write `public/screens/review-screen.js` and the corresponding CSS.

- [ ] **Step 2: Mount it from `app.js`**

Replace/extend the phase-based render tree with `phase === "review" && React.createElement(ReviewScreen, {...})`.

- [ ] **Step 3: Verify against the real backend, locally**

Run a full session (Setup → Listening → a couple of turns → End), confirm Review shows a loading state then real decisions/summary from the actual model response, confirm PNG/SVG export still produces real files, confirm Copy summary puts the real text on the clipboard, confirm New session correctly returns to a clean Setup screen. Also verify the failure path: temporarily break the review call (e.g. bad API key) and confirm the screen shows a clear error rather than hanging or crashing.

- [ ] **Step 4: Commit**

```bash
git add public/screens/review-screen.js public/app.js public/style.css
git commit -m "feat: real Review screen matching the redesign

Calls the new /api/session/review endpoint for decisions + summary,
reuses existing PNG/SVG export, adds copy-summary and new-session -
Review is a client-side-only phase, so the canvas keeps syncing live
throughout, matching the design's 'still editable' claim for free."
```

---

## Task 11: Final integration pass and cleanup

**Files:**
- Modify: `public/app.js` (should now be a thin phase-orchestrator — verify its size dropped substantially from 4061 lines; remove any remaining dead code left behind by Tasks 3-10's extractions)
- Modify: `public/style.css` (remove any remaining CSS for components fully superseded by Tasks 8-10, if not already cleaned up task-by-task)

**Interfaces:** none — this is verification and cleanup, not new functionality.

- [ ] **Step 1: Confirm `app.js`'s final shape**

`App()` should now primarily: hold `phase` state (+ the few cross-screen concerns like `cost`, `settings`, `uiPrefs` that don't cleanly belong to one screen), mount `excalidraw-sync.js`'s hooks, mount `ws-client.js`, render `<Excalidraw>` once, and render exactly one of `SetupScreen` / `ListeningScreen` / `ReviewScreen` based on `phase`. Grep for any leftover dead functions/components Tasks 3-10 should have removed but might have left behind (e.g. old `mode-toggle`/`sm-tab` remnants, unused imports).

- [ ] **Step 2: Full local smoke pass**

Using the `run` skill (or `webapp-testing` if more appropriate for a full click-through), drive the complete lifecycle end to end in a real browser against the real local server (Moonshine transcription, a free/cheap agent provider — this is explicitly the "local, working phenomenally well" bar from the original request, not yet the "online models, cost-optimized" follow-up): Setup (intent, seed, settings, restore) → Listening (speak/type, steer, question, pause/resume, undo) → Review (decisions, summary, export, new session) → back to Setup. Take screenshots at each phase and compare against the Shell design file's visual intent.

- [ ] **Step 3: Run the full test suite one last time**

Run: `npm test && npm run typecheck` — must be fully green, including `test/browser-smoke.test.js`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: final cleanup pass after the frontend redesign

app.js reduced from a 4061-line monolith to a thin phase orchestrator
mounting SetupScreen/ListeningScreen/ReviewScreen; removed remaining
dead code from the module-extraction tasks."
```

---

## Deferred / explicitly out of scope

- **Online/cloud model cost optimization** — per the original request, this plan gets the redesign working end-to-end locally first (Moonshine + a free/cheap default provider). Configuring and cost-tuning cloud providers (Groq free tier vs. OpenRouter `:free` models vs. paid providers) is explicit, separate follow-up work once this is verified working locally.
- **Snapshot browsing UI** ("Browse snapshots · soon" in the design) — intentionally deferred, matches `04-BACKEND-ROADMAP.md` item 5's own note.
- **`paused`/`review` as server-side WS `mode` values** — per the prior backend plan's Task 8, `paused` already has `capture:paused` and `review` is purely client-side in this plan's architecture (Task 10) — no server change needed or planned.
