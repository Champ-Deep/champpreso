# ChampPreso Frontend Handoff #2: Ask, Memory, and the Knowledge Base

**Owner:** Claude (engineering side), reviewed by Deep
**Supersedes nothing.** This extends `02-FRONTEND-HANDOFF.md` — that document still describes the Setup / Listening / Review shell, which is unchanged. This one covers what landed since, and what is now blocked on design.

**Status key:** ✅ built and verified · 🟡 backend done, needs frontend · ⬜ not started

---

## Where things stand

Since the last handoff the product gained a second agent and a memory layer. The one-sentence version:

> The whiteboard no longer only *draws* what you say. You can now **ask it things**, and it answers using a structural read of the board, the conversation, the web, and your own files.

That has design consequences the current shell doesn't yet cover, and it's left four earlier ideas half-built. Everything below is either a decision you need to make or a screen that needs drawing.

### Already built (context, not work)

| | Thing | Where it lives |
|---|---|---|
| ✅ | **Ask panel** — cyan `?` on the steer bar, opens a question row; answers render in a card with sources and a "Put on board" button | `public/screens/ask-panel.js`, shared by Listening and Review |
| ✅ | **Board semantics** — the agent reads zones, their contents, and the arrows between them, not raw shape JSON | `src/whiteboard-semantics.js` |
| ✅ | **Groq LPU transcription** — third option in the transcription control | Settings → Transcription |
| ✅ | **Live model catalog** — pickers read the provider's real model list; amber warning + one-click fix when a configured model is retired | Settings → Agent / Ask Agent |
| ✅ | **Ask Agent settings block** — model, web-search toggle, knowledge-base folders | Settings sheet |

---

## Part A — the four paused items

These were approved earlier and stalled. The logic is written and tested; each needs a design decision before it can be wired.

### A1. Dot-grid canvas texture ⬜ — smallest, do first

The design source already specifies it and we never implemented it:

```html
<!-- docs/design-handoff/frontend-source/ChampPreso-Shell.dc.html:36 -->
<div style="position:absolute;inset:0;
     background-image:radial-gradient(circle,#ECEAE4 1px,transparent 1px);
     background-size:26px 26px">
```

**Open question for you:** the spec colour `#ECEAE4` is a light-mode dot on a light ground. Our canvas is Excalidraw's own surface and the panels around it are dark. Does the grid stay light-on-light (subtle, paper-like) in both themes, or does it invert with `panelTheme`?

**Also:** should the grid persist into Listening, or fade once the session starts? A visible grid reads as "workspace, still setting up"; losing it could be a nice signal that the room has gone live. Your call — it's one CSS class either way.

### A2. Reference notes 🟡 — backend fully wired, zero UI

`settings.notesAndTranscripts` (200,000 char cap) is saved, persisted, and fed into the agent's staging primer on every session start. **Nothing in the UI writes to it.** It is dead weight until you design the surface.

What it's for: dropping last month's transcript, a strategy doc, or a competitor teardown into the session so the agent has context the room won't say out loud.

`public/app.js` already implements the handlers — they just aren't rendered anywhere:

- `handleNotesAndTranscriptsChange` — 600ms debounced save
- `handleNotesDrop` — accepts `.txt .md .markdown .vtt .srt .log .json .csv .html`, stamps each file with `\n\n---\n# {filename}\n---\n\n`
- `clearNotesAndTranscripts`

**What to design:** a drop zone on the Setup rail. Needs to convey "files land here" without dominating a rail that's already carrying intent, templates, palette, and Start. Consider a collapsed strip that expands on drag-over.

**Please specify:** how a loaded file is represented once dropped. The backend stores one flat string, so "3 files loaded" is a display convenience, not a data structure — if you want individually removable file chips, say so and I'll change the storage shape to an array. That's a real decision, not a detail.

> ⚠️ **This overlaps with the knowledge base (Part B).** Notes are *this session's* reference material; the knowledge base is *standing* reference material. Two inputs that look similar and mean different things is a recipe for confusion. See B2 — I'd like your read on whether they should merge.

