// Mic capture pipeline: AudioContext -> ScriptProcessorNode -> resample to
// 24kHz -> PCM16 -> base64, streamed to the caller via onChunk. Extracted
// verbatim from app.js's old createAudioStreamer/resample/pcm16ToBase64
// (structural map lines 3059-3135 pre-extraction) - no behavior change, no
// React dependency.
//
// Public API: startMicCapture({ deviceId, onChunk }) -> Promise<{ media,
// analyser, close() }>
//   - Folds in the getUserMedia call itself (previously done separately by
//     the caller at old line 1087), so callers just pass an optional
//     deviceId and an onChunk(audioBase64) callback.
//   - Resolves once the underlying MediaStream and AudioContext graph are
//     wired up, mirroring the old createAudioStreamer's async return shape.
//   - Returns `media` (the raw MediaStream) in addition to `analyser` and
//     `close()` so the caller can stop tracks itself (old stopListening()
//     called `session.media.getTracks().forEach((t) => t.stop())`
//     separately from `session.audio.close()`); `close()` here only tears
//     down the AudioContext graph, matching the old `audio.close()`
//     contract exactly - it does NOT stop the MediaStream tracks, so
//     callers must still stop `media` tracks themselves.
//   - `resample`/`pcm16ToBase64` stay module-private; nothing else in the
//     app (MicEditor's preview flow included) needs them - MicEditor only
//     needs getUserMedia for permission/enumeration, not the encode
//     pipeline, so it keeps its own simpler call.

const SAMPLE_RATE = 24000;

export async function startMicCapture({ deviceId, onChunk } = {}) {
  const audioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (deviceId) audioConstraints.deviceId = { exact: deviceId };
  const media = await navigator.mediaDevices.getUserMedia({
    audio: audioConstraints,
  });

  try {
    const context = new AudioContext();
    const source = context.createMediaStreamSource(media);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.85;
    let carry = new Float32Array(0);

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const resampled = resample(input, context.sampleRate, SAMPLE_RATE, carry);
      carry = resampled.carry;
      if (resampled.samples.length > 0) {
        onChunk(pcm16ToBase64(resampled.samples));
      }
    };

    source.connect(analyser);
    source.connect(processor);
    processor.connect(context.destination);

    return {
      media,
      analyser,
      close: async () => {
        processor.disconnect();
        source.disconnect();
        analyser.disconnect();
        await context.close();
      },
    };
  } catch (error) {
    media.getTracks().forEach((track) => track.stop());
    throw error;
  }
}

function resample(input, fromRate, toRate, carry) {
  const merged = new Float32Array(carry.length + input.length);
  merged.set(carry);
  merged.set(input, carry.length);

  const ratio = fromRate / toRate;
  const outputLength = Math.floor((merged.length - 1) / ratio);
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, merged.length - 1);
    const weight = sourceIndex - left;
    output[index] = merged[left] * (1 - weight) + merged[right] * weight;
  }

  const consumed = Math.floor(outputLength * ratio);
  return { samples: output, carry: merged.slice(consumed) };
}

function pcm16ToBase64(samples) {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}
