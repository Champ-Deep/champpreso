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

test("Start Preso while boot warmup is still in-flight starts a genuinely fresh warmup loop", async () => {
  const transcription = makeTranscriptionMock();
  let calls = 0;
  const { httpServer, url, state } = await startServer({
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
    warmupMaxAttempts: 3,
    // Long inter-attempt backoff so the boot loop is still parked in its
    // sleep (not exhausted, not confirmed) when Start Preso is called below -
    // this is the race window where the stale-promise bug bites.
    warmupDelays: [2000, 2000],
  });
  try {
    // Let the boot warmup fire its first attempt and settle into its
    // long between-attempt sleep.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, 1, "boot warmup should have fired its first attempt");
    assert.equal(state.warmupBusy, true, "boot warmup loop should still be in flight (sleeping between attempts)");

    const res = await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stagingElements: [] }),
    });
    assert.equal(res.status, 200);

    // Give a freshly-started loop time to fire an attempt. This window is
    // well under the boot loop's own 2s backoff, so calls only advance here
    // if Start Preso actually cancelled the stale boot loop and kicked off
    // a new one - not if it silently reused the stale boot promise.
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(
      calls >= 2,
      "expected Start Preso to fire a fresh warmup attempt for the real session instead of silently reusing the stale boot-loop promise",
    );
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

test("alwaysWarm: true re-warms (debounced) when agentInstructions changes via PUT /api/settings, before Start listening", async () => {
  const transcription = makeTranscriptionMock();
  const seenInstructions = [];

  // Build a minimal but valid settings store
  const settings = {
    agent: {
      provider: "openai",
      openai: { model: "gpt-5.5", reasoningEffort: "low" },
    },
    transcription: {
      provider: "moonshine",
      moonshine: { model: "medium" },
      openai: { model: "gpt-realtime-whisper" },
    },
    apiKeys: { openai: "sk-test" },
    agentInstructions: "Get to a concrete Q3 plan",
  };

  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: transcription.factory,
    alwaysWarm: true,
    reWarmDebounceMs: 10,
    settingsStore: {
      load: async () => settings,
      save: async (patch) => Object.assign(settings, patch),
      getSanitized: async () => {
        const { apiKeys, ...rest } = settings;
        return rest;
      },
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