### A3. Carry actions forward 🟡 — `buildCarryoverElements()` written and committed

Review extracts decisions (`POST /api/session/review` → `{ decisions[], summary }`). Today they're read once and lost. `buildCarryoverElements(decisions)` turns them into a labelled sticky column on the next session's canvas — capped at 12, `tpl-` prefixed so a template swap or Clear removes them like any other skeleton.

**What to design:**

1. **The Review affordance.** A "Carry forward" control next to "New session". Does it carry *all* decisions, or does each decision get a checkbox? Checkboxes are more correct and more clicks — for a team standing up to leave a room, "carry all, prune on the canvas" may be the better trade.
2. **The Setup echo.** When the next session opens with carried stickies, the user needs to understand where they came from. A dismissible "Carried 4 decisions from your last session" ribbon, or is the on-canvas "Carried from last session" heading enough?

### A4. Save canvas as template 🟡 — `sceneToTemplateElements()` + `settings.customTemplates` written

Turns the current canvas into a reusable template alongside the five built-ins, re-id'ing every element and rewriting bound-text containers, arrow bindings and frames so the structure survives a round trip.

**What to design:**

1. **The save trigger.** Where does "save this as a template" live? It's a Setup-screen action about the canvas, but the Setup rail is full.
2. **Naming.** Inline rename on the chip, or a small dialog? Template labels are capped at 24 characters by the existing chip test — designing for longer means changing that constraint.
3. **Custom vs built-in chips.** Distinguished, or a flat row? Custom templates need a delete affordance that built-ins don't have.
4. **Empty state.** Before anyone saves one, is there a visible "save your own" prompt, or does the feature stay invisible until discovered?

---

## Part B — new, from the Ask work

### B1. Knowledge base folder picker 🟡 — currently a comma-separated text field

Today: `~/Documents/ChampPreso-KB, ~/notes` typed into a text input. It works and it's honest, but it's a developer affordance, not a product one.

The backend indexes `.md .markdown .txt .json .csv .html .htm .log .vtt .srt` recursively (6 levels, 2000 file cap, 2M char cap), scores by keyword with light stemming, and returns excerpts with `file:line` citations. No embeddings, no network — nothing leaves the machine to build the index.

**What to design:** folder chips with a remove affordance, plus feedback on what got indexed ("2 folders · 340 files · 1.2M characters"). The backend can report that — `ensureIndexed()` already returns `{ fileCount, chunkCount, totalChars, truncated }` — it's just not surfaced. The `truncated` flag matters: silently indexing half of someone's notes and never saying so is exactly the kind of quiet failure we've been designing against.

**Not possible from the browser:** a native folder picker. The File System Access API can't hand us a stable path for the server to re-read later. Options are (a) type/paste a path, as now, (b) drag a folder onto a drop zone and read `webkitRelativePath`, (c) add a small server endpoint that opens a native dialog. (c) is the good experience; tell me if it's worth the endpoint.

### B2. Notes vs knowledge base — a decision I'd like from you

Two inputs, both "reference material", different lifetimes:

| | Reference notes (A2) | Knowledge base (B1) |
|---|---|---|
| Scope | This session | Standing, every session |
| Storage | One flat string in settings | Folder paths, indexed on demand |
| Reaches | The **drawing** agent, via the staging primer | The **ask** agent, via a search tool |
| Size | 200K chars | 2M chars |

A user will not intuit that difference from two similar-looking fields. Three ways out:

1. **Keep both, separate them hard** — notes on the Setup rail (session-scoped, ephemeral), knowledge base in Settings (standing config). Different screens, different language. Cheapest.
2. **Merge into one "Context" surface** with a session/permanent toggle per item. Cleanest mental model, most work, and needs backend changes.
3. **Drop notes entirely** and let the knowledge base serve both, with a session-scoped folder. Simplest surface; loses the drag-a-transcript-in-right-now flow that notes was built for.

