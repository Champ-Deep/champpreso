import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyWhiteboardEditOperations,
  formatLineNumberedWhiteboard,
  mapSelectedIdsToLineNumbers,
  restoreUnselectedElements,
} from "../src/whiteboard-tools.js";

test("formatLineNumberedWhiteboard prefixes each element with padded line numbers", () => {
  assert.equal(
    formatLineNumberedWhiteboard([
      { type: "text", id: "title", x: 72, y: 68, text: "AutoPreso" },
      { type: "rectangle", id: "voice", x: 80, y: 140, width: 220, height: 80 },
    ]),
    [
      '001: {"type":"text","id":"title","x":72,"y":68,"text":"AutoPreso"}',
      '002: {"type":"rectangle","id":"voice","x":80,"y":140,"width":220,"height":80}',
    ].join("\n"),
  );
});

test("applyWhiteboardEditOperations edits whiteboard elements by line number", () => {
  const elements = [
    { type: "text", id: "title", x: 72, y: 68, text: "AutoPreso" },
    { type: "rectangle", id: "voice", x: 80, y: 140, width: 220, height: 80 },
  ];

  assert.deepEqual(
    applyWhiteboardEditOperations(elements, [
      { type: "replace", line: 2, element: { type: "rectangle", id: "voice", x: 80, y: 140, width: 260, height: 88 } },
      { type: "insert_after", line: 2, element: { type: "arrow", id: "voice-to-agent", x: 340, y: 184, width: 160, height: 0 } },
      { type: "delete", line: 1 },
    ]),
    [
      { type: "rectangle", id: "voice", x: 80, y: 140, width: 260, height: 88 },
      { type: "arrow", id: "voice-to-agent", x: 340, y: 184, width: 160, height: 0 },
    ],
  );
});

test("applyWhiteboardEditOperations can insert into an empty whiteboard", () => {
  assert.deepEqual(
    applyWhiteboardEditOperations([], [
      { type: "insert_after", line: 0, element: { type: "text", id: "title", x: 72, y: 68, text: "AutoPreso" } },
    ]),
    [{ type: "text", id: "title", x: 72, y: 68, text: "AutoPreso" }],
  );
});

test("applyWhiteboardEditOperations rejects out-of-range line numbers", () => {
  assert.throws(
    () => applyWhiteboardEditOperations([], [{ type: "replace", line: 1, element: { type: "text", id: "title" } }]),
    /Cannot replace line 1/,
  );
});

test("mapSelectedIdsToLineNumbers returns 1-based lines for matching element ids", () => {
  const elements = [
    { id: "a", type: "text" },
    { id: "b", type: "rectangle" },
    { id: "c", type: "arrow" },
  ];
  assert.deepEqual(mapSelectedIdsToLineNumbers(elements, ["c", "a"]), [1, 3]);
  assert.deepEqual(mapSelectedIdsToLineNumbers(elements, ["missing"]), []);
  assert.deepEqual(mapSelectedIdsToLineNumbers(elements, []), []);
});

test("restoreUnselectedElements keeps edits to selected ids and new elements", () => {
  const before = [
    { id: "a", type: "text", text: "Alpha" },
    { id: "b", type: "text", text: "Beta" },
    { id: "c", type: "text", text: "Gamma" },
  ];
  // Agent edited b (selected, allowed), wrongly edited a (unselected), deleted c
  // (unselected), and added a new element d.
  const after = [
    { id: "a", type: "text", text: "HACKED" },
    { id: "b", type: "text", text: "Beta v2" },
    { id: "d", type: "text", text: "Delta" },
  ];
  const result = restoreUnselectedElements(before, after, ["b"]);
  // a restored to original, b keeps the edit, d (new) kept, c (deleted) restored.
  assert.deepEqual(result, [
    { id: "a", type: "text", text: "Alpha" },
    { id: "b", type: "text", text: "Beta v2" },
    { id: "d", type: "text", text: "Delta" },
    { id: "c", type: "text", text: "Gamma" },
  ]);
});

test("restoreUnselectedElements is a no-op when only selected elements changed", () => {
  const before = [
    { id: "a", type: "text", text: "Alpha" },
    { id: "b", type: "text", text: "Beta" },
  ];
  const after = [
    { id: "a", type: "text", text: "Alpha 2" },
    { id: "b", type: "text", text: "Beta" },
  ];
  assert.deepEqual(restoreUnselectedElements(before, after, ["a"]), after);
});
