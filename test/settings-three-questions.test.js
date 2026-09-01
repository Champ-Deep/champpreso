// Settings: a 47-key wall becomes three questions, with every capability one
// Advanced disclosure down. Wireframe: Settings.dc.html.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const setupSource = readFileSync(new URL("../public/screens/setup-screen.js", import.meta.url), "utf8");

test("the sheet leads with three questions", () => {
  assert.match(setupSource, /How should it listen\?/);
  assert.match(setupSource, /How should it draw\?/);
  assert.match(setupSource, /How should it answer\?/);
});

test("everything else lives behind a single collapsed Advanced disclosure", () => {
  assert.match(setupSource, /advancedOpen/);
  assert.match(setupSource, /advancedOpen.*useState\(false\)|useState\(false\).*advancedOpen/s, "Advanced starts collapsed");
  assert.match(setupSource, /more settings/i);
  // Nothing was lost - every section survives inside the disclosure.
  for (const label of ["SESSION", "AGENT", "TRANSCRIPTION", "ASK AGENT", "APPEARANCE"]) {
    assert.match(setupSource, new RegExp(`"${label}"`), `${label} section must survive`);
  }
  assert.match(setupSource, /MicSection/);
});

test("the listen question offers all four providers with plain-language labels", () => {
  assert.match(setupSource, /Local · /);
  assert.match(setupSource, /Groq LPU · /);
  assert.match(setupSource, /Deepgram · /);
  assert.match(setupSource, /OpenAI · /);
});
