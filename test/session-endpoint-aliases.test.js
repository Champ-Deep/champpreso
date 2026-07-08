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
