// @ts-nocheck - hand-rolled fakes (WS clients, classifier stubs) do not satisfy the lib types.
// The salience gate: decides WHEN a transcript chunk fires a drawing turn,
// never what the agent gets to know. Gated speech buffers into the next
// salient turn's context (the Granola standard) instead of being discarded.
// Fail-open everywhere: a broken gate must never mute the product.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createSalienceClassifier, maxSalience } from "../src/salience-gate.js";
import { createWhiteboardSession } from "../src/whiteboard-session.js";

function makeSession({ classifySalience, runAgent = async () => {}, options = {} } = {}) {
  const sent = [];
  const wss = {
    clients: new Set([{ readyState: 1, send: (m) => sent.push(JSON.parse(m)) }]),
  };
  const session = createWhiteboardSession({
    options: { classifySalience, gateTimeoutMs: 60, ...options },
    wss,
    runAgent,
  });
  session.startPreso({ primerMessage: { role: "user", content: "primer" } });
  return { session, sent };
}

async function settle() {
  // Let queued microtasks + the 0ms queue debounce fire.
  await new Promise((r) => setTimeout(r, 25));
}

// ---- classifier ------------------------------------------------------------

test("createSalienceClassifier calls Groq chat completions and parses the one-word verdict", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: "chaff" } }] }),
    };
  };
  const classify = createSalienceClassifier({ apiKey: "gsk_test", fetchImpl });
  const verdict = await classify({ transcript: "did anyone watch the game", sessionIntent: "Q4 pricing" });
  assert.equal(verdict.salience, "chaff");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /chat\/completions/);
  assert.match(JSON.stringify(calls[0].init.messages), /did anyone watch the game/);
  assert.match(JSON.stringify(calls[0].init.messages), /Q4 pricing/);
});

test("createSalienceClassifier throws on a verdict outside the vocabulary", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "banana" } }] }),
  });
  const classify = createSalienceClassifier({ apiKey: "gsk_test", fetchImpl });
  await assert.rejects(() => classify({ transcript: "x" }));
});

test("maxSalience ranks decision > hypothesis > chaff", () => {
  assert.equal(maxSalience("chaff", "decision"), "decision");
  assert.equal(maxSalience("hypothesis", "chaff"), "hypothesis");
  assert.equal(maxSalience(null, "hypothesis"), "hypothesis");
  assert.equal(maxSalience("decision", "hypothesis"), "decision");
});

// ---- session routing -------------------------------------------------------

test("chaff buffers without firing a turn, then rides along as context on the next salient chunk", async () => {
  const turns = [];
  const verdicts = { "did anyone watch the game last night": "chaff", "let's bundle it into the Pro tier": "decision" };
  const { session, sent } = makeSession({
    classifySalience: async ({ transcript }) => ({ salience: verdicts[transcript] }),
    runAgent: async ({ transcript, state }) => turns.push({ transcript, salience: state.turnSalience }),
  });

  await session.queueTranscript("did anyone watch the game last night");
  await settle();
  assert.equal(turns.length, 0, "chaff must not fire a drawing turn");
  const noted = sent.find((m) => m.type === "salience:noted");
  assert.ok(noted, "gated chunk must be narrated, not silently swallowed");
  assert.match(noted.text, /watch the game/);

  await session.queueTranscript("let's bundle it into the Pro tier");
  await settle();
  assert.equal(turns.length, 1, "salient chunk fires exactly one turn");
  assert.match(turns[0].transcript, /watch the game last night/);
  assert.match(turns[0].transcript, /bundle it into the Pro tier/);
  assert.ok(
    turns[0].transcript.indexOf("watch the game") < turns[0].transcript.indexOf("Pro tier"),
    "buffered context must precede the salient chunk",
  );
  assert.equal(turns[0].salience, "decision");
});

test("hypothesis fires a turn tagged hypothesis", async () => {
  const turns = [];
  const { session } = makeSession({
    classifySalience: async () => ({ salience: "hypothesis" }),
    runAgent: async ({ transcript, state }) => turns.push({ transcript, salience: state.turnSalience }),
  });
  await session.queueTranscript("maybe we could split onboarding into two tracks");
  await settle();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].salience, "hypothesis");
});

test("classifier failure fails open: the turn fires as committed, exactly like today", async () => {
  const turns = [];
  const { session } = makeSession({
    classifySalience: async () => { throw new Error("groq down"); },
    runAgent: async ({ transcript, state }) => turns.push({ transcript, salience: state.turnSalience }),
  });
  await session.queueTranscript("pricing is the real tension here");
  await settle();
  assert.equal(turns.length, 1, "a broken gate must never mute the product");
  assert.equal(turns[0].salience, "decision", "fail-open marks committed so nothing auto-expires later");
});

test("classifier hang fails open after the gate timeout", async () => {
  const turns = [];
  const { session } = makeSession({
    classifySalience: () => new Promise(() => {}),
    runAgent: async ({ transcript }) => turns.push(transcript),
  });
  await session.queueTranscript("we should map the funnel");
  await new Promise((r) => setTimeout(r, 140));
  assert.equal(turns.length, 1, "hanging classifier must not stall the turn");
});

test("typed and scoped turns bypass the gate entirely", async () => {
  let classifierCalls = 0;
  const turns = [];
  const { session } = makeSession({
    classifySalience: async () => { classifierCalls += 1; return { salience: "chaff" }; },
    runAgent: async ({ transcript }) => turns.push(transcript),
  });
  await session.queueTranscript("draw a 2x2 of effort vs impact", { bypassGate: true });
  await settle();
  assert.equal(classifierCalls, 0, "the user typed it on purpose; gating it would be insubordinate");
  assert.equal(turns.length, 1);
});

