# The whiteboard that whiteboards itself — Gate, Narrate, Prune

Approved 2026-09-01. Supersedes the plan draft in `~/.claude/plans/mutable-gathering-oasis.md`
with three user amendments recorded below. Wireframes:
`docs/design-handoff/wireframes/` (published as a Claude artifact).

## The complaint being fixed

"I can never tell what the canvas is up to" — can't tell *why it drew that*, can't tell
*if it's even working* — plus visual clutter in Setup and Settings. Constraint: **hide
complexity, do not remove capability.** (One deliberate exception: seven settings wired to
nothing get deleted, not hidden.)

## User amendments to the approved plan

1. **"Start whiteboarding."** Not "Start listening", not "Start Preso". The product's frame
   is *the whiteboard that whiteboards itself*, and the live-state label becomes
   **Whiteboarding** to match. "Preso" survives only in internal API paths already aliased.

2. **The clock stays, but subtle.** Plain muted mono text in the strip beside the state
   dot — no pill, no border, no background. It earns its place because a running clock is
   the cheapest possible evidence the app is alive.

3. **The gate must meet the Granola standard.** Meeting summary tools (Granola, Zoom
   notes, note takers) summarize accurately *even when the transcript wanders off topic* —
   because they keep everything and distill, rather than discard. So the salience gate
   **never throws speech away**:
   - A `chaff` chunk does not *trigger* a drawing turn, but it is **buffered** and
     prepended to the next salient turn's transcript, so the agent always sees the full
     conversational context in order.
   - The full transcript (gated or not) still reaches the end-of-session Review, which
     reads agentHistory user messages — buffered context lands there when it flushes.
   - Caption vocabulary softens: `noted`, not `OFF-TOPIC`. The gate is a scheduling
     decision, not a judgement of worth.

## Architecture decisions

### Salience gate (`src/salience-gate.js`)

Sits inside `state.queueTranscript` after transcript hygiene, before `queue.enqueue`.

- Classifier: one fast chat call on **Groq LPU** (`llama-3.1-8b-instant`), ~100–300ms,
  reusing the Groq API key already present for STT. Returns
  `{ salience: "chaff"|"hypothesis"|"decision" }`.
  Rationale for Groq-direct rather than OpenRouter (the standing LLM-provider default):
  this call sits on the hot path in front of every drawing turn; the extra OpenRouter hop
  buys nothing here, and the key already exists for Whisper. The classifier is injectable
  (`options.classifySalience`) for tests and future rerouting.
- **Fail-open, always**: classifier error, timeout (1500ms), or no Groq key → treat as
  `decision` (committed) and proceed exactly as today. Failing toward committed can only
  cost clutter; failing toward candidate could auto-expire real content later. A broken
  gate must never mute the product.
- **Bypass** for typed turns (`/api/session/say`), scoped edits, and seeding — the user
  typed it on purpose; gating it would be insubordinate.
- The winning salience for a turn (max over the chunks folded into it;
  decision > hypothesis) is exposed as `state.turnSalience` and as one `SALIENCE:` line
  in the turn message — it drives candidate-vs-committed drawing.
- WS: gated chunks broadcast `salience:noted { text }` so the caption can show
  *"…" · noted* instead of silence.
- Setting: `gate.enabled` (default true; Advanced toggle).

### Candidate lifecycle (server-side, mechanical — never trusts the model)

- After a `hypothesis` turn applies operations, every **new** element id gets
  `customData.status = "candidate"`, `customData.bornTurn`, original style stashed, and
  renders `strokeStyle: "dashed"`, `opacity: 50`.
- Promotion to committed (restore style): the agent replaces/updates the element in a
  `decision` turn, or the **user touches it** (edit arrives via user-elements sync), or
  the user pins it.
- Expiry: at turn end, an untouched, unpinned, agent-born candidate older than
  **two completed turns** is deleted and the deletion is narrated. User-touched or pinned
  elements are never auto-deleted — the pin mechanism is the precedent.

### Intent narration

- `intent` becomes a **required ≤60-char parameter** on `whiteboard_apply`,
  `render_mermaid`, and `whiteboard_overwrite` — the reason ships with the edit, no extra
  round-trip, cannot drift from it. Both tool-definition blocks (live + warmup) change
  identically; tool schemas are part of the cached prefix.
