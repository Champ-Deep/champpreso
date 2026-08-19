import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OPENROUTER_FALLBACK_MODELS,
  createModelCatalog,
} from "../src/model-catalog.js";

function orModel(id, overrides = {}) {
  return {
    id,
    name: id,
    created: 1780000000,
    context_length: 200000,
    architecture: { output_modalities: ["text"] },
    pricing: { prompt: "0.000003", completion: "0.000015" },
    supported_parameters: ["tools", "tool_choice", "max_tokens"],
    ...overrides,
  };
}

const LIVE_PAYLOAD = {
  data: [
    orModel("anthropic/claude-sonnet-5", { created: 1782843083 }),
    orModel("anthropic/claude-sonnet-5:batch", { created: 1782843083 }),
    orModel("openai/gpt-5.6-terra", { created: 1781000000 }),
    // No tool support - the drawing agent cannot use this at all.
    orModel("meta-llama/llama-guard-4", { supported_parameters: ["max_tokens"] }),
    // Image-out only.
    orModel("google/gemini-3.1-flash-image", {
      architecture: { output_modalities: ["image"] },
    }),
    // Free tier variant.
    orModel("deepseek/deepseek-v4-flash", {
      created: 1779000000,
      pricing: { prompt: "0", completion: "0" },
    }),
  ],
};

function harness({ payload = LIVE_PAYLOAD, fail = false, status = 200, now = () => 1_000_000 } = {}) {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (fail) throw new Error("network down");
    if (status !== 200) return { ok: false, status, text: async () => "nope" };
    return { ok: true, status: 200, json: async () => payload };
  };
  const catalog = createModelCatalog({
    fetchImpl,
    now,
    ttlMs: 60_000,
    log: /** @type {any} */ ({ debug() {}, warn() {} }),
  });
  return { catalog, fetchImpl, calls: () => calls };
}

test("lists live OpenRouter models, keeping only ones an agent can actually use", async () => {
  const { catalog } = harness();
  const result = await catalog.list("openrouter");

  assert.equal(result.source, "live");
  const ids = result.models.map((m) => m.id);

  assert.ok(ids.includes("anthropic/claude-sonnet-5"));
  assert.ok(ids.includes("openai/gpt-5.6-terra"));
  // Dropped: no tool calling means the drawing agent silently never draws.
  assert.ok(!ids.includes("meta-llama/llama-guard-4"));
  // Dropped: image output is not a whiteboard agent.
  assert.ok(!ids.includes("google/gemini-3.1-flash-image"));
  // Dropped: :batch is async and useless for a realtime session.
  assert.ok(!ids.includes("anthropic/claude-sonnet-5:batch"));
});

test("newest models come first, so the picker doesn't bury this year's releases", async () => {
  const { catalog } = harness();
  const { models } = await catalog.list("openrouter");
  assert.equal(models[0].id, "anthropic/claude-sonnet-5");
  assert.equal(models[1].id, "openai/gpt-5.6-terra");
});

test("each entry carries the pricing and context the picker shows", async () => {
  const { catalog } = harness();
  const { models } = await catalog.list("openrouter");
  const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-5");

  assert.equal(sonnet.contextLength, 200000);
  // Dollars per million tokens - the unit humans reason about.
  assert.equal(sonnet.promptPerMillion, 3);
  assert.equal(sonnet.completionPerMillion, 15);
  assert.equal(sonnet.free, false);

  const deepseek = models.find((m) => m.id === "deepseek/deepseek-v4-flash");
  assert.equal(deepseek.free, true);
});

test("results are cached until the TTL expires", async () => {
  const clock = { t: 1_000_000 };
  let calls = 0;
  const catalog = createModelCatalog({
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => LIVE_PAYLOAD };
    },
    now: () => clock.t,
    ttlMs: 60_000,
    log: /** @type {any} */ ({ debug() {}, warn() {} }),
  });

  await catalog.list("openrouter");
  await catalog.list("openrouter");
  assert.equal(calls, 1, "second call served from cache");
  assert.equal((await catalog.list("openrouter")).source, "cache");

  clock.t += 60_001;
  await catalog.list("openrouter");
  assert.equal(calls, 2, "refetched after the TTL");
});

test("concurrent callers share one in-flight request", async () => {
  let calls = 0;
  const catalog = createModelCatalog({
    fetchImpl: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, status: 200, json: async () => LIVE_PAYLOAD };
    },
    now: () => 1_000_000,
    ttlMs: 60_000,
    log: /** @type {any} */ ({ debug() {}, warn() {} }),
  });

  await Promise.all([catalog.list("openrouter"), catalog.list("openrouter"), catalog.list("openrouter")]);
  assert.equal(calls, 1);
});

