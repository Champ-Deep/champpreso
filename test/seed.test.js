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
