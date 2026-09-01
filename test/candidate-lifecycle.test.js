// @ts-nocheck - injected fakes for generateText return simplified shapes.
// Candidate lifecycle: the board shows its own confidence. Elements born in a
// "hypothesis" turn render dashed at 50% opacity; they solidify when the
// conversation (or the user) confirms them and quietly expire if the room
// moves on. Status lives in a server-side registry (state.candidates), NOT in
// element customData - the frontend sync strips customData on echo.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectUserTouchedCandidates,
  expireStaleCandidates,
  markNewCandidates,
  promoteCandidates,
} from "../src/candidate-lifecycle.js";
import { runWhiteboardAgent, whiteboardSystemPrompt, buildWhiteboardAgentMessages } from "../src/server.js";
import { createWhiteboardSession } from "../src/whiteboard-session.js";

const rect = (id, extra = {}) => ({ type: "rectangle", id, x: 0, y: 0, width: 120, height: 60, ...extra });

// ---- pure module -----------------------------------------------------------

test("markNewCandidates marks only elements born this turn, dashed at 50%, stashing the original style", () => {
  const before = new Set(["old"]);
  const elements = [rect("old", { strokeStyle: "solid" }), rect("fresh", { backgroundColor: "#FFF4EC" })];
  const { elements: marked, candidates } = markNewCandidates({
    beforeIds: before,
    elements,
    candidates: new Map(),
    turn: 3,
  });
  const fresh = marked.find((el) => el.id === "fresh");
  assert.equal(fresh.strokeStyle, "dashed");
  assert.equal(fresh.opacity, 50);
  const old = marked.find((el) => el.id === "old");
  assert.equal(old.strokeStyle, "solid", "pre-existing elements are untouched");
  assert.ok(candidates.has("fresh"));
  assert.equal(candidates.get("fresh").bornTurn, 3);
  assert.deepEqual(candidates.get("fresh").orig, { strokeStyle: undefined, opacity: undefined });
  assert.ok(!candidates.has("old"));
});

test("promoteCandidates restores the stashed style and drops the registry entry", () => {
  const candidates = new Map([["c1", { bornTurn: 1, orig: { strokeStyle: "solid", opacity: 100 } }]]);
  const elements = [rect("c1", { strokeStyle: "dashed", opacity: 50 })];
  const { elements: out, candidates: rest } = promoteCandidates({ elements, candidates, ids: ["c1"] });
  const el = out.find((e) => e.id === "c1");
  assert.equal(el.strokeStyle, "solid");
  assert.equal(el.opacity, 100);
  assert.equal(rest.size, 0);
});

test("promoteCandidates removes an undefined original style key instead of writing undefined", () => {
  const candidates = new Map([["c1", { bornTurn: 1, orig: { strokeStyle: undefined, opacity: undefined } }]]);
  const elements = [rect("c1", { strokeStyle: "dashed", opacity: 50 })];
  const { elements: out } = promoteCandidates({ elements, candidates, ids: ["c1"] });
  const el = out.find((e) => e.id === "c1");
  assert.ok(!("strokeStyle" in el), "style the element never had must not linger");
  assert.ok(!("opacity" in el));
});

test("expireStaleCandidates deletes untouched unpinned candidates older than two turns and prunes orphans", () => {
  const candidates = new Map([
    ["stale", { bornTurn: 1, orig: {} }],
    ["young", { bornTurn: 3, orig: {} }],
    ["pinned", { bornTurn: 1, orig: {} }],
    ["orphan", { bornTurn: 1, orig: {} }],
  ]);
  const elements = [rect("stale"), rect("young"), rect("pinned")];
  const { elements: out, candidates: rest, expiredIds } = expireStaleCandidates({
    elements,
    candidates,
    turn: 3,
    pinnedIds: new Set(["pinned"]),
  });
  assert.deepEqual(expiredIds, ["stale"]);
  assert.ok(!out.some((el) => el.id === "stale"));
  assert.ok(out.some((el) => el.id === "young"));
  assert.ok(out.some((el) => el.id === "pinned"), "pinned candidates are never auto-deleted");
  assert.ok(rest.has("young"));
  assert.ok(rest.has("pinned"));
  assert.ok(!rest.has("orphan"), "registry entries whose element vanished are pruned");
});

test("detectUserTouchedCandidates flags candidates whose meaningful props the user changed", () => {
  const candidates = new Map([
    ["moved", { bornTurn: 1, orig: {} }],
    ["still", { bornTurn: 1, orig: {} }],
  ]);
  const prev = [rect("moved"), rect("still"), rect("other")];
  const next = [rect("moved", { x: 300 }), rect("still"), rect("other", { x: 999 })];
  const touched = detectUserTouchedCandidates({ prevElements: prev, nextElements: next, candidates });
  assert.deepEqual(touched, ["moved"], "only candidate elements count, only when they changed");
});

// ---- integration -----------------------------------------------------------

function makeHarness() {
  const sent = [];
  const wss = { clients: new Set([{ readyState: 1, send: (m) => sent.push(JSON.parse(m)) }]) };
  return { sent, wss };
}

const baseOptions = { openaiApiKey: "test", agentProvider: { provider: "openai", model: "gpt-test", apiKey: "k", baseURL: "http://x" } };

