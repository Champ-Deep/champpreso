# ChampPreso Backend Roadmap: Simplify Around the Brainstorm Loop

**Owner:** Claude (engineering side), reviewed by Deep
**For the designer:** this tells you what will exist server-side so you can design against the target, not the present. Items marked DONE already run in v0.17.1.

## Guiding call

The backend's only job is the loop: `speech → transcript → agent turn → canvas edit → broadcast`. Everything that exists to serve "presentation mode" gets deleted or folded. Simplicity first, per Champions build philosophy.

## 1. Always-warm agent (fixes the missed-context problem) — DONE in v0.17.1

Shipped:
- Warm on boot: `startServer({ alwaysWarm: true })` primes agent against `BOOT_WARMUP_MESSAGE` before session starts.
- Re-warm on change: `scheduleReWarm()` debounced re-warming fires silently on `agentInstructions` changes pre-session, with stale-timer cancellation guard.
- Capture from click one: already in place before this pass (commit `a414f57`, first-turn warmup wait cap + transcript-queue buffering) — verified still correct, no changes needed here.
- Fixed-history pattern (`[primer, "UNDERSTOOD"]`) preserved for prompt-cache efficiency.

## 2. Seed ingestion (the "here's what we have so far" path) — DONE in v0.17.1

Shipped:
- `POST /api/session/seed` accepts `{ text, existingElements? }`.
- Agent runs one seeding turn with layout-focused prompt against `existingElements` (or blank canvas).
- Rejects with 409 if `state.mode === "live"`.

## 3. Reliable steering (fix the guiding options) — DONE in v0.17.1

Shipped:
- Nudge fix: `state.applyNudge` pushes `role: "user"` (not `role: "system"`) to avoid SDK warning/reject.
- Scoped-edit fix: line numbers recomputed from live canvas at turn-execution time (inside `runWhiteboardAgent`), not frozen at HTTP-request time.
- Steering acknowledgment: `nudge:failed` WS broadcast added on all three nudge rejection paths.

## 4. One lifecycle, session language (kill mode soup) — DONE in v0.17.1

Shipped:
- Session intent + `multiSpeaker` boolean: replaces dead `sessionMode` setting; threaded through settings → `startPreso` → `buildEffectiveSystemPrompt`.
- Endpoint rename: `/api/preso/*` routes renamed to `/api/session/*`, with old paths aliased via rewrite middleware for backwards compatibility.
- WS mode additive (IMPORTANT): `mode` field still carries raw session mode (`"staging"`/`"live"`, unchanged), but new `lifecycleMode` field added to same `type: "mode"` message carrying renamed vocabulary (`"setup"`/`"listening"`) for frontend redesign adoption.
- Deferred: `paused`/`review` mode-values follow-up (noted for later lifecycle expansion).

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
