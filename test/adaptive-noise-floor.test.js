// Adaptive noise floor for the Groq segmenter. A fixed SILENCE_RMS of 180
// breaks in real rooms: steady background hum (AC, projector, chatter) sits
// above it, so no frame ever counts as quiet and utterances only flush at the
// 6s ceiling - sluggish pacing and mid-sentence chops. The tracker learns the
// ambient level from a rolling percentile and scales the threshold to it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createGroqTranscription, createNoiseFloorTracker } from "../src/groq-transcription.js";

function frame(amplitude, samples = 2400) {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buffer.writeInt16LE(amplitude, i * 2);
  return buffer.toString("base64");
}

test("the tracker learns a hum, ignores speech bursts, and relaxes when the room quiets", () => {
  const tracker = createNoiseFloorTracker();
  let threshold = 0;
  // Quiet room: base threshold holds.
  for (let i = 0; i < 5; i += 1) threshold = tracker.update(40);
  assert.equal(threshold, 180, "quiet rooms keep today's base threshold exactly");
  // Steady 400-amplitude hum: the floor adapts once the hum dominates the
  // rolling window (~6s of frames), not on the first few frames - a brief
  // loud patch must never reconfigure silence detection.
  for (let i = 0; i < 12; i += 1) threshold = tracker.update(400);
  assert.equal(threshold, 180, "a short loud patch alone must not move the threshold");
  for (let i = 0; i < 58; i += 1) threshold = tracker.update(400);
  assert.ok(threshold > 400, `hum must fall below the threshold once learned (got ${threshold})`);
  // A speech burst must not drag the threshold up to speech level.
  for (let i = 0; i < 6; i += 1) threshold = tracker.update(8000);
  assert.ok(threshold < 6000, `speech bursts must stay above the threshold (got ${threshold})`);
  // Room quiets again: threshold relaxes back to base.
  for (let i = 0; i < 80; i += 1) threshold = tracker.update(40);
  assert.equal(threshold, 180);
});

test("a humming room still flushes utterances at the silence hold instead of the 6s ceiling", async () => {
  const requests = [];
  const queued = [];
  const provider = createGroqTranscription({
    sendTranscript: () => {},
    queueTranscript: (t) => queued.push(t),
    options: { groqTranscriptionModel: "whisper-large-v3-turbo" },
    env: { GROQ_API_KEY: "test-key" },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ text: "map the funnel end to end" }) };
    },
    log: { debug() {}, warn() {}, error() {} },
  });
  await provider.ready();

  // 1.2s of steady hum (amplitude 400 - above the fixed 180 threshold), then
  // 0.4s of speech, then 0.8s of hum again. Total 2.4s - far below the 6s
  // ceiling, so with a fixed threshold NOTHING would flush here.
  for (let i = 0; i < 12; i += 1) provider.sendAudio(frame(400));
  for (let i = 0; i < 4; i += 1) provider.sendAudio(frame(8000));
  for (let i = 0; i < 8; i += 1) provider.sendAudio(frame(400));
  await provider.flushPending();

  assert.ok(requests.length >= 1, "the speech utterance must flush on the silence hold despite the hum");
  assert.ok(queued.includes("map the funnel end to end"));
});