test("without a classifier configured the pipeline behaves exactly as today", async () => {
  const turns = [];
  const { session } = makeSession({
    classifySalience: undefined,
    runAgent: async ({ transcript, state }) => turns.push({ transcript, salience: state.turnSalience }),
  });
  await session.queueTranscript("ship the beta on Friday");
  await settle();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].salience, null, "no gate, no salience tag - legacy behaviour");
});

test("trivial filler is never sent to the classifier", async () => {
  let classifierCalls = 0;
  const { session } = makeSession({
    classifySalience: async () => { classifierCalls += 1; return { salience: "decision" }; },
  });
  await session.queueTranscript("uh");
  await settle();
  assert.equal(classifierCalls, 0, "filler is handled by the existing isReady gate for free");
});

test("chunks route in arrival order even when a later classification resolves first", async () => {
  const turns = [];
  let resolveFirst;
  const first = new Promise((r) => { resolveFirst = r; });
  let call = 0;
  const { session } = makeSession({
    classifySalience: () => {
      call += 1;
      if (call === 1) return first; // slow chaff
      return Promise.resolve({ salience: "decision" }); // fast decision
    },
    runAgent: async ({ transcript }) => turns.push(transcript),
  });
  const p1 = session.queueTranscript("also my flight got delayed this morning");
  const p2 = session.queueTranscript("we're going with usage-based pricing");
  resolveFirst({ salience: "chaff" });
  await Promise.all([p1, p2]);
  await settle();
  assert.equal(turns.length, 1);
  assert.ok(
    turns[0].indexOf("flight got delayed") < turns[0].indexOf("usage-based pricing"),
    "arrival order must survive out-of-order classifier latencies",
  );
});

test("ending the session clears the pending gate buffer", async () => {
  const turns = [];
  const { session } = makeSession({
    classifySalience: async ({ transcript }) => ({
      salience: transcript.includes("game") ? "chaff" : "decision",
    }),
    runAgent: async ({ transcript }) => turns.push(transcript),
  });
  await session.queueTranscript("did you catch the game");
  await settle();
  session.startPreso({ primerMessage: { role: "user", content: "primer2" } });
  await session.queueTranscript("kick off the migration Monday");
  await settle();
  assert.equal(turns.length, 1);
  assert.doesNotMatch(turns[0], /game/, "a previous session's chaff must not leak into the next");
});

// ---- server wiring ---------------------------------------------------------

import { startServer } from "../src/server.js";
import { DEFAULT_SETTINGS } from "../src/settings-store.js";

test("gate.enabled defaults on in settings", () => {
  assert.equal(DEFAULT_SETTINGS.gate.enabled, true);
});

test("POST /api/session/say bypasses the gate at the endpoint", async () => {
  let classifierCalls = 0;
  let turns = 0;
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, setSessionContext: () => {}, close: () => {} }),
    generateTextFn: async () => { turns += 1; return { text: "DONE", finishReason: "stop" }; },
    streamTextFn: () => ({ consumeStream: async () => {} }),
    warmupMaxAttempts: 1,
    warmupDelays: [],
    classifySalience: async () => { classifierCalls += 1; return { salience: "chaff" }; },
  });
  try {
    await fetch(`${url}/api/session/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stagingElements: [] }) });
    const res = await fetch(`${url}/api/session/say`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "draw the funnel" }),
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(classifierCalls, 0, "typed turns must not be gated");
    assert.ok(turns >= 1, "the typed turn must reach the agent");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("startServer wires a default classifier from settings (groq key + salienceFetch)", async () => {
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings.apiKeys.groq = "gsk_fixture";
  const settingsStore = {
    load: async () => settings,
    save: async (p) => Object.assign(settings, p),
    getSanitized: async () => ({ ...settings, apiKeys: undefined }),
  };
  const fetchCalls = [];
  const { httpServer, state, wss } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    settingsStore,
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, setSessionContext: () => {}, close: () => {} }),
    generateTextFn: async () => ({ text: "DONE", finishReason: "stop" }),
    streamTextFn: () => ({ consumeStream: async () => {} }),
    warmupMaxAttempts: 1,
    warmupDelays: [],
    salienceFetch: async (u, init) => {
      fetchCalls.push({ u, init });
      return { ok: true, json: async () => ({ choices: [{ message: { content: "chaff" } }] }) };
    },
  });
  try {
    const sent = [];
    wss.clients.add({ readyState: 1, send: (m) => sent.push(JSON.parse(m)) });
    state.startPreso({ primerMessage: { role: "user", content: "primer" } });
    await state.queueTranscript("anyway how was the weekend everyone");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(fetchCalls.length, 1, "default classifier must call the injected salience fetch");
    assert.ok(sent.some((m) => m.type === "salience:noted"), "chaff must be narrated over WS");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("default classifier stays inert without a groq key in settings", async () => {
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings.apiKeys.openai = "sk-fixture"; // so the drawing provider resolves; groq stays empty
  const settingsStore = {
    load: async () => settings,
    save: async (p) => Object.assign(settings, p),
    getSanitized: async () => ({ ...settings, apiKeys: undefined }),
  };
  let turns = 0;
  const { httpServer, state } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    settingsStore,
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, setSessionContext: () => {}, close: () => {} }),
    generateTextFn: async () => { turns += 1; return { text: "DONE", finishReason: "stop" }; },
    streamTextFn: () => ({ consumeStream: async () => {} }),
    warmupMaxAttempts: 1,
    warmupDelays: [],
    salienceFetch: async () => { throw new Error("must not be called without a key"); },
  });
  try {
    state.startPreso({ primerMessage: { role: "user", content: "primer" } });
    await state.queueTranscript("we decided to ship Friday");
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(turns >= 1, "keyless setups keep today's ungated behaviour");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
