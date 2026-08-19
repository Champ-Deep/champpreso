import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";

import { startServer } from "../src/server.js";

function makeTranscriptionMock() {
  return () => ({
    ready: async () => {},
    sendAudio: () => {},
    stop: () => {},
    setSessionContext: () => {},
    close: () => {},
  });
}

async function startTestServer(extraOptions = {}) {
  return startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: makeTranscriptionMock(),
    generateTextFn: async () => ({ text: "DONE", finishReason: "stop" }),
    streamTextFn: () => ({ consumeStream: async () => {} }),
    warmupMaxAttempts: 1,
    warmupDelays: [],
    ...extraOptions,
  });
}

async function goLive(url) {
  await fetch(`${url}/api/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stagingElements: [] }),
  });
}

function ask(url, body) {
  return fetch(`${url}/api/session/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// A board with two labelled zones and an arrow between them, so we can assert
// the ask agent is given structure rather than raw element JSON.
const BOARD = [
  { id: "z1", type: "rectangle", x: 0, y: 0, width: 300, height: 300, backgroundColor: "#ffe3e3" },
  { id: "z1h", type: "text", x: 10, y: 8, width: 200, height: 24, text: "Problems" },
  { id: "p1", type: "text", x: 20, y: 100, width: 250, height: 24, text: "Handoff has no owner" },
  { id: "z2", type: "rectangle", x: 400, y: 0, width: 300, height: 300, backgroundColor: "#d3f9d8" },
  { id: "z2h", type: "text", x: 410, y: 8, width: 200, height: 24, text: "Top bets" },
  { id: "b1", type: "text", x: 420, y: 100, width: 250, height: 24, text: "Self-serve signup" },
  {
    id: "arrow1",
    type: "arrow",
    x: 300,
    y: 150,
    width: 100,
    height: 0,
    startBinding: { elementId: "z1" },
    endBinding: { elementId: "z2" },
  },
];

test("POST /api/session/ask is rejected before the session goes live", async () => {
  const { httpServer, url } = await startTestServer();
  try {
    const res = await ask(url, { question: "what did we decide?" });
    assert.equal(res.status, 409);
  } finally {
    httpServer.close();
  }
});

test("POST /api/session/ask requires a question", async () => {
  const { httpServer, url } = await startTestServer();
  try {
    await goLive(url);
    assert.equal((await ask(url, { question: "   " })).status, 400);
    assert.equal((await ask(url, {})).status, 400);
  } finally {
    httpServer.close();
  }
});

test("the ask agent receives a structural read of the board, not raw element JSON", async () => {
  /** @type {any} */
  let captured = null;
  const { httpServer, url, state } = await startTestServer({
    askGenerateTextFn: async (opts) => {
      captured = opts;
      return { text: "The handoff problem is linked to the self-serve signup bet.", usage: {} };
    },
  });
  try {
    await goLive(url);
    state.elements = [...BOARD];

    const res = await ask(url, { question: "how do the two columns relate?" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.answer, /self-serve signup/i);

    const prompt = JSON.stringify(captured.messages ?? captured.prompt ?? "");
    // Zone names and their contents are present...
    assert.match(prompt, /Problems/);
    assert.match(prompt, /Top bets/);
    assert.match(prompt, /Handoff has no owner/);
    // ...and so is the relationship between them.
    assert.match(prompt, /Connections/);
    // The question itself made it through.
    assert.match(prompt, /how do the two columns relate/);
  } finally {
    httpServer.close();
  }
});

test("asking never mutates the canvas or the cached agent history", async () => {
  const { httpServer, url, state } = await startTestServer({
    askGenerateTextFn: async () => ({ text: "Nothing was decided about pricing yet.", usage: {} }),
  });
  try {
    await goLive(url);
    state.elements = [...BOARD];
    const historyBefore = JSON.stringify(state.agentHistory);
    const elementsBefore = JSON.stringify(state.elements);

    const res = await ask(url, { question: "what did we decide about pricing?" });
    assert.equal(res.status, 200);

    // Load-bearing: the warmup loop pins agentHistory to a fixed prefix for
    // prompt-cache reuse. An ask that appended to it would silently destroy
    // cache hits on every subsequent drawing turn.
    assert.equal(JSON.stringify(state.agentHistory), historyBefore);
    assert.equal(JSON.stringify(state.elements), elementsBefore);
  } finally {
    httpServer.close();
  }
});

test("the answer is broadcast over the websocket so the whole room sees it", async () => {
  const { httpServer, url, wsUrl, state } = await startTestServer({
    askGenerateTextFn: async () => ({ text: "Two bets are on the board.", usage: {} }),
  });
  const socket = new WebSocket(wsUrl);
  try {
    await new Promise((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });
    const received = [];
    socket.on("message", (raw) => received.push(JSON.parse(raw.toString())));

    await goLive(url);
    state.elements = [...BOARD];
    await ask(url, { question: "how many bets?" });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const answer = received.find((m) => m.type === "agent:answer");
    assert.ok(answer, `expected an agent:answer message, got ${received.map((m) => m.type).join(", ")}`);
    assert.equal(answer.question, "how many bets?");
    assert.match(answer.answer, /Two bets/);
  } finally {
    socket.close();
    httpServer.close();
  }
});

test("follow-up questions carry the previous exchange as context", async () => {
  const prompts = [];
  const { httpServer, url, state } = await startTestServer({
    askGenerateTextFn: async (opts) => {
      prompts.push(JSON.stringify(opts.messages ?? opts.prompt ?? ""));
      return { text: `answer ${prompts.length}`, usage: {} };
    },
  });
  try {
    await goLive(url);
    state.elements = [...BOARD];

    await ask(url, { question: "what are the bets?" });
    await ask(url, { question: "and which is riskiest?" });

    assert.equal(prompts.length, 2);
    // The second call can see the first question and its answer.
    assert.match(prompts[1], /what are the bets\?/);
    assert.match(prompts[1], /answer 1/);
  } finally {
    httpServer.close();
  }
});

test("the knowledge base tool is offered only when a knowledge base is configured", async () => {
  const withoutKb = await startTestServer({
    askGenerateTextFn: async (opts) => {
      assert.ok(!("search_knowledge_base" in (opts.tools ?? {})));
      return { text: "ok", usage: {} };
    },
  });
  try {
    await goLive(withoutKb.url);
    assert.equal((await ask(withoutKb.url, { question: "q" })).status, 200);
  } finally {
    withoutKb.httpServer.close();
  }

  const withKb = await startTestServer({
    knowledgeBaseFolders: [process.cwd()],
    askGenerateTextFn: async (opts) => {
      assert.ok("search_knowledge_base" in (opts.tools ?? {}));
      return { text: "ok", usage: {} };
    },
  });
  try {
    await goLive(withKb.url);
    assert.equal((await ask(withKb.url, { question: "q" })).status, 200);
  } finally {
    withKb.httpServer.close();
  }
});

test("a model failure surfaces a clean 500 rather than crashing the session", async () => {
  const { httpServer, url, state } = await startTestServer({
    askGenerateTextFn: async () => {
      throw new Error("provider timeout");
    },
  });
  try {
    await goLive(url);
    state.elements = [...BOARD];
    const res = await ask(url, { question: "anything?" });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /provider timeout/);
  } finally {
    httpServer.close();
  }
});
