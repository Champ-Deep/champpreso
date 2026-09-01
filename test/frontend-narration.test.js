// Frontend narration + whiteboarding vocabulary + strip pruning.
// Source-level assertions in the style of frontend-status.test.js: the
// frontend is buildless ES modules, so these tests pin the wiring the browser
// pass then verifies visually.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const listeningSource = readFileSync(new URL("../public/screens/listening-screen.js", import.meta.url), "utf8");
const setupSource = readFileSync(new URL("../public/screens/setup-screen.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("../src/whiteboard-session.js", import.meta.url), "utf8");

test("the product says Start whiteboarding and the live state is Whiteboarding", () => {
  assert.match(setupSource, /Start whiteboarding/);
  assert.doesNotMatch(setupSource, /Start listening/);
  assert.match(listeningSource, /"Whiteboarding"/);
  assert.doesNotMatch(listeningSource, /"Listening"/);
});

test("the strip is pruned: no waveform, no zone chip, no inline status text", () => {
  assert.doesNotMatch(listeningSource, /ls-wave/);
  assert.doesNotMatch(listeningSource, /ls-zone/);
  assert.doesNotMatch(listeningSource, /ls-status-text/);
  assert.doesNotMatch(listeningSource, /ZONE_LABELS/);
});

test("Undo is contextual - rendered only while the just-drew window is open", () => {
  assert.match(listeningSource, /undoAvailable/);
  assert.match(appSource, /undoAvailable/);
});

test("the caption is the narration surface: heard -> doing, noted, no-op and error all render there", () => {
  assert.match(listeningSource, /narration/);
  assert.match(listeningSource, /nothing worth drawing/i);
  assert.match(listeningSource, /noted/);
  assert.match(listeningSource, /Nothing was lost/);
  assert.match(listeningSource, /Try again/);
});

test("app.js consumes the narration messages and drops the zone channel", () => {
  assert.match(appSource, /agent:intent/);
  assert.match(appSource, /salience:noted/);
  assert.match(appSource, /candidate:expired/);
  assert.doesNotMatch(appSource, /agent:zone/);
  assert.doesNotMatch(appSource, /declare_zone/);
});

test("declare_zone is gone from the server: tools, prompt, session", () => {
  assert.doesNotMatch(serverSource, /declare_zone/);
  assert.doesNotMatch(serverSource, /CANVAS ZONES/);
  assert.doesNotMatch(sessionSource, /declareZone/);
  assert.doesNotMatch(sessionSource, /activeZone/);
});

test("retrying a failed turn resends the heard transcript as a typed turn", () => {
  assert.match(appSource, /retryTurn|onRetryTurn/);
  assert.match(listeningSource, /onRetryTurn/);
});