function drawingRunAgent(elementFactory) {
  return ({ transcript, state, wss }) =>
    runWhiteboardAgent({
      transcript,
      state,
      wss,
      options: baseOptions,
      generateTextFn: async (opts) => {
        const el = elementFactory?.(state);
        if (el) {
          await opts.tools.whiteboard_apply.execute(
            { intent: "draw it", operations: [{ type: "insert_after", line: state.elements.length, element: el }] },
            { toolCallId: "t" },
          );
        }
        return { text: "DONE" };
      },
      streamTextFn: () => ({ consumeStream: async () => {} }),
    });
}

test("a hypothesis turn births candidates; a decision turn touching them solidifies; stale ones expire", async () => {
  const { sent, wss } = makeHarness();
  let salienceForNext = "hypothesis";
  let drawNext = () => rect("idea-1", { backgroundColor: "#FFF4EC" });
  const runAgent = ({ transcript, state, wss: w }) =>
    runWhiteboardAgent({
      transcript,
      state,
      wss: w,
      options: baseOptions,
      generateTextFn: async (opts) => {
        const el = drawNext(state);
        if (el) {
          const op = el.replace
            ? { type: "replace", line: el.line, element: el.element }
            : { type: "insert_after", line: state.elements.length, element: el };
          await opts.tools.whiteboard_apply.execute({ intent: "draw", operations: [op] }, { toolCallId: "t" });
        }
        return { text: "DONE" };
      },
      streamTextFn: () => ({ consumeStream: async () => {} }),
    });
  const state = createWhiteboardSession({
    options: { classifySalience: async () => ({ salience: salienceForNext }), gateTimeoutMs: 60 },
    wss,
    runAgent,
  });
  state.startPreso({ primerMessage: { role: "user", content: "primer" } });

  // Turn 1: hypothesis births a candidate.
  await state.queueTranscript("maybe we bundle it into the Pro tier");
  await state.idle();
  let idea = state.elements.find((el) => el.id === "idea-1");
  assert.ok(idea, "the hypothesis was drawn");
  assert.equal(idea.strokeStyle, "dashed");
  assert.equal(idea.opacity, 50);
  assert.ok(state.candidates.has("idea-1"));

  // Turn 2: decision turn REPLACES the candidate -> promoted to committed.
  salienceForNext = "decision";
  drawNext = (s) => ({
    replace: true,
    line: s.elements.findIndex((el) => el.id === "idea-1") + 1,
    element: rect("idea-1", { backgroundColor: "#FFF4EC" }),
  });
  await state.queueTranscript("yes, we're going with the Pro tier bundle");
  await state.idle();
  idea = state.elements.find((el) => el.id === "idea-1");
  assert.ok(!("strokeStyle" in idea) || idea.strokeStyle !== "dashed", "confirmed candidate solidifies");
  assert.ok(!state.candidates.has("idea-1"));

  // Turns 3-5: a second candidate is born and then ignored for two turns -> expires.
  salienceForNext = "hypothesis";
  drawNext = () => rect("idea-2");
  await state.queueTranscript("or maybe a separate add-on product");
  await state.idle();
  assert.ok(state.candidates.has("idea-2"));
  salienceForNext = "decision";
  drawNext = () => null;
  await state.queueTranscript("anyway the migration is the priority");
  await state.idle();
  await state.queueTranscript("and staffing comes after the migration");
  await state.idle();
  assert.ok(!state.elements.some((el) => el.id === "idea-2"), "unconfirmed candidate expired");
  assert.ok(!state.candidates.has("idea-2"));
  assert.ok(sent.some((m) => m.type === "candidate:expired" && m.ids.includes("idea-2")), "expiry is narrated");
});

test("pinning a candidate promotes it immediately", async () => {
  const { wss } = makeHarness();
  const state = createWhiteboardSession({ options: {}, wss, runAgent: async () => {} });
  state.startPreso({ primerMessage: { role: "user", content: "primer" } });
  state.elements = [rect("c1", { strokeStyle: "dashed", opacity: 50 })];
  state.candidates.set("c1", { bornTurn: 1, orig: { strokeStyle: undefined, opacity: undefined } });
  state.pinElement("c1");
  assert.ok(!state.candidates.has("c1"), "pinning is the strongest possible confirmation");
  const el = state.elements.find((e) => e.id === "c1");
  assert.notEqual(el.strokeStyle, "dashed");
});

test("the canvas task message carries a SALIENCE line only when the gate tagged the turn", () => {
  const withSalience = buildWhiteboardAgentMessages({
    agentHistory: [],
    elements: [],
    transcript: "maybe",
    state: { turnSalience: "hypothesis" },
  });
  assert.match(withSalience[1].content, /SALIENCE: hypothesis/);
  const without = buildWhiteboardAgentMessages({
    agentHistory: [],
    elements: [],
    transcript: "hello",
    state: { turnSalience: null },
  });
  assert.doesNotMatch(without[1].content, /SALIENCE/);
});

test("the system prompt teaches the candidate visual language", () => {
  const prompt = whiteboardSystemPrompt();
  assert.match(prompt, /CANDIDATE/i);
  assert.match(prompt, /dashed/);
  assert.doesNotMatch(prompt, /customData/, "status is server-side; the model never manages it");
});
