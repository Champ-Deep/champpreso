# ChampPreso API + WebSocket Contract

**As of:** 2026-07-08, v0.17.1 (verified against `src/server.js` and `src/whiteboard-session.js`)
**Server:** Express on `http://127.0.0.1:3210`, WebSocket at `ws://127.0.0.1:3210/ws`

Endpoint names still say "preso"; a rename to session-language is planned (see `04-BACKEND-ROADMAP.md`). Design against the semantics, not the names.

## REST endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/config` | GET | Transcription engine label + sanitized settings (no API keys) |
| `/api/settings` | GET / PUT | Read / update settings incl. `agentInstructions` (the session intent) |
| `/api/session/reset` | POST | Full reset: clears canvas, cost, session token |
| `/api/preso/start` | POST | Setup → Listening. Builds seed primer from canvas, snapshots intent, starts warmup |
| `/api/preso/back-to-staging` | POST | Listening → Setup |
| `/api/preso/warmup/cancel` | POST | Cancel in-flight warmup |
| `/api/preso/pause` / `resume` | POST | Pause / resume capture |
| `/api/preso/interrupt` | POST | Abort the in-flight agent turn |
| `/api/preso/undo-turn` | POST | Revert the last agent turn's canvas changes |
| `/api/preso/nudge` | POST `{text}` | Mid-session steering (the steer bar) |
| `/api/preso/say` | POST `{text}` | Inject typed text as if spoken |
| `/api/preso/answer` | POST | Answer an agent question card |
| `/api/preso/pin` / `unpin` / `pins/clear` | POST | Protect elements from agent edits |
| `/api/preso/scoped-edit` | POST | Agent edit constrained to selected elements |
| `/api/preso/smart-stt` | POST | Toggle smart transcript filtering |
| `/api/session/current-canvas` | GET | In-memory canvas state (v0.17) |
| `/api/session/last-backup` | GET | Last disk snapshot, 404 if none (v0.17) |
| `/api/session/restore-backup` | POST | Load disk snapshot onto canvas + broadcast (v0.17) |

## WebSocket messages, server → client

| Type | Payload | UI concern |
|---|---|---|
| `whiteboard:update` | `elements` | Reflect into Excalidraw |
| `whiteboard:viewport` | viewport hint | Camera moves |
| `mode` | `mode: "staging"\|"live"` | Lifecycle state |
| `warmup` | warmup state | Ambient readiness glyph |
| `warmup:error` | error | Readiness problem indicator |
| `agent:status` | status string | Status strip activity |
| `agent:turn-start` / `turn-end` / `turn-error` | `turnId, transcript, timestamp` | Activity pulse, error toast |
| `agent:question` / `question-resolved` | question w/ options | Question card |
| `agent:interrupted` | reason | Confirm interrupt |
| `agent:undone` | id | Confirm undo |
| `agent:zone` | zone | Zone chip (sketches / structured / notes) |
| `transcript:partial` / `transcript:committed` | text | Live captions |
| `stt:dropped` / `stt:smart-mode` | reason / enabled | Caption filtering feedback |
| `queue:stats` | stats | Backlog pill |
| `capture:paused` | `paused: bool` | Paused indicator |
| `pin:changed` | `id, pinned, all` | Pin badges |
| `nudge:applied` | text | Steer confirmation |
| `scoped-edit:applied` | payload | Scoped edit confirmation |
| `mermaid:render` | diagram | Mermaid render pipeline |
| `cost` | session cost summary | Cost card |
| `settings` / `config` | sanitized settings | Settings sync |
| `error` | message | Error toast |

## WebSocket, client → server

Audio frames (24 kHz PCM16 base64) tagged with a browser-generated `sessionId`, plus periodic downscaled canvas screenshots (`whiteboard:screenshot`). Stale-session frames are rejected server-side by token; the frontend does not need to handle that beyond reconnect.

## Invariants the frontend must respect

1. In Listening (live) mode the **server owns element state**. Local user edits sync up, but `whiteboard:update` is the truth.
2. In Setup (staging) the **client owns the canvas**; the server does not track it until start.
3. One in-flight agent turn max; extra speech buffers and concatenates. Never show a "queue" of turns.
4. Settings API keys never reach the client (`getSanitized()`); never render or request them.