I lean 1 for now and 2 eventually. Your call.

### B3. MCP knowledge-base servers ⬜ — no UI at all

`settings.knowledgeBase.mcpServers` accepts stdio (`{ name, command, args, env }`) or HTTP (`{ name, url }`) servers, discovers their tools at boot, namespaces them `kb__<server>__<tool>`, and hands them to the ask agent. Failures degrade gracefully and are reported per server.

Right now the only way to configure one is hand-editing `~/.config/champpreso/settings.json`.

**What to design:** this is the hardest surface in the doc, because honest MCP config is genuinely technical (a command, arguments, environment variables). Two paths:

- **Advanced-only:** a JSON textarea behind a disclosure, with validation and per-server status dots. Honest, ugly, ships in a day.
- **Curated presets:** "Connect Notion", "Connect Google Drive" buttons that fill in known configs, with a "custom" escape hatch. Much better, and it means picking which integrations we bless.

Given the Champions Group use case — team strategy sessions that want to reference the actual strategy docs — I'd argue presets for Notion and Drive earn their keep. **Please advise.**

### B4. Ask panel, second pass ⬜

The panel works. These are the gaps hands-on use will expose:

- **No streaming.** The answer appears all at once after 3–8 seconds with only a spinner. A streamed answer would feel dramatically faster for zero change in actual latency. Backend change is small; needs you to decide whether the card grows as it streams or reserves height.
- **One answer at a time.** A new question replaces the last. In a real discussion people ask three things in a row and want to look back. Does the panel become a short scrollback? Where does it live — it's already competing with the steer bar for the bottom of the screen.
- **No voice path.** You can *speak* to the board but must *type* to ask it. "Hey board, what did we decide?" is the natural gesture and we don't support it. Needs a wake phrase and a design for how a question is distinguished from ordinary speech — which is a genuinely hard interaction problem, so flagging it rather than assuming.
- **Answers aren't in the review.** Questions asked mid-session vanish when it ends. If someone asked "what's our churn number" and got an answer, that belongs in the session record.
- **No cost visibility.** Ask spend rolls into the agent line in the cost drawer. Web search is roughly 2¢ a question — a separate line would make that legible before someone is surprised by it.

### B5. Answers are broadcast — the multi-user story is unfinished ⬜

`agent:answer` goes to every connected client, deliberately: on a shared whiteboard a private answer is a worse answer. But the UI has no notion of *who asked*. In a room with three laptops, an answer appears on everyone's screen with no attribution.

**What to design:** either attribute questions (needs identity, which we don't have) or make the shared-ness legible some other way. Related: `multiSpeaker` exists in settings and the agent is told to attribute distinct voices, but nothing in the UI shows speaker attribution. There's a coherent "who's in this session" feature here that we've been skirting.

---

## What I need from you, ranked

1. **B2** — notes vs knowledge base. Blocks A2 and B1 both; everything else is downstream of getting this concept right.
2. **A3 + A4** — Setup rail placement. The rail is full and these add two more controls. It may need reorganising rather than extending, which is a design problem, not an engineering one.
3. **B3** — MCP presets or advanced-only.
4. **A1** — dot grid. Two questions, one CSS class, no dependencies. Free win.
5. **B4** — ask panel second pass, once you've watched someone actually use the first one.

## Reference

- API contract: `docs/design-handoff/03-API-CONTRACT.md` — add `POST /api/session/ask`, `POST /api/session/ask/clear`, `GET /api/models`, `GET /api/models/verify`
- Existing shell + tokens: `docs/design-handoff/02-FRONTEND-HANDOFF.md`
- Ask panel component: `public/screens/ask-panel.js`
- Template helpers: `public/brainstorm-templates.js` (`buildCarryoverElements`, `sceneToTemplateElements`)
- Colour note: steering and typing use ember (`--champ-ember`) because they change the board; asking uses cyan (`#22D3EE`) because it doesn't. Worth keeping that distinction if you extend either surface.
