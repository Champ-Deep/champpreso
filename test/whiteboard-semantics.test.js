import assert from "node:assert/strict";
import { test } from "node:test";

import { describeWhiteboard, readBoardStructure } from "../src/whiteboard-semantics.js";

// A zone box the way public/brainstorm-templates.js emits one: a rectangle plus
// a separate header text element positioned just inside its top-left corner.
function zoneBox(id, x, y, width, height, backgroundColor = "#d3f9d8") {
  return { type: "rectangle", id, x, y, width, height, backgroundColor };
}
function textAt(id, x, y, text, width = 120, height = 24) {
  return { type: "text", id, x, y, width, height, text };
}

test("describeWhiteboard reports an empty board plainly", () => {
  assert.match(describeWhiteboard([]), /empty/i);
  assert.match(describeWhiteboard(null), /empty/i);
});

test("readBoardStructure nests elements under the smallest containing zone", () => {
  const elements = [
    zoneBox("outer", 0, 0, 600, 600),
    zoneBox("inner", 50, 50, 200, 200),
    textAt("inner-head", 60, 55, "Ideas"),
    textAt("child", 80, 120, "Self-serve signup"),
    textAt("outer-child", 400, 400, "Parked for later"),
  ];

  const structure = readBoardStructure(elements);
  const inner = structure.zones.find((z) => z.id === "inner");
  const outer = structure.zones.find((z) => z.id === "outer");

  // The header text names the zone rather than being listed as one of its items.
  assert.equal(inner.title, "Ideas");
  assert.deepEqual(
    inner.items.map((i) => i.label),
    ["Self-serve signup"],
  );
  // "outer-child" belongs to outer; "child" belongs to inner, not to outer,
  // because inner is the smallest container holding it.
  assert.deepEqual(
    outer.items.map((i) => i.label),
    ["Parked for later"],
  );
});

test("readBoardStructure resolves a container's bound text label", () => {
  const elements = [
    {
      type: "rectangle",
      id: "box",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      boundElements: [{ id: "box-label", type: "text" }],
    },
    { type: "text", id: "box-label", containerId: "box", x: 10, y: 10, width: 100, height: 20, text: "Pricing" },
  ];

  const structure = readBoardStructure(elements);
  assert.equal(structure.byId.get("box").label, "Pricing");
  // The bound label is not also reported as a loose item.
  assert.equal(structure.loose.length, 0);
});

test("readBoardStructure resolves arrows bound to elements, including the arrow's own label", () => {
  const elements = [
    zoneBox("a", 0, 0, 100, 50),
    textAt("a-t", 10, 10, "Onboarding is slow"),
    zoneBox("b", 300, 0, 100, 50),
    textAt("b-t", 310, 10, "Self-serve signup"),
    {
      type: "arrow",
      id: "arrow1",
      x: 100,
      y: 25,
      width: 200,
      height: 0,
      startBinding: { elementId: "a" },
      endBinding: { elementId: "b" },
      boundElements: [{ id: "arrow1-label", type: "text" }],
    },
    { type: "text", id: "arrow1-label", containerId: "arrow1", x: 180, y: 15, width: 40, height: 18, text: "fix by" },
  ];

  const structure = readBoardStructure(elements);
  assert.equal(structure.connections.length, 1);
  const [conn] = structure.connections;
  assert.equal(conn.from, "Onboarding is slow");
  assert.equal(conn.to, "Self-serve signup");
  assert.equal(conn.label, "fix by");
});

test("readBoardStructure snaps an unbound arrow to the nearest element at each end", () => {
  const elements = [
    zoneBox("a", 0, 0, 100, 50),
    textAt("a-t", 10, 10, "Cause"),
    zoneBox("b", 300, 0, 100, 50),
    textAt("b-t", 310, 10, "Effect"),
    // No bindings at all — endpoints just happen to touch each box.
    { type: "arrow", id: "arrow1", x: 102, y: 25, width: 196, height: 0 },
  ];

  const structure = readBoardStructure(elements);
  assert.equal(structure.connections.length, 1);
  assert.equal(structure.connections[0].from, "Cause");
  assert.equal(structure.connections[0].to, "Effect");
});

test("readBoardStructure groups loose elements into vertical bands", () => {
  const elements = [
    textAt("r1a", 0, 0, "first row left"),
    textAt("r1b", 300, 8, "first row right"),
    // Far below the first band — a separate cluster.
    textAt("r2a", 0, 900, "second row"),
  ];

  const structure = readBoardStructure(elements);
  assert.equal(structure.zones.length, 0);
  assert.equal(structure.clusters.length, 2);
  assert.deepEqual(
    structure.clusters[0].items.map((i) => i.label),
    ["first row left", "first row right"],
  );
  assert.deepEqual(
    structure.clusters[1].items.map((i) => i.label),
    ["second row"],
  );
});

test("describeWhiteboard renders zones, their items, and connections as readable markdown", () => {
  const elements = [
    zoneBox("problems", 0, 0, 300, 300, "#ffe3e3"),
    textAt("problems-head", 10, 8, "Problems"),
    textAt("p1", 20, 60, "Handoff has no owner"),
    zoneBox("bets", 400, 0, 300, 300, "#d3f9d8"),
    textAt("bets-head", 410, 8, "Top bets"),
    textAt("b1", 420, 60, "Self-serve signup"),
    {
      type: "arrow",
      id: "arrow1",
      x: 300,
      y: 150,
      width: 100,
      height: 0,
      startBinding: { elementId: "problems" },
      endBinding: { elementId: "bets" },
    },
  ];

  const digest = describeWhiteboard(elements);

  assert.match(digest, /Problems/);
  assert.match(digest, /Handoff has no owner/);
  assert.match(digest, /Top bets/);
  assert.match(digest, /Self-serve signup/);
  assert.match(digest, /Connections/i);
  // The connection reads as a relationship between the two zones by name.
  assert.match(digest, /Problems.*->.*Top bets/);
  // Zone headers are not repeated as items inside their own zone.
  assert.equal(digest.match(/Handoff has no owner/g).length, 1);
});

test("describeWhiteboard stays bounded on a large board", () => {
  const elements = [];
  for (let i = 0; i < 400; i += 1) {
    elements.push(textAt(`t${i}`, (i % 20) * 150, Math.floor(i / 20) * 60, `item number ${i}`));
  }
  const digest = describeWhiteboard(elements);
  assert.ok(digest.length < 20000, `digest was ${digest.length} chars`);
  assert.match(digest, /400 elements/);
});
