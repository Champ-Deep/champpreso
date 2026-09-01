// @ts-nocheck - hand-rolled fake WebSocket.
// Deepgram Nova-3 streaming provider: the "reliable, really good voice API"
// leg of the audio plan. Sub-300ms finals, interim results for live captions,
// keyterm prompting fed from the glossary, server-side endpointing.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createDeepgramTranscription } from "../src/deepgram-transcription.js";
import { DEFAULT_SETTINGS } from "../src/settings-store.js";

class FakeWs extends EventEmitter {
  static instances = [];
  static autoOpen = true;
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.sent = [];
    this.readyState = 0;
    FakeWs.instances.push(this);
    if (FakeWs.autoOpen) setTimeout(() => this.open(), 0);
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit("close"); }
  open() { this.readyState = 1; this.emit("open"); }
  message(obj) { this.emit("message", Buffer.from(JSON.stringify(obj))); }
}

function makeProvider(extra = {}) {
  FakeWs.instances = [];
  const partials = [];
  const committed = [];
  const queued = [];
  const provider = createDeepgramTranscription({
    sendTranscript: (m) => {
      if (m.type === "transcript:partial") partials.push(m.text);
      if (m.type === "transcript:committed") committed.push(m.text);
    },
    queueTranscript: (t) => { queued.push(t); return Promise.resolve(); },
    options: { deepgramWs: FakeWs, deepgramModel: "nova-3", ...extra.options },
    env: { DEEPGRAM_API_KEY: "dg_test", ...extra.env },
  });
  return { provider, partials, committed, queued };
}

test("connects to the streaming endpoint with the right audio contract and auth", async () => {
  const { provider } = makeProvider();
  await provider.ready();
  const ws = FakeWs.instances[0];
  assert.match(ws.url, /^wss:\/\/api\.deepgram\.com\/v1\/listen\?/);
  assert.match(ws.url, /model=nova-3/);
  assert.match(ws.url, /encoding=linear16/);
  assert.match(ws.url, /sample_rate=24000/);
  assert.match(ws.url, /interim_results=true/);
  assert.equal(ws.opts.headers.Authorization, "Token dg_test");
  provider.close();
});

test("interim results become live caption partials and never fire turns", async () => {
  const { provider, partials, queued } = makeProvider();
  await provider.ready();
  const ws = FakeWs.instances[0];
  ws.message({ type: "Results", is_final: false, speech_final: false, channel: { alternatives: [{ transcript: "we should map" }] } });
  assert.deepEqual(partials, ["we should map"]);
  assert.equal(queued.length, 0);
  provider.close();
});

test("finals accumulate and the endpoint commits one whole utterance", async () => {
  const { provider, committed, queued } = makeProvider();
  await provider.ready();
  const ws = FakeWs.instances[0];
  ws.message({ type: "Results", is_final: true, speech_final: false, channel: { alternatives: [{ transcript: "we should map" }] } });
  ws.message({ type: "Results", is_final: true, speech_final: true, channel: { alternatives: [{ transcript: "the whole funnel" }] } });
  assert.deepEqual(queued, ["we should map the whole funnel"]);
  assert.deepEqual(committed, ["we should map the whole funnel"]);
  provider.close();
});

test("sendAudio forwards decoded PCM frames only while the socket is open", async () => {
  const { provider } = makeProvider();
  const pcm = Buffer.from([1, 2, 3, 4]).toString("base64");
  provider.sendAudio(pcm); // socket not open yet - dropped, not thrown
  await provider.ready();
  const ws = FakeWs.instances[0];
  provider.sendAudio(pcm);
  const binary = ws.sent.filter((d) => Buffer.isBuffer(d));
  assert.equal(binary.length, 1);
  assert.deepEqual([...binary[0]], [1, 2, 3, 4]);
  provider.close();
});

test("setSessionContext reconnects with keyterm prompting from the vocabulary", async () => {
  const { provider } = makeProvider();
  await provider.ready();
  provider.setSessionContext({ keywords: ["LakeB2B", "Cirralogix"] });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(FakeWs.instances.length, 2, "keyterms live in the connection URL, so the socket rebuilds");
  const ws = FakeWs.instances[1];
  assert.match(ws.url, /keyterm=LakeB2B/);
  assert.match(ws.url, /keyterm=Cirralogix/);
  provider.close();
});

test("keepalives flow while the mic is quiet so Deepgram keeps the socket", async () => {
  const { provider } = makeProvider({ options: { deepgramKeepAliveMs: 15 } });
  await provider.ready();
  const ws = FakeWs.instances[0];
  await new Promise((r) => setTimeout(r, 50));
  const keepalives = ws.sent.filter((d) => typeof d === "string" && d.includes("KeepAlive"));
  assert.ok(keepalives.length >= 2, `expected keepalives, saw ${ws.sent.length} sends`);
  provider.close();
});

test("a missing key rejects ready() so the manager can fail soft", async () => {
  FakeWs.instances = [];
  const provider = createDeepgramTranscription({
    sendTranscript: () => {},
    queueTranscript: () => Promise.resolve(),
    options: { deepgramWs: FakeWs },
    env: {},
  });
  await assert.rejects(() => provider.ready(), /Deepgram API key/);
});

test("settings know deepgram: model default, key slot, sanitized flag name", async () => {
  assert.equal(DEFAULT_SETTINGS.transcription.deepgram.model, "nova-3");
  assert.equal(DEFAULT_SETTINGS.apiKeys.deepgram, "");
});
