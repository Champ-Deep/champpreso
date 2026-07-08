# ChampPreso Backend Roadmap: Simplify Around the Brainstorm Loop

**Owner:** Claude (engineering side), reviewed by Deep
**For the designer:** this tells you what will exist server-side so you can design against the target, not the present. Items marked DONE already run in v0.17.1.

## Guiding call

The backend's only job is the loop: `speech → transcript → agent turn → canvas edit → broadcast`. Everything that exists to serve "presentation mode" gets deleted or folded. Simplicity first, per Champions build philosophy.

## 1. Always-warm agent (fixes the missed-context problem) — TOP PRIORITY

Today `POST /api/preso/start` kicks off a warmup loop (up to 8 attempts, exponential backoff) whose real purpose is prompt-cache priming. The user waits, and early conversation is missed.

Target:

1. **Warm on boot.** The moment the server starts, prime the agent against a neutral primer in the background. App open = agent warm.
2. **Re-warm on change, silently.** When session intent, seed canvas, or agent settings change, re-prime in the background with debounce. Never block the UI.
3. **Capture from click one.** Mic capture and transcription begin the instant the user hits Start listening. If the final primer swap is still in flight, buffer transcripts and replay them into the first turn. Zero speech lost, ever.
4. Keep the fixed-history prompt-cache pattern (`[primer, "UNDERSTOOD"]`); it is why turns are cheap. The change is WHEN priming happens, not HOW.

## 2. Seed ingestion (the "here's what we have so far" path)

Today seeding = manually drawing/pasting on the staging canvas. Target: `POST /api/session/seed` accepts raw text (notes, bullets, a doc). The agent runs one seeding turn that lays it out on the canvas as structured starting state, before listening begins. Same agent, same tools, one-shot turn with a layout-focused prompt. This is the designer's Setup seed area.

## 3. Reliable steering (fix the guiding options)

Known-unreliable paths: `nudge`, `scoped-edit`, and question flow. Plan:

1. Reproduce failures with the existing simulation harness (`scripts/simulate-whiteboard-agent.js`) and add failing tests first (TDD, repo convention).
2. Likely fixes: nudge text must survive turn buffering (currently can be swallowed when concatenated with queued speech), and scoped edits must re-validate line numbers against the canvas as of execution, not as of request.
3. Steering acknowledgment: every steer gets an explicit `nudge:applied` or a new `nudge:failed` within one turn, so the UI can confirm honestly.

## 4. One lifecycle, session language (kill mode soup)

1. Collapse Strategy/Present/Co-think into the session intent plus a `multiSpeaker` boolean. Delete the per-mode prompt branches; fold the co-think speaker-tracking prompt into the base prompt behind the boolean.
2. Rename endpoints `preso/*` → `session/*` with aliases kept one version for compatibility.
3. `mode` values become `setup` / `listening` / `paused` / `review` (WS `mode` message carries the new vocabulary).

## 5. Data safety — DONE in v0.17.1, shipping with next restart

1. Every canvas change persists to `~/.config/champpreso/last-session.json`. DONE
2. Empty canvas can never overwrite a non-empty snapshot. DONE
3. Rolling timestamped snapshots, one per minute of activity, newest 20 kept, in `~/.config/champpreso/snapshots/`. DONE
4. Restore endpoints live: `last-backup`, `restore-backup`, `current-canvas`. DONE
5. Later: a Review-state UI to browse the 20 snapshots (designer: aware, not v1).

## 6. Deletions (simplification pass)

| Delete | Reason |
|---|---|
| Present/Work caption-mode plumbing | Presentation-era |
| Session-mode (strategy/presentation/cothinking) prompt branches | Folded into intent + multiSpeaker |
| Onboarding server flags | Frontend concern |
| Any prompt text that assumes an audience | Brainstorm partner, not presenter |

## Sequence

| Order | Work | Size |
|---|---|---|
| 1 | Always-warm agent + capture-from-click-one | M |
| 2 | Steering reliability (tests first) | M |
| 3 | Lifecycle rename + mode collapse | S |
| 4 | Seed ingestion endpoint | S-M |
| 5 | Deletions pass | S |

Frontend redesign can proceed in parallel against `03-API-CONTRACT.md` semantics; items 3 and 4 are the only contract changes, both flagged there.
