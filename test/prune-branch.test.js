// @ts-nocheck - server harness uses hand-rolled fakes.
// Prune branch: kill a thread and everything downstream of it in one action.
// readBoardStructure already derives the arrow graph; this walks it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { computeDownstreamSubtree } from "../src/whiteboard-semantics.js";
import { startServer } from "../src/server.js";

const box = (id, x, y, extra = {}) => ({ type: "rectangle", id, x, y, width: 120, height: 60, ...extra });
const arrow = (id, fromId, toId) => ({
  type: "arrow",
  id,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  points: [[0, 0], [10, 10]],
  startBinding: { elementId: fromId },
  endBinding: { elementId: toId },
});

test("computeDownstreamSubtree walks arrows from the root and takes the branch edges along", () => {
  const elements = [
    box("root", 0, 0),
    box("a", 200, 0),
    box("b", 400, 0),
    box("sibling", 0, 200),
    arrow("e1", "root", "a"),
    arrow("e2", "a", "b"),
    arrow("e3", "sibling", "root"), // incoming edge from a kept node - dangles, so it goes too
  ];
  const result = computeDownstreamSubtree(elements, "root");
  assert.deepEqual([...result.nodeIds].sort(), ["a", "b", "root"]);
  assert.deepEqual([...result.arrowIds].sort(), ["e1", "e2", "e3"]);
  assert.ok(!result.allIds.has("sibling"), "the source of an incoming edge survives");
  assert.equal(result.shapes, 3);
  assert.equal(result.arrows, 3);
});

test("computeDownstreamSubtree takes bound labels of removed nodes along", () => {
  const elements = [
    box("root", 0, 0, { boundElements: [{ type: "text", id: "root-label" }] }),
    { type: "text", id: "root-label", containerId: "root", x: 10, y: 10, text: "Bundle into Pro tier" },
    box("kept", 400, 400),
  ];
  const result = computeDownstreamSubtree(elements, "root");
  assert.ok(result.allIds.has("root-label"), "a shape's bound label cannot outlive the shape");
  assert.equal(result.shapes, 1, "bound labels do not count as shapes");
});

test("computeDownstreamSubtree spares pinned downstream nodes and stops walking through them", () => {
  const elements = [
    box("root", 0, 0),
    box("pinned-child", 200, 0),
    box("grandchild", 400, 0),
    arrow("e1", "root", "pinned-child"),
    arrow("e2", "pinned-child", "grandchild"),
  ];
  const result = computeDownstreamSubtree(elements, "root", { pinnedIds: new Set(["pinned-child"]) });
  assert.ok(!result.allIds.has("pinned-child"), "pinned content is never pruned implicitly");
  assert.ok(!result.allIds.has("grandchild"), "the walk must not pass through a spared node");
  assert.ok(result.arrowIds.has("e1"), "the edge into the spared node dangles and is removed");
  assert.ok(!result.arrowIds.has("e2"));
});

test("computeDownstreamSubtree takes the contents of a removed container along", () => {
  const elements = [
    box("zone", 0, 0, { width: 600, height: 400 }),
    box("inside", 40, 40),
    box("outside", 900, 900),
  ];
  const result = computeDownstreamSubtree(elements, "zone");
  assert.ok(result.allIds.has("inside"), "pruning a container prunes its contents");
  assert.ok(!result.allIds.has("outside"));
});

// ---- endpoints -------------------------------------------------------------

async function startPruneServer() {
  const sent = [];
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    createTranscription: () => ({ ready: async () => {}, sendAudio: () => {}, stop: () => {}, setSessionContext: () => {}, close: () => {} }),
    generateTextFn: async () => ({ text: "DONE", finishReason: "stop" }),
    streamTextFn: () => ({ consumeStream: async () => {} }),
    warmupMaxAttempts: 1,
    warmupDelays: [],
  });
  server.wss.clients.add({ readyState: 1, send: (m) => sent.push(JSON.parse(m)) });
  return { ...server, sent };
}

test("prune endpoints preview and remove a branch atomically, undoably, narrated", async () => {
  const { httpServer, url, state, sent } = await startPruneServer();
  try {
    state.startPreso({ primerMessage: { role: "user", content: "primer" } });
    state.elements = [
      box("root", 0, 0),
      box("child", 200, 0),
      box("kept", 0, 300),
      arrow("e1", "root", "child"),
    ];

    const preview = await fetch(`${url}/api/session/prune-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ elementId: "root" }),
    }).then((r) => r.json());
    assert.equal(preview.ok, true);
    assert.equal(preview.shapes, 2);
    assert.equal(preview.arrows, 1);
    assert.equal(state.elements.length, 4, "preview must not mutate the canvas");

    const pruned = await fetch(`${url}/api/session/prune`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ elementId: "root" }),
    }).then((r) => r.json());
    assert.equal(pruned.ok, true);
    assert.deepEqual(state.elements.map((el) => el.id), ["kept"], "the branch is gone in one atomic action");
    assert.ok(sent.some((m) => m.type === "whiteboard:update"));
    assert.ok(sent.some((m) => m.type === "branch:pruned" && m.ids.includes("root")), "pruning is narrated");

    const undone = state.undoLastAgentTurn();
    assert.equal(undone.ok, true);
    assert.equal(state.elements.length, 4, "a prune must be undoable like an agent turn");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("prune refuses outside live mode and for unknown elements", async () => {
  const { httpServer, url, state } = await startPruneServer();
  try {
    const staging = await fetch(`${url}/api/session/prune`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ elementId: "x" }),
    });
    assert.equal(staging.status, 409);

    state.startPreso({ primerMessage: { role: "user", content: "primer" } });
    const missing = await fetch(`${url}/api/session/prune`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ elementId: "nope" }),
    });
    assert.equal(missing.status, 400);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

// ---- frontend wiring -------------------------------------------------------

import { readFileSync } from "node:fs";

test("the prune control is contextual: preview on single selection, prune from the bar", () => {
  const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const apiSource = readFileSync(new URL("../public/api-client.js", import.meta.url), "utf8");
  assert.match(apiSource, /prune-preview/);
  assert.match(apiSource, /api\/session\/prune/);
  assert.match(appSource, /prunePreview/);
  assert.match(appSource, /Prune branch/);
  assert.match(appSource, /branch:pruned/);
});
