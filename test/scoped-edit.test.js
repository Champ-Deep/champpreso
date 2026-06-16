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
  const defaults = {
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: transcription.factory,
    generateTextFn: async () => ({ text: "DONE", finishReason: "stop" }),
    streamTextFn: () => ({ consumeStream: async () => {} }),
    warmupMaxAttempts: 1,
    warmupDelays: [],
  };
  return startServer({ ...defaults, ...extraOptions });
}

const SCENE = [
  { id: "a", type: "text", x: 0, y: 0, text: "Alpha" },
  { id: "b", type: "rectangle", x: 0, y: 40, width: 100, height: 40 },
  { id: "c", type: "text", x: 0, y: 100, text: "Gamma" },
];

async function scopedEdit(url, body) {
  return fetch(`${url}/api/preso/scoped-edit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("scoped-edit is rejected outside live mode", async () => {
  const { httpServer, url } = await startTestServer();
  try {
    const res = await scopedEdit(url, { selectedIds: ["a"], instruction: "make it bold" });
    assert.equal(res.status, 409);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("scoped-edit maps selected ids to 1-based line numbers and accepts the turn", async () => {
  const { httpServer, url, state } = await startTestServer();
  try {
    state.mode = "live";
    state.elements = SCENE;

    const res = await scopedEdit(url, { selectedIds: ["c", "a"], instruction: "rename these" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.selectedIds, ["c", "a"]);
    assert.deepEqual(body.lineNumbers, [1, 3]);
    assert.equal(body.instruction, "rename these");
    // Let the queued turn settle so it doesn't run against a closed server.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("scoped-edit validates selection and instruction", async () => {
  const { httpServer, url, state } = await startTestServer();
  try {
    state.mode = "live";
    state.elements = SCENE;

    const noSel = await scopedEdit(url, { selectedIds: [], instruction: "x" });
    assert.equal(noSel.status, 400);

    const noInstr = await scopedEdit(url, { selectedIds: ["a"], instruction: "  " });
    assert.equal(noInstr.status, 400);

    const offCanvas = await scopedEdit(url, { selectedIds: ["nope"], instruction: "x" });
    assert.equal(offCanvas.status, 400);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