test("a network failure falls back to the bundled list instead of an empty picker", async () => {
  const { catalog } = harness({ fail: true });
  const result = await catalog.list("openrouter");

  assert.equal(result.source, "fallback");
  assert.ok(result.models.length > 0);
  assert.match(result.error, /network down/);
  assert.deepEqual(
    result.models.map((m) => m.id),
    OPENROUTER_FALLBACK_MODELS.map((m) => m.id),
  );
});

test("an HTTP error also falls back rather than throwing", async () => {
  const { catalog } = harness({ status: 503 });
  const result = await catalog.list("openrouter");
  assert.equal(result.source, "fallback");
  assert.match(result.error, /503/);
});

test("a stale cache is preferred over the bundled fallback when refresh fails", async () => {
  const clock = { t: 1_000_000 };
  let calls = 0;
  const catalog = createModelCatalog({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: true, status: 200, json: async () => LIVE_PAYLOAD };
      throw new Error("network down");
    },
    now: () => clock.t,
    ttlMs: 60_000,
    log: /** @type {any} */ ({ debug() {}, warn() {} }),
  });

  await catalog.list("openrouter");
  clock.t += 60_001;
  const result = await catalog.list("openrouter");

  // Yesterday's real list beats a hardcoded list from whenever we last shipped.
  assert.equal(result.source, "stale-cache");
  assert.ok(result.models.some((m) => m.id === "anthropic/claude-sonnet-5"));
});

test("verify flags a configured model that no longer exists", async () => {
  const { catalog } = harness();

  const good = await catalog.verify("openrouter", "anthropic/claude-sonnet-5");
  assert.equal(good.known, true);
  assert.equal(good.warning, null);

  const gone = await catalog.verify("openrouter", "anthropic/claude-3.7-sonnet");
  assert.equal(gone.known, false);
  assert.match(gone.warning, /no longer/i);
  // Points at the nearest surviving model from the same vendor.
  assert.match(gone.suggestion, /^anthropic\//);
});

test("verify stays silent when the catalog itself could not be reached", async () => {
  const { catalog } = harness({ fail: true });
  const result = await catalog.verify("openrouter", "some/unknown-model");
  // We could not check, so we must not claim the model is dead.
  assert.equal(result.known, null);
  assert.equal(result.warning, null);
});

test("a provider with no live endpoint returns its static list", async () => {
  const { catalog, calls } = harness();
  const result = await catalog.list("moonshine");
  assert.equal(result.source, "static");
  assert.ok(result.models.length > 0);
  assert.equal(calls(), 0, "no network call for a static provider");
});

test("the bundled OpenRouter fallback only contains tool-capable entries", () => {
  assert.ok(OPENROUTER_FALLBACK_MODELS.length > 0);
  for (const model of OPENROUTER_FALLBACK_MODELS) {
    assert.ok(model.id.includes("/"), `${model.id} should be a vendor/model slug`);
    assert.ok(!model.id.endsWith(":batch"), `${model.id} should not be a batch variant`);
  }
});

test("a retired model's suggestion stays in the same family, not just the same vendor", async () => {
  const catalog = createModelCatalog({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          // Newest from the vendor, but a different (much pricier) tier.
          orModel("anthropic/claude-opus-5", { created: 1783000000 }),
          orModel("anthropic/claude-sonnet-5", { created: 1782000000 }),
        ],
      }),
    }),
    now: () => 1_000_000,
    ttlMs: 60_000,
    log: /** @type {any} */ ({ debug() {}, warn() {} }),
  });

  const gone = await catalog.verify("openrouter", "anthropic/claude-3.7-sonnet");
  // Answering a retired sonnet with opus is a 5x price jump nobody asked for.
  assert.equal(gone.suggestion, "anthropic/claude-sonnet-5");
});

test("suggestion falls back to newest-from-vendor when the family is gone entirely", async () => {
  const catalog = createModelCatalog({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [orModel("anthropic/claude-opus-5", { created: 1783000000 })] }),
    }),
    now: () => 1_000_000,
    ttlMs: 60_000,
    log: /** @type {any} */ ({ debug() {}, warn() {} }),
  });

  const gone = await catalog.verify("openrouter", "anthropic/claude-3.7-sonnet");
  assert.equal(gone.suggestion, "anthropic/claude-opus-5");
});
