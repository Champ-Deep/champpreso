// @ts-nocheck - server harness uses hand-rolled fakes.
// Settings pruning: the seven keys wired to nothing are deleted, not hidden.
// The eighth phantom (ui.agentTimeoutMs promised a 30s fail-fast while the
// code hardcoded 90s) gets WIRED instead - it promises real capability.
// Plus: the user glossary feeds transcription vocabulary on every provider.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DEFAULT_SETTINGS } from "../src/settings-store.js";
import { parseGlossaryTerms } from "../src/whiteboard-keywords.js";
import { runWhiteboardAgent, startServer } from "../src/server.js";

test("the seven phantom settings are gone from DEFAULT_SETTINGS", () => {
  for (const key of ["statusDensity", "toggleBreathe", "questionPos", "backlogPosition", "captionMode", "providerFallback", "agentMaxRetries"]) {
    assert.ok(!(key in DEFAULT_SETTINGS.ui), `${key} was wired to nothing and must be deleted`);
  }
});

test("the frontend no longer declares the phantom prefs", () => {
  const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  for (const key of ["statusDensity", "toggleBreathe", "questionPos", "backlogPosition", "captionMode"]) {
    assert.doesNotMatch(appSource, new RegExp(key), `${key} must not linger in app.js`);
  }
});

test("the transcription glossary exists as an empty default", () => {
  assert.equal(DEFAULT_SETTINGS.transcription.glossary, "");
});

test("parseGlossaryTerms splits on commas and newlines, trims, dedupes", () => {
  assert.deepEqual(
    parseGlossaryTerms("LakeB2B, SPAN\nCirralogix,  Turso , LakeB2B\n\n"),
    ["LakeB2B", "SPAN", "Cirralogix", "Turso"],
  );
  assert.deepEqual(parseGlossaryTerms(""), []);
  assert.deepEqual(parseGlossaryTerms(null), []);
});

function makeSettingsStore(overrides = {}) {
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  Object.assign(settings.transcription, overrides.transcription ?? {});
  Object.assign(settings.ui, overrides.ui ?? {});
  Object.assign(settings.apiKeys, overrides.apiKeys ?? {});
  return {
    load: async () => settings,
    save: async (p) => Object.assign(settings, p),
    getSanitized: async () => ({ ...settings, apiKeys: undefined }),
  };
}

test("glossary terms feed transcription vocabulary at start and survive reset", async () => {
  const contexts = [];
  const { httpServer, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test",
    settingsStore: makeSettingsStore({
      transcription: { glossary: "LakeB2B, SPAN\nCirralogix" },
      apiKeys: { openai: "sk-fixture" },
    }),
    createTranscription: () => ({
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      setSessionContext: (ctx) => contexts.push(ctx),
      close: () => {},
    }),
    generateTextFn: async () => ({ text: "DONE", finishReason: "stop" }),
    streamTextFn: () => ({ consumeStream: async () => {} }),
    warmupMaxAttempts: 1,
    warmupDelays: [],
  });
  try {
    await fetch(`${url}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stagingElements: [{ type: "text", id: "t", x: 0, y: 0, text: "Turso" }] }),
    });
    const startCtx = contexts.at(-1);
    assert.ok(startCtx, "start must prime the transcription vocabulary");
    for (const term of ["LakeB2B", "SPAN", "Cirralogix", "Turso"]) {
      assert.ok(startCtx.keywords.includes(term), `${term} must reach the vocabulary (got ${JSON.stringify(startCtx.keywords)})`);
    }

    await fetch(`${url}/api/session/reset`, { method: "POST" });
    const resetCtx = contexts.at(-1);
    assert.deepEqual(
      resetCtx.keywords,
      ["LakeB2B", "SPAN", "Cirralogix"],
      "reset clears staging keywords but the glossary is config, not session content",
    );
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("ui.agentTimeoutMs is honoured by the drawing turn", async () => {
  const state = { elements: [], agentHistory: [] };
  await assert.rejects(
    () =>
      runWhiteboardAgent({
        transcript: "anything",
        state,
        wss: { clients: new Set() },
        options: {
          settingsStore: makeSettingsStore({ ui: { agentTimeoutMs: 20 }, apiKeys: { openai: "sk-fixture" } }),
        },
        generateTextFn: () => new Promise(() => {}),
        streamTextFn: () => ({ consumeStream: async () => {} }),
      }),
    /timed out after 20ms/,
  );
});
