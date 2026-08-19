import assert from "node:assert/strict";
import { test } from "node:test";

import { createGroqTranscription, pcm16ToWav } from "../src/groq-transcription.js";

// One frame of 24 kHz PCM16 at a given amplitude, as the browser sends it:
// base64-encoded little-endian int16.
function frame(amplitude, samples = 2400) {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(amplitude, i * 2);
  }
  return buffer.toString("base64");
}

const LOUD = () => frame(8000);
const SILENT = () => frame(0);

function harness({ transcripts = ["hello there everyone"], fail = false } = {}) {
  const queued = [];
  const sent = [];
  const requests = [];
  let call = 0;

  /** @type {any} */
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (fail) return { ok: false, status: 401, text: async () => "bad key" };
    const text = transcripts[Math.min(call++, transcripts.length - 1)];
    return { ok: true, status: 200, json: async () => ({ text }) };
  };

  const provider = createGroqTranscription({
    sendTranscript: (m) => sent.push(m),
    queueTranscript: (t) => queued.push(t),
    options: { groqTranscriptionModel: "whisper-large-v3-turbo" },
    env: { GROQ_API_KEY: "test-key" },
    fetchImpl,
    log: /** @type {any} */ ({ debug() {}, warn() {}, error() {} }),
  });

  return { provider, queued, sent, requests };
}

test("pcm16ToWav prepends a valid 44-byte RIFF/WAVE header", () => {
  const pcm = Buffer.alloc(480);
  const wav = pcm16ToWav(pcm, 24000);

  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.subarray(36, 40).toString("ascii"), "data");
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length); // RIFF chunk size
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 24000); // sample rate
  assert.equal(wav.readUInt16LE(34), 16); // bits per sample
  assert.equal(wav.readUInt32LE(40), pcm.length); // data chunk size
});

test("flushes a turn after trailing silence and queues the transcript", async () => {
  const { provider, queued, sent, requests } = harness();
  await provider.ready();

  // ~0.4s of speech, then enough silence to cross the quiet threshold.
  for (let i = 0; i < 4; i += 1) provider.sendAudio(LOUD());
  for (let i = 0; i < 8; i += 1) provider.sendAudio(SILENT());
  await provider.flushPending();

  assert.equal(requests.length, 1);
  assert.deepEqual(queued, ["hello there everyone"]);
  assert.ok(sent.some((m) => m.type === "transcript:committed" && m.text === "hello there everyone"));
});

test("posts multipart audio to the Groq transcriptions endpoint with the configured model", async () => {
  const { provider, requests } = harness();
  await provider.ready();

  for (let i = 0; i < 4; i += 1) provider.sendAudio(LOUD());
  provider.stop();
  await provider.flushPending();

  assert.equal(requests.length, 1);
  const { url, init } = requests[0];
  assert.match(url, /\/audio\/transcriptions$/);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer test-key");
  assert.ok(init.body instanceof FormData);
  assert.equal(init.body.get("model"), "whisper-large-v3-turbo");
  const file = init.body.get("file");
  assert.ok(file, "audio file part is present");
});

test("does not call the API when the buffer holds only silence", async () => {
  const { provider, requests, queued } = harness();
  await provider.ready();

  for (let i = 0; i < 20; i += 1) provider.sendAudio(SILENT());
  await provider.flushPending();

  assert.equal(requests.length, 0);
  assert.deepEqual(queued, []);
});

test("flushes on the max window even while speech continues", async () => {
  const { provider, requests } = harness();
  await provider.ready();

  // 8 seconds of unbroken speech at 0.1s per frame - past the ~6s ceiling.
  for (let i = 0; i < 80; i += 1) provider.sendAudio(LOUD());
  await provider.flushPending();

  assert.ok(requests.length >= 1, "long speech was flushed without waiting for silence");
});

test("session keywords ride along as the vocabulary prompt", async () => {
  const { provider, requests } = harness();
  await provider.ready();
  provider.setSessionContext({ keywords: ["ChampPreso", "Excalidraw"] });

  for (let i = 0; i < 4; i += 1) provider.sendAudio(LOUD());
  provider.stop();
  await provider.flushPending();

  const prompt = requests[0].init.body.get("prompt");
  assert.match(String(prompt), /ChampPreso/);
  assert.match(String(prompt), /Excalidraw/);
});

test("filler-only transcripts are dropped by transcript hygiene", async () => {
  const { provider, queued } = harness({ transcripts: ["uh"] });
  await provider.ready();

  for (let i = 0; i < 4; i += 1) provider.sendAudio(LOUD());
  provider.stop();
  await provider.flushPending();

  assert.deepEqual(queued, []);
});

test("an API failure surfaces an error but does not throw or queue garbage", async () => {
  const { provider, queued, sent } = harness({ fail: true });
  await provider.ready();

  for (let i = 0; i < 4; i += 1) provider.sendAudio(LOUD());
  provider.stop();
  await provider.flushPending();

  assert.deepEqual(queued, []);
  assert.ok(sent.some((m) => m.type === "error"), "an error message was broadcast");
});

test("ready() rejects when no API key is configured", async () => {
  const provider = createGroqTranscription({
    sendTranscript: () => {},
    queueTranscript: () => {},
    options: {},
    env: {},
    fetchImpl: async () => {
      throw new Error("should not be called");
    },
  });

  await assert.rejects(() => provider.ready(), /GROQ_API_KEY/);
});
