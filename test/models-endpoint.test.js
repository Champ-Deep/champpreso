import assert from "node:assert/strict";
import { test } from "node:test";

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

function orModel(id, overrides = {}) {
  return {
    id,
    name: id,
    created: 1782000000,
    context_length: 200000,
    architecture: { output_modalities: ["text"] },
    pricing: { prompt: "0.000003", completion: "0.000015" },
    supported_parameters: ["tools", "tool_choice"],
    ...overrides,
  };
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

const LIVE_FETCH = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    data: [
      orModel("anthropic/claude-sonnet-5"),
      orModel("openai/gpt-5.6-terra", { created: 1781000000 }),
      orModel("some/no-tools", { supported_parameters: ["max_tokens"] }),
    ],
  }),
});

test("GET /api/models returns the live OpenRouter catalog", async () => {
  const { httpServer, url } = await startTestServer({ modelCatalogFetch: LIVE_FETCH });
  try {
    const res = await fetch(`${url}/api/models?provider=openrouter`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.provider, "openrouter");
    assert.equal(body.source, "live");
    const ids = body.models.map((m) => m.id);
    assert.deepEqual(ids, ["anthropic/claude-sonnet-5", "openai/gpt-5.6-terra"]);
    assert.equal(body.models[0].promptPerMillion, 3);
  } finally {
    httpServer.close();
  }
});

test("GET /api/models defaults to the configured agent provider", async () => {
  const { httpServer, url } = await startTestServer({ modelCatalogFetch: LIVE_FETCH });
  try {
    const res = await fetch(`${url}/api/models`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.models));
  } finally {
    httpServer.close();
  }
});

test("GET /api/models serves static providers without touching the network", async () => {
  let called = false;
  const { httpServer, url } = await startTestServer({
    modelCatalogFetch: async () => {
      called = true;
      throw new Error("should not be called");
    },
  });
  try {
    const res = await fetch(`${url}/api/models?provider=moonshine-transcription`);
    const body = await res.json();
    assert.equal(body.source, "static");
    assert.deepEqual(body.models.map((m) => m.id), ["tiny", "small", "medium"]);
    assert.equal(called, false);
  } finally {
    httpServer.close();
  }
});

test("GET /api/models degrades to the bundled list when the provider is unreachable", async () => {
  const { httpServer, url } = await startTestServer({
    modelCatalogFetch: async () => {
      throw new Error("network down");
    },
  });
  try {
    const res = await fetch(`${url}/api/models?provider=openrouter`);
    assert.equal(res.status, 200, "a dead catalog must not break the settings sheet");
    const body = await res.json();
    assert.equal(body.source, "fallback");
    assert.ok(body.models.length > 0);
    assert.match(body.error, /network down/);
  } finally {
    httpServer.close();
  }
});

test("GET /api/models/verify warns when the configured model is gone", async () => {
  const { httpServer, url } = await startTestServer({ modelCatalogFetch: LIVE_FETCH });
  try {
    const gone = await (
      await fetch(`${url}/api/models/verify?provider=openrouter&model=anthropic/claude-3.7-sonnet`)
    ).json();
    assert.equal(gone.known, false);
    assert.match(gone.warning, /no longer/i);
    assert.equal(gone.suggestion, "anthropic/claude-sonnet-5");

    const fine = await (
      await fetch(`${url}/api/models/verify?provider=openrouter&model=anthropic/claude-sonnet-5`)
    ).json();
    assert.equal(fine.known, true);
    assert.equal(fine.warning, null);
  } finally {
    httpServer.close();
  }
});

test("GET /api/models/verify does not cry wolf when the catalog is unreachable", async () => {
  const { httpServer, url } = await startTestServer({
    modelCatalogFetch: async () => {
      throw new Error("network down");
    },
  });
  try {
    const body = await (
      await fetch(`${url}/api/models/verify?provider=openrouter&model=anything/at-all`)
    ).json();
    // We could not check. Saying "your model is dead" here would be a lie.
    assert.equal(body.known, null);
    assert.equal(body.warning, null);
  } finally {
    httpServer.close();
  }
});
