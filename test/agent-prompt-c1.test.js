// C1 prompt surgery: the drawing prompt no longer obeys deleted controls or
// contradicts itself. See docs/superpowers/specs/2026-09-01-gate-narrate-prune-design.md.
import assert from "node:assert/strict";
import { test } from "node:test";

import { whiteboardSystemPrompt } from "../src/server.js";

test("whiteboard prompt has no SESSION MODES section (the control was deleted from the UI)", () => {
  const prompt = whiteboardSystemPrompt();
  assert.doesNotMatch(prompt, /SESSION MODES/);
  assert.doesNotMatch(prompt, /STRATEGY mode/);
  assert.doesNotMatch(prompt, /PRESENTATION mode/);
  assert.doesNotMatch(prompt, /CO-THINKING mode/);
  assert.doesNotMatch(prompt, /Session Mode in the side panel/);
});

test("whiteboard prompt has exactly one clarifying-questions policy with one session cap", () => {
  const prompt = whiteboardSystemPrompt();
  // One section, one cap - matching the ask_user_question tool description.
  assert.doesNotMatch(prompt, /max 4 per session/);
  assert.equal(prompt.match(/max 1 per topic/g)?.length ?? 0, 1);
  assert.equal(prompt.match(/max 2-3 per session/g)?.length ?? 0, 1);
  assert.doesNotMatch(prompt, /ASK QUESTIONS WHEN UNCERTAIN/);
});

test("whiteboard prompt no longer forces zones into fixed x-coordinate bands", () => {
  const prompt = whiteboardSystemPrompt();
  assert.doesNotMatch(prompt, /x:50-400/);
  assert.doesNotMatch(prompt, /x:400-1000/);
  assert.doesNotMatch(prompt, /x:1000-1400/);
});

test("whiteboard prompt's one-shot example contains no visible self-correction to imitate", () => {
  const prompt = whiteboardSystemPrompt();
  assert.doesNotMatch(prompt, /\(Wait,/);
  assert.doesNotMatch(prompt, /Restate:/);
  // The example itself survives, corrected.
  assert.match(prompt, /ONE-SHOT EXAMPLE/);
});

test("whiteboard prompt states the default-to-drawing doctrine exactly once", () => {
  const prompt = whiteboardSystemPrompt();
  assert.doesNotMatch(prompt, /\nDEFAULT TO DRAWING\./);
  assert.equal(prompt.match(/Silence on the canvas/g)?.length ?? 0, 1);
});
