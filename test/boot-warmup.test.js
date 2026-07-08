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
