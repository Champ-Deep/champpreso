// @ts-nocheck - injected fakes for generateText return simplified shapes.
// Intent narration: the reason ships with the edit. Every drawing tool call
// carries a required <=60-char `intent`, and the server composes agent:intent
// WS messages so a turn that draws nothing - or fails - still gets words.
import assert from "node:assert/strict";
import { test } from "node:test";

import { runWhiteboardAgent } from "../src/server.js";
import { createWhiteboardSession } from "../src/whiteboard-session.js";

function makeHarness() {
  const sent = [];
  const wss = {
    clients: new Set([{ readyState: 1, send: (m) => sent.push(JSON.parse(m)) }]),
  };
  return { sent, wss };
}

function makeState(wss, runAgent = async () => {}) {
  const state = createWhiteboardSession({ options: {}, wss, runAgent });
  state.startPreso({ primerMessage: { role: "user", content: "primer" } });
  return state;
}

const baseOptions = { openaiApiKey: "test", agentProvider: { provider: "openai", model: "gpt-test", apiKey: "k", baseURL: "http://x" } };

test("drawing tools require a short intent; ask_user_question does not", async () => {
  const { wss } = makeHarness();
  const state = makeState(wss);
  let captured = null;
  await runWhiteboardAgent({
    transcript: "map the funnel",
    state,
    wss,
    options: baseOptions,
    generateTextFn: async (opts) => { captured = opts; return { text: "DONE" }; },
    streamTextFn: () => ({ consumeStream: async () => {} }),
  });
  for (const name of ["whiteboard_apply", "whiteboard_overwrite", "render_mermaid"]) {
    const schema = captured.tools[name].inputSchema;
    const missing = schema.safeParse(name === "whiteboard_apply"
      ? { viewport: { action: "reset_zoom" } }
      : name === "whiteboard_overwrite"
        ? { elements: [] }
        : { syntax: "flowchart TD\nA-->B", anchor: { x: 0, y: 0 } });
    assert.equal(missing.success, false, `${name} must reject a call without intent`);
    const withIntent = schema.safeParse(name === "whiteboard_apply"
      ? { viewport: { action: "reset_zoom" }, intent: "recenter the view" }
      : name === "whiteboard_overwrite"
        ? { elements: [], intent: "clear for a fresh start" }
        : { syntax: "flowchart TD\nA-->B", anchor: { x: 0, y: 0 }, intent: "draw the funnel" });
    assert.equal(withIntent.success, true, `${name} must accept a call with intent`);
    const tooLong = schema.safeParse({ viewport: { action: "reset_zoom" }, intent: "x".repeat(80) });
    if (name === "whiteboard_apply") assert.equal(tooLong.success, false, "intent is capped at 60 chars");
  }
  const q = captured.tools.ask_user_question.inputSchema.safeParse({ question: "who is Sunil?" });
  assert.equal(q.success, true, "ask_user_question needs no intent - it draws nothing");
});

test("executing a drawing tool broadcasts agent:intent phase drawing with the intent text", async () => {
  const { sent, wss } = makeHarness();
  const state = makeState(wss);
  await runWhiteboardAgent({
    transcript: "pricing is the tension",
    state,
    wss,
    options: baseOptions,
    generateTextFn: async (opts) => {
      await opts.tools.whiteboard_apply.execute(
        { intent: "effort vs impact 2x2", viewport: { action: "reset_zoom" } },
        { toolCallId: "t1" },
      );
      return { text: "DONE" };
    },
    streamTextFn: () => ({ consumeStream: async () => {} }),
  });
  const drawing = sent.find((m) => m.type === "agent:intent" && m.phase === "drawing");
  assert.ok(drawing, "drawing must be narrated");
  assert.equal(drawing.intent, "effort vs impact 2x2");
});

test("a turn that draws nothing reports idle with noop:true", async () => {
  const { sent, wss } = makeHarness();
  const runAgent = ({ transcript, state: s, wss: w, options }) =>
    runWhiteboardAgent({
      transcript,
      state: s,
      wss: w,
      options: baseOptions,
      generateTextFn: async () => ({ text: "DONE" }),
      streamTextFn: () => ({ consumeStream: async () => {} }),
    });
  const state = makeState(wss, runAgent);
  await state.queueTranscript("nothing much really");
  await state.idle();
  const thinking = sent.find((m) => m.type === "agent:intent" && m.phase === "thinking");
  assert.ok(thinking, "turn start must be narrated");
  assert.match(thinking.heard, /nothing much really/);
  const idle = sent.find((m) => m.type === "agent:intent" && m.phase === "idle");
  assert.ok(idle, "turn end must be narrated");
  assert.equal(idle.noop, true, "a no-op turn must say so instead of being invisible");
});

test("a turn that draws reports idle with noop:false", async () => {
  const { sent, wss } = makeHarness();
  const runAgent = ({ transcript, state: s, wss: w }) =>
    runWhiteboardAgent({
      transcript,
      state: s,
      wss: w,
      options: baseOptions,
      generateTextFn: async (opts) => {
        await opts.tools.whiteboard_apply.execute(
          {
            intent: "capture the decision",
            operations: [{ type: "insert_after", line: 0, element: { type: "rectangle", id: "r1", x: 0, y: 0, width: 100, height: 60 } }],
          },
          { toolCallId: "t1" },
        );
        return { text: "DONE" };
      },
      streamTextFn: () => ({ consumeStream: async () => {} }),
    });
  const state = makeState(wss, runAgent);
  await state.queueTranscript("we will ship on Friday");
  await state.idle();
  const idle = sent.find((m) => m.type === "agent:intent" && m.phase === "idle");
  assert.ok(idle);
  assert.equal(idle.noop, false);
});

test("the system prompt teaches the intent parameter", async () => {
  const { whiteboardSystemPrompt } = await import("../src/server.js");
  const prompt = whiteboardSystemPrompt();
  assert.match(prompt, /"intent"/);
  assert.match(prompt, /shown live/i);
});

test("a failed turn reports phase error with the transcript for retry", async () => {
  const { sent, wss } = makeHarness();
  const runAgent = ({ transcript, state: s, wss: w }) =>
    runWhiteboardAgent({
      transcript,
      state: s,
      wss: w,
      options: baseOptions,
      generateTextFn: async () => { throw new Error("model timed out"); },
      streamTextFn: () => ({ consumeStream: async () => {} }),
    });
  const state = makeState(wss, runAgent);
  await state.queueTranscript("the important decision text");
  await state.idle();
  const err = sent.find((m) => m.type === "agent:intent" && m.phase === "error");
  assert.ok(err, "a failed turn must not look like a turn that never happened");
  assert.match(err.error, /timed out/);
  assert.equal(err.retryable, true);
  assert.match(err.heard, /important decision/, "the error must carry what was heard so Try Again can resend it");
});
