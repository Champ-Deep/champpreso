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
