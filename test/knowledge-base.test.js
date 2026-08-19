import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createKnowledgeBase } from "../src/knowledge-base.js";

let root;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "champpreso-kb-"));
  await fs.mkdir(path.join(root, "nested"), { recursive: true });

  await fs.writeFile(
    path.join(root, "pricing.md"),
    [
      "# Pricing policy",
      "",
      "Enterprise tier starts at 40,000 dollars per year with a three year minimum.",
      "",
      "## Discounts",
      "",
      "Discounts above fifteen percent need approval from the CFO.",
    ].join("\n"),
  );

  await fs.writeFile(
    path.join(root, "nested", "onboarding.txt"),
    "New customers are onboarded within ten business days by the solutions team.",
  );

  // An extension we do not index - must never show up in results.
  await fs.writeFile(path.join(root, "logo.png"), "not really a png");
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("indexes supported files recursively and skips unsupported extensions", async () => {
  const kb = createKnowledgeBase({ folders: [root] });
  const stats = await kb.ensureIndexed();

  assert.equal(stats.fileCount, 2);
  assert.ok(stats.chunkCount >= 2);
  assert.ok(!stats.files.some((f) => f.endsWith(".png")));
});

test("search ranks the relevant chunk first and cites its source file", async () => {
  const kb = createKnowledgeBase({ folders: [root] });
  const results = await kb.search("what approval is needed for a big discount");

  assert.ok(results.length > 0);
  assert.match(results[0].text, /CFO/);
  assert.match(results[0].source, /pricing\.md/);
  assert.equal(typeof results[0].line, "number");
});

test("search finds content in nested folders", async () => {
  const kb = createKnowledgeBase({ folders: [root] });
  const results = await kb.search("how long does onboarding take");

  assert.ok(results.some((r) => /ten business days/.test(r.text)));
  assert.ok(results.some((r) => r.source.includes("onboarding.txt")));
});

test("search returns nothing when no folders are configured", async () => {
  const kb = createKnowledgeBase({ folders: [] });
  assert.deepEqual(await kb.search("anything"), []);
  const stats = await kb.ensureIndexed();
  assert.equal(stats.fileCount, 0);
});

test("a missing folder degrades gracefully instead of throwing", async () => {
  const kb = createKnowledgeBase({ folders: [path.join(root, "does-not-exist")] });
  const stats = await kb.ensureIndexed();
  assert.equal(stats.fileCount, 0);
  assert.deepEqual(await kb.search("anything"), []);
});

test("maxIndexChars caps how much content is held in memory", async () => {
  const kb = createKnowledgeBase({ folders: [root], maxIndexChars: 80 });
  const stats = await kb.ensureIndexed();
  assert.ok(stats.totalChars <= 80, `indexed ${stats.totalChars} chars`);
  assert.ok(stats.truncated, "the index reports that it was truncated");
});

test("search honours the topK limit", async () => {
  const kb = createKnowledgeBase({ folders: [root] });
  const results = await kb.search("discount pricing onboarding approval", { topK: 1 });
  assert.equal(results.length, 1);
});

test("formatResultsForAgent marks the content as untrusted reference data", async () => {
  const kb = createKnowledgeBase({ folders: [root] });
  const results = await kb.search("discount approval");
  const rendered = kb.formatResultsForAgent(results);

  assert.match(rendered, /reference/i);
  assert.match(rendered, /pricing\.md/);
  // The delimiter makes clear where untrusted content starts and stops.
  assert.match(rendered, /BEGIN KNOWLEDGE BASE/);
  assert.match(rendered, /END KNOWLEDGE BASE/);
});
