// v0.11.0: Transcript hygiene. Inspired by Mega-ASR's "semantic recovery"
// principle that filters Whisper's known failure modes (empty outputs,
// dropped utterances, repetition hallucinations). We can't retrain models,
// but we can filter their known bad outputs server-side BEFORE the agent
// ever sees them. This applies to all engines: Moonshine, OpenAI Realtime,
// Groq Whisper, etc.

// Two-tier hallucination detection:
//
// EXACT_MATCH: phrases the agent should drop if they are the WHOLE transcript
// (allowing for leading/trailing punctuation). Mostly silence/music tags
// where the speaker said nothing at all.
//
// SUBSTRING_MATCH: phrases the agent should drop wherever they appear
// because they're YouTube/podcast outro spam Whisper hallucinates on
// background noise. If Whisper thinks the audio sounds like the end of a
// YouTube video, we don't want any of it.
const EXACT_MATCH_PHRASES = [
  "thanks for watching",
  "thank you for watching",
  "thanks for listening",
  "[music]",
  "[applause]",
  "[laughter]",
  "[no audio]",
  "(no audio)",
  "[inaudible]",
  "(inaudible)",
  "[silence]",
  "music playing",
  "♪",
  "you you you you",
  "yeah yeah yeah yeah",
  "mm-hmm",
  "uh-huh",
  "ok",
  "okay",
];
const SUBSTRING_MATCH_PHRASES = [
  "please subscribe",
  "like and subscribe",
  "don't forget to subscribe",
  "don't forget to like",
  "subscribe to my channel",
  "subscribe to our channel",
  "see you in the next video",
  "see you next time",
  "see you in the next one",
  "subtitles by",
  "captions by",
  "amara.org",
  "click the bell",
  "hit the like button",
  "ring the bell",
  "welcome back to my channel",
  "welcome back to the channel",
  "hit the subscribe",
  "smash that like",
];

const EXACT_REGEX = new RegExp(
  `^[\\s\\.,;:!?'"\\-]*(${EXACT_MATCH_PHRASES
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})[\\s\\.,;:!?'"\\-]*$`,
  "i",
);
const SUBSTRING_REGEX = new RegExp(
  `(${SUBSTRING_MATCH_PHRASES
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})`,
  "i",
);
function matchesHallucination(text) {
  return EXACT_REGEX.test(text) || SUBSTRING_REGEX.test(text);
}

// Tokens (words) repeated 4+ times in a row are almost always hallucination.
// Example: "you you you you you" or "thank you thank you thank you thank you".
// We collapse to a single occurrence.
const REPEATED_TOKEN_REGEX = /\b(\w+(?:\s+\w+)?)\b(?:\s+\1\b){3,}/gi;

// Drop transcripts shorter than this many printable chars. A single
// punctuation mark or 1-letter utterance is almost always noise.
const MIN_TRANSCRIPT_CHARS = 3;

export function cleanTranscript(text, options = {}) {
  if (typeof text !== "string") return "";
  const opts = {
    filterHallucinations: options.filterHallucinations !== false,
    dedupRepeatedTokens: options.dedupRepeatedTokens !== false,
    dropShort: options.dropShort !== false,
    minChars: typeof options.minChars === "number" ? options.minChars : MIN_TRANSCRIPT_CHARS,
  };

  let out = text.trim();

  // Drop chunks under the minimum length.
  if (opts.dropShort && out.length < opts.minChars) return "";

  // Reject known hallucinations whole.
  if (opts.filterHallucinations && matchesHallucination(out)) return "";

  // Collapse repeated tokens (the "you you you you" hallucination pattern).
  if (opts.dedupRepeatedTokens) {
    out = out.replace(REPEATED_TOKEN_REGEX, (_match, group) => group);
  }

  // Reject single-token chunks that consist entirely of one word repeated.
  // Catches "you you" or "uh uh" that the regex above didn't collapse far
  // enough.
  if (opts.filterHallucinations) {
    const tokens = out.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length >= 2 && tokens.every((t) => t === tokens[0])) return "";
  }

  // Re-check length after cleaning - dedup may have shortened it.
  if (opts.dropShort && out.length < opts.minChars) return "";

  return out;
}

// Diagnostic helper: returns the reason a transcript was rejected, useful for
// logging when hygiene is on. Returns null when the transcript would pass.
export function explainRejection(text, options = {}) {
  if (typeof text !== "string") return "not-a-string";
  const trimmed = text.trim();
  const opts = {
    filterHallucinations: options.filterHallucinations !== false,
    dropShort: options.dropShort !== false,
    minChars: typeof options.minChars === "number" ? options.minChars : MIN_TRANSCRIPT_CHARS,
  };
  if (opts.dropShort && trimmed.length < opts.minChars) return "too-short";
  if (opts.filterHallucinations && matchesHallucination(trimmed)) return "known-hallucination";
  const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  if (opts.filterHallucinations && tokens.length >= 2 && tokens.every((t) => t === tokens[0])) {
    return "all-same-token";
  }
  return null;
}

export const HYGIENE_DEFAULTS = {
  filterHallucinations: true,
  dedupRepeatedTokens: true,
  dropShort: true,
  minChars: MIN_TRANSCRIPT_CHARS,
};
