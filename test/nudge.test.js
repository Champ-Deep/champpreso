import assert from "node:assert/strict";
import { test } from "node:test";

import { createWhiteboardSession, broadcast } from "../src/whiteboard-session.js";
import { startServer } from "../src/server.js";

function makeSession() {
  return createWhiteboardSession({
    options: {},
    wss: { clients: new Set() },
    runAgent: async () => {},
  });
}

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

test("applyNudge rejection path returns false", () => {
  const broadcasts = [];
  const wss = { clients: new Set([{ readyState: 1, send: (m) => broadcasts.push(JSON.parse(m)) }]) };
  const session = createWhiteboardSession({ options: {}, wss, runAgent: async () => {} });
  const applied = session.applyNudge("  "); // empty after trim
  assert.equal(applied, false, "applyNudge should reject empty text");
});

test("POST /api/preso/nudge broadcasts nudge:failed when not live", async () => {
  const transcription = makeTranscriptionMock();
  const broadcasts2 = [];
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
  // Add a mock client to the wss BEFORE making any requests
  // @ts-ignore - mock client for testing broadcast
  wss.clients.add({ readyState: 1, send: (m) => broadcasts2.push(JSON.parse(m)) });

  try {
    // Don't start a preso, so state.mode is "staging" (not "live")
    const res = await fetch(`${url}/api/preso/nudge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "steer this" }),
    });
    assert.equal(res.status, 409);

    // Add a small delay to let the broadcast complete
    await new Promise(r => setTimeout(r, 10));

    const failedMsg = broadcasts2.find((m) => m.type === "nudge:failed");
    assert.ok(failedMsg, `expected a nudge:failed broadcast, got: ${JSON.stringify(broadcasts2)}`);
    assert.equal(failedMsg.reason, "not-live");
  } finally {
    httpServer.close();
  }
});

test("POST /api/preso/nudge broadcasts nudge:failed with reason:empty-text", async () => {
  const transcription = makeTranscriptionMock();
  const broadcasts = [];
  const { httpServer, url, wss, state } = await startServer({
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
  // @ts-ignore - mock client for testing broadcast
  wss.clients.add({ readyState: 1, send: (m) => broadcasts.push(JSON.parse(m)) });

  try {
    // Start a preso so state.mode is "live"
    await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stagingElements: [] }),
    });

    // Clear broadcasts from the start
    broadcasts.length = 0;

    // Send empty nudge text
    const res = await fetch(`${url}/api/preso/nudge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " }), // whitespace-only -> rejected
    });
    assert.equal(res.status, 400);

    // Add a small delay to let the broadcast complete
    await new Promise(r => setTimeout(r, 10));

    const failedMsg = broadcasts.find((m) => m.type === "nudge:failed");
    assert.ok(failedMsg, `expected a nudge:failed broadcast, got: ${JSON.stringify(broadcasts)}`);
    assert.equal(failedMsg.reason, "empty-text");
  } finally {
    httpServer.close();
  }
});