- New WS message `agent:intent { phase, heard?, intent?, noop?, error?, retryable? }`
  with phases `listening | thinking | drawing | idle | error`, composed server-side.
  A no-op turn reports `idle + noop: true` ("nothing worth drawing yet"); a failed turn
  reports `error` with a plain-words message and a Try-again affordance (re-queues the
  transcript through `/api/session/say`).
- `.ls-caption` becomes the single narration surface: transcript (faded) → `heard → doing`
  → noted-tag → no-op line → error pill. No new chrome.
- **`declare_zone` is removed** (tool, prompt section, chip, WS type). Deviation from
  "hide, don't remove", recorded deliberately: the chip is hidden per the approved prune
  table, at which point the tool is a model round-trip per topic with zero user-visible
  output — and `intent` narrates strictly better. Capability is superseded, not lost.

### Prompt surgery — C1 lands now, C2/C3 stay measured

C1 (defect removal): delete SESSION MODES (obeys a control removed last branch), delete
zone x-coordinate bands, merge the three contradictory clarifying-question sections to one
(max 1/topic, 2–3/session — matching the tool description), merge the doubled
default-to-drawing text, replace the one-shot example containing a visible
self-correction. Also teaches SALIENCE (candidate vs committed) and the `intent` param.
C2/C3 (pattern-library collapse) remain gated on `scripts/simulate-whiteboard-agent.js`
A/B runs — not asserted by fiat here.

### Surface pruning

Strip (always): brand · state dot · **Whiteboarding** · clock (subtle) · spacer ·
mic-pause icon · quiet cost text (opens existing drawer) · End.
Contextual: Stop (only mid-turn), Undo (only just after a turn), Prune bar (only on
selection). Hidden: waveform, zone chip (deleted), queue pill.
Deviation from the wireframe recorded: **Pause stays in the strip as an icon** — pausing
the mic mid-meeting is a react-with control, not configuration; burying it fails the
"panic buttons never move into a drawer" rule.

- **Setup**: one question ("What are we working on?"), template chips, **Start
  whiteboarding**, restore link; everything else behind Options. Templates stay visible —
  they are the quick path.
- **Settings**: three questions (listen / draw / answer) + one Advanced disclosure holding
  everything else. The seven phantom keys — `statusDensity`, `toggleBreathe`,
  `questionPos`, `backlogPosition`, `captionMode`, `providerFallback`, `agentMaxRetries` —
  are deleted from `DEFAULT_SETTINGS` and every dead read site.

### Audio: compete with Wispr Flow's *properties*, since Flow has no API

Processing stance (user question answered): all heavy inference is **API-side on fast
silicon** — Groq LPU for Whisper STT and the salience classifier, OpenRouter for
drawing/ask agents, Deepgram for streaming STT. Local CPU does only cheap DSP
programmatically (RMS, resampling, WAV framing, hygiene filters). No self-hosted cloud
GPU; nothing here needs one.

1. **Deepgram Nova-3 streaming provider** (`src/deepgram-transcription.js`) — the
   "reliable, really good voice API online". Sub-300ms finals, interim results (live
   captions appear *as you speak* — the strongest "it's alive" signal there is), keyterm
   prompting fed from the glossary, server-side endpointing replacing our RMS heuristics.
   Activates when a Deepgram key is added; Groq stays the zero-extra-key default.
2. **User glossary** (`transcription.glossary`) — names and product terms (LakeB2B, SPAN,
   Cirralogix…) fed to every provider through the existing
   `buildTranscriptionVocabularyPrompt` path and Deepgram keyterms. Biggest accuracy win
   per line of code; survives session resets because it is config, not session content.
3. **Adaptive noise floor for Groq segmentation** — replace the fixed `SILENCE_RMS = 180`
   with a rolling ambient estimate so background hum doesn't hold utterances open or chop
   them. Programmatic, no new dependency.
4. **Open-repo path, documented not built**: NVIDIA Parakeet-TDT-0.6B-v3 (via
   sherpa-onnx) is the successor candidate for the local Moonshine sidecar; Kyutai STT is
   the streaming-native open alternative. Revisit when offline quality becomes the
   constraint.

## Verification

TDD throughout (`node:test`, failing test first): `salience-gate`, `candidate-lifecycle`,
`agent-intent`, `deepgram-transcription`, `settings-store` (phantom keys absent — use the
`!("k" in o)` form), `agent-prompt` (C1 assertions), plus the full existing suite,
`npm run typecheck`, `npm audit`, and a real-browser pass over every wireframed state.
