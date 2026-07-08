# ChampPreso Frontend Handoff

**For:** Frontend designer (Claude design session or human)
**Read first:** `01-PRODUCT-BRIEF.md` (the repositioning), `03-API-CONTRACT.md` (what the backend speaks)
**Repo:** `~/Apps&Projects/Champ-preso` | GitHub: Champ-Deep/champpreso

---

## 1. Design mandate

Redesign the UI around one idea: **the canvas is the meeting's second brain, and the chrome should disappear.** Today's UI accumulated presentation-tool cruft across versions. You are not restyling it. You are rebuilding the shell around the existing Excalidraw canvas and the existing WebSocket protocol.

Principles, in priority order:

1. **Canvas is the hero.** Persistent chrome should be nearly invisible during a live session. Target: less than 8% of screen area when listening.
2. **Zero fiddling mid-meeting.** Anything the user must do during a meeting is one click or one short typed sentence. Everything else is pre-meeting setup or post-meeting review.
3. **Always-ready.** The UI never shows a "warming up" wall. Readiness is ambient (a small status glyph), never a gate the user waits behind.
4. **Business-person legible.** No jargon: no "staging," no "preso," no "turns," no "STT." Say "Setup," "Listening," "Paused," "Review."

## 2. The session lifecycle (replaces all three mode systems)

One linear lifecycle with a single visible state:

```
SETUP  →  LISTENING  ⇄  PAUSED  →  REVIEW
  ↑                                   |
  └────────────── new session ────────┘
```

| State | User sees | Canvas | Mic |
|---|---|---|---|
| **Setup** | Seed area + session intent field + one big "Start listening" action | Editable by user (seed content) | Off |
| **Listening** | Nearly bare canvas, minimal status strip, steer field | Agent draws live, user can also edit | On |
| **Paused** | Same as Listening with a clear paused indicator | User edits freely, agent holds | Off |
| **Review** | Canvas + export + summary + "what got decided" block | Frozen unless edited | Off |

Kill list (all currently in `public/app.js` and `style.css`):

| Kill | Today's name | Why |
|---|---|---|
| Staging/Preso toggle | `mode-toggle-option` tabs | Replaced by lifecycle above |
| Present/Work caption FAB | `CaptionFab` (~line 3781) | Presentation-era concept |
| Strategy/Present/Co-think session-mode tabs | `sm-tab` (~line 1624) | Collapses into session intent. Multi-speaker handling becomes a Setup checkbox ("Multiple speakers"), not a mode |
| Onboarding ribbon | `OnboardingRibbon` | Rebuild as a one-time Setup hint |
| "Preso" language everywhere | strings across app.js | Rename per state table above |

Keep list (working, users rely on them):

| Keep | Today's name | Notes |
|---|---|---|
| Live captions of transcript | caption pill | Restyle, keep presentation-mode legibility as an option |
| Steer bar | `NudgeBar` (~line 3248) | Promote: this is the primary mid-meeting control |
| Agent question cards | `QuestionCard` (~line 3399) | 2-3 tap options when the agent needs attribution or a decision. Keep top position, make dismissal effortless |
| Pin elements | pin API | "Don't touch this" gesture on canvas elements |
| Undo agent turn | undo-turn API | One-click "undo what it just drew" |
| Export menu | `ExportMenu` (~line 3494) | Grows in Review state: PNG, SVG, summary |
| Cost card | `CostCard` | Move into a collapsed status drawer |
| Waveform / mic status | `Waveform` (~line 2234) | Shrink into the status strip |
| Settings editors | `AgentEditor`, `TranscriptionEditor`, `MicEditor`, `UISettingsPanel` | Consolidate into one settings surface, pre-meeting only |
| Restore last session | `/api/session/last-backup` + `restore-backup` | NEW since v0.17: surface as "Restore last session" in Setup. Disk snapshots exist server-side; the UI for choosing one can come later |

## 3. The Setup screen (new, most important design work)

Today's staging mode is a blank canvas plus buried settings. Replace with a real Setup surface:

1. **Session intent** field, front and center. Placeholder examples: "Get to a concrete Q3 plan for Lake Stream" / "Map every objection in this renewal call." This maps to `agentInstructions` in the settings API.
2. **Seed area**: paste text or drop prior notes; the seed renders onto the canvas before the session starts (backend support incoming, see `04-BACKEND-ROADMAP.md`; today, seeding = drawing/pasting directly on the staging canvas, which stays supported).
3. **Multiple speakers** toggle (replaces Co-think mode).
4. **Restore last session** entry point.
5. One primary action: **Start listening**. No secondary competing CTAs.
6. Ambient readiness glyph: agent warm/cold, mic device, transcription engine. Informational, never blocking.

## 4. Brand and visual constraints

| Token | Value |
|---|---|
| Primary (Champ Ember) | `#FF6B35`, meaning "active concept," used sparingly |
| Panel theme | Dark default (`panelTheme: "dark"` in settings) |
| Canvas | Excalidraw default light unless themed; do not fight Excalidraw's own styling |
| Type | System stack today; you may propose one display face, keep body system |
| Hard rule | Check contrast on every dark/colored surface. Text explicitly light on dark. No em-dashes in UI copy |

## 5. Technical constraints (read carefully, these are unusual)

1. **No build step.** The frontend is plain ES modules loaded via `<script type="importmap">` from esm.sh. React without JSX (`React.createElement` calls) in one file: `public/app.js` (~4,000 lines). CSS in `public/style.css` (~70KB). You may propose splitting into more ES module files (the pattern supports it: `transcript-panel.js`, `starter-elements.js` already exist), but no bundler, no JSX, no npm frontend deps.
2. **Excalidraw is embedded** and owns the canvas. The server owns element state during a live session and pushes `whiteboard:update` over WS; the frontend reflects it into Excalidraw. Do not redesign canvas internals.
3. **State comes over WebSocket.** All live UI state (agent status, turns, questions, captions, cost, pins, zones) arrives as WS messages. Full message catalog in `03-API-CONTRACT.md`. Design against those events; do not invent new ones without flagging them as backend asks.
4. **Mic capture** runs at 24 kHz in the browser and streams frames over the same WS. The mic permission moment deserves design attention (first-run experience).
5. Single local user, one browser tab, Mac Chrome. No responsive/mobile requirement. Optimize for a laptop sharing screen real estate with Zoom.

## 6. Deliverables expected from the design pass

1. Screen designs for the four lifecycle states (Setup, Listening, Paused, Review).
2. The status strip: readiness, mic, agent activity, cost, in minimal footprint.
3. Steer bar interaction: idle, typing, applied confirmation, failed.
4. Question card interaction: appear, answer, dismiss, timeout.
5. Component-level redline against the keep list in section 2.
6. Updated `style.css` design tokens block (custom properties) as the single theming source.

## 7. What NOT to touch

`src/` (backend), the WS protocol, Excalidraw internals, `settings.json` schema, the warmup system (being rebuilt server-side, see roadmap). If a design need requires a backend change, write it as an explicit ask in the handback.
