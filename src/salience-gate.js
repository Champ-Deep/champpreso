// Salience gate: one fast LPU call that decides WHEN a transcript chunk fires
// a drawing turn - never what the agent gets to know. Gated chunks buffer into
// the next salient turn's context (see the design doc's "Granola standard").
//
// Runs on Groq directly rather than OpenRouter (the project's standing LLM
// default) because this sits on the hot path in front of every drawing turn:
// the extra routing hop buys nothing, and the Groq key is already present for
// Whisper transcription. The classifier is injectable (options.classifySalience
// in server.js / whiteboard-session.js) for tests and future rerouting.

const SALIENCE_WORDS = ["chaff", "hypothesis", "decision"];
const SALIENCE_RANK = { chaff: 0, hypothesis: 1, decision: 2 };

export const DEFAULT_SALIENCE_MODEL = "llama-3.1-8b-instant";
export const DEFAULT_SALIENCE_BASE_URL = "https://api.groq.com/openai/v1";

// Higher-ranked salience wins when several chunks fold into one turn.
export function maxSalience(a, b) {
  const ra = SALIENCE_RANK[a] ?? -1;
  const rb = SALIENCE_RANK[b] ?? -1;
  if (ra < 0 && rb < 0) return null;
  return ra >= rb ? a : b;
}

const CLASSIFIER_SYSTEM = `You gate a live meeting transcript for a real-time whiteboarding agent. For each chunk of speech, answer with exactly one word:

chaff - small talk, logistics, greetings, off-topic banter, scheduling chatter, anything no whiteboard should react to right now. It is still kept as context, so err toward chaff only for clearly non-content speech.
hypothesis - an idea being floated or explored, a "maybe", a possibility not yet settled.
decision - a settled conclusion, agreement, action item, concrete fact worth capturing, or a DIRECT INSTRUCTION to the whiteboard (draw X, clear the canvas, add an arrow, zoom in). Direct canvas commands are always "decision".

Respond with one word only: chaff, hypothesis, or decision.`;

/**
 * Build a classifier function backed by an OpenAI-compatible chat endpoint.
 *
 * @param {{ apiKey: string, model?: string, baseURL?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} config
 * @returns {(input: { transcript: string, sessionIntent?: string, recentContext?: string }) => Promise<{ salience: "chaff"|"hypothesis"|"decision" }>}
 */
export function createSalienceClassifier({
  apiKey,
  model = DEFAULT_SALIENCE_MODEL,
  baseURL = DEFAULT_SALIENCE_BASE_URL,
  fetchImpl = fetch,
  timeoutMs = 1500,
}) {
  if (!apiKey) throw new Error("salience classifier requires an API key");
  return async function classifySalience({ transcript, sessionIntent = "", recentContext = "" }) {
    const userParts = [];
    if (sessionIntent) userParts.push(`Session topic: ${sessionIntent.slice(0, 300)}`);
    if (recentContext) userParts.push(`Recent speech: ${recentContext.slice(-400)}`);
    userParts.push(`Chunk to classify: ${String(transcript).slice(0, 800)}`);

    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 4,
          messages: [
            { role: "system", content: CLASSIFIER_SYSTEM },
            { role: "user", content: userParts.join("\n") },
          ],
        }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) {
        throw new Error(`salience classifier HTTP ${response.status}`);
      }
      const payload = await response.json();
      const text = String(payload?.choices?.[0]?.message?.content ?? "").toLowerCase();
      const word = /** @type {"chaff"|"hypothesis"|"decision"|undefined} */ (SALIENCE_WORDS.find((w) => text.includes(w)));
      if (!word) throw new Error(`salience classifier returned no verdict: "${text.slice(0, 60)}"`);
      return { salience: word };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
