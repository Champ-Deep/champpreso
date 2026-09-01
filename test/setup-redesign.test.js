// Setup redesign: 39 controls become one question. Everything the rail held
// survives - it moves behind Options (the settings sheet) or into the card.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const setupSource = readFileSync(new URL("../public/screens/setup-screen.js", import.meta.url), "utf8");

test("the setup rail is gone; a strip and a centered question card replace it", () => {
  assert.doesNotMatch(setupSource, /setup-rail/);
  assert.match(setupSource, /setup-strip/);
  assert.match(setupSource, /sq-card/);
  assert.match(setupSource, /What are we working on\?/);
  assert.match(setupSource, /Options/);
});

test("every rail capability survives: templates, restore, multi-speaker, seed, instructions", () => {
  assert.match(setupSource, /BRAINSTORM_TEMPLATES/);
  assert.match(setupSource, /Restore last session/);
  assert.match(setupSource, /Multiple speakers/, "moved into the sheet, not deleted");
  assert.match(setupSource, /Seed with notes|setup-seed/, "seeding moved into the sheet, not deleted");
  assert.match(setupSource, /Agent instructions/, "long-form instructions editable in the sheet");
});

test("the template scroll correction no longer offsets for a rail that does not exist", () => {
  assert.doesNotMatch(setupSource, /142/);
});
