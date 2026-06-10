import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCliArgs } from "../src/cli-options.js";

test("parseCliArgs returns safe defaults", () => {
  assert.deepEqual(parseCliArgs([], {}), {
    host: "127.0.0.1",
    port: 3210,
    openBrowser: true,
    cloud: false,
  });
});

test("parseCliArgs reads port from PORT", () => {
  assert.equal(parseCliArgs([], { PORT: "4567" }).port, 4567);
});

test("parseCliArgs accepts --no-open", () => {
  assert.deepEqual(
    parseCliArgs(["--no-open"], { PORT: "4567" }),
    {
      host: "127.0.0.1",
      port: 4567,
      openBrowser: false,
      cloud: false,
    },
  );
});

test("parseCliArgs accepts --host", () => {
  assert.equal(parseCliArgs(["--host", "0.0.0.0"], {}).host, "0.0.0.0");
});

test("parseCliArgs rejects unknown flags so model selection only happens in the UI", () => {
  for (const arg of ["--moonshine-model", "--transcription-provider", "--openai-transcription-model"]) {
    assert.throws(
      () => parseCliArgs([arg, "value"], {}),
      new RegExp(`Unknown argument "${arg}"`),
    );
  }
});

test("parseCliArgs accepts --port", () => {
  assert.equal(parseCliArgs(["--port", "4567"], {}).port, 4567);
});

test("parseCliArgs rejects invalid PORT", () => {
  assert.throws(
    () => parseCliArgs([], { PORT: "nope" }),
    /Invalid PORT "nope"/,
  );
});
