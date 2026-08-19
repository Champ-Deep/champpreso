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

test("typed turn (/api/preso/say) is live-only and queues the text as a turn", async () => {
  const { httpServer, url, state } = await startTestServer();
  try {
    const staging = await fetch(`${url}/api/preso/say`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "draw a funnel" }),
    });
    assert.equal(staging.status, 409);

    state.mode = "live";
    const queued = [];
    const realQueue = state.queueTranscript;
    state.queueTranscript = (text) => {
      queued.push(text);
      return realQueue?.(text);
    };

    const ok = await fetch(`${url}/api/preso/say`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "draw a funnel" }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(queued, ["draw a funnel"]);

    const empty = await fetch(`${url}/api/preso/say`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    assert.equal(empty.status, 400);
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

test("scoped-edit recomputes line numbers against the canvas as of execution, not as of request", async () => {
  // The scoped instruction text (e.g. "Modify ONLY lines [...]") is injected
  // into the per-turn *messages* (see formatCurrentCanvasTask in src/server.js),
  // not the system prompt - the system prompt only carries the static agent
  // instructions + staging primer. So we assert against `messages` here.
  const capturedMessages = [];
  let callCount = 0;
  const { httpServer, url, state } = await startTestServer({
    generateTextFn: async ({ messages }) => {
      callCount += 1;
      if (callCount === 1) {
        // This is the warmup call fired by /api/preso/start. Delay it so
        // there is a deterministic window, after the scoped-edit POST below
        // returns, to shift the canvas before the queued turn (which awaits
        // warmup) actually executes.
        await new Promise((r) => setTimeout(r, 50));
      } else {
        capturedMessages.push(messages);
      }
      return { text: "DONE", finishReason: "stop" };
    },
  });
  try {
    await fetch(`${url}/api/preso/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stagingElements: [] }),
    });
    state.elements = SCENE; // [a, b, c] -> "c" (Gamma) is line 3 right now

    const res = await scopedEdit(url, { selectedIds: ["c"], instruction: "make it red" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.lineNumbers[0], 3, "line 3 is correct at request time");

    // Simulate the canvas shifting BEFORE the scoped-edit turn actually runs
    // (warmup is still in flight thanks to the 50ms delay above): insert a
    // new element at the top, which pushes "c" from line 3 to line 4.
    state.elements = [
      { id: "z", type: "text", x: 0, y: -40, text: "Zero" },
      ...SCENE,
    ];

    // Now let the scoped-edit turn actually execute (it was queued by the POST
    // above, and was waiting on the delayed warmup call).
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(callCount, 2, "expected exactly one warmup call and one real turn call");
    const lastMessages = capturedMessages.at(-1);
    const messagesText = JSON.stringify(lastMessages);
    assert.match(
      messagesText,
      /Modify ONLY lines \[4\]/,
      `expected the re-validated line number (4, post-shift) in the prompt, got: ${messagesText}`,
    );
  } finally {
    httpServer.close();
  }
});
