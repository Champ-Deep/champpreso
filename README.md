<h1 align="center">ChampPreso</h1>

<p align="center">
  <em>Realtime visual brainstorming partner. Let the whiteboard whiteboard itself.</em>
</p>

<p align="center">
  A <strong>Champ Suite</strong> product. Part of the <a href="https://championsgroup.com">Champions Group</a> ecosystem.<br/>
  Forked from <a href="https://github.com/kunchenguid/autopreso">autopreso</a> by Kun Chen (MIT).
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Railway%20%7C%20Linux-FF6B35?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/license-MIT-1A1A1A?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/champ%20suite-Ember-FF6B35?style=flat-square" alt="Champ Suite" />
  <img src="https://img.shields.io/badge/status-alpha-FFB088?style=flat-square" alt="Alpha" />
</p>

---

## What it is

You wanted to brainstorm with your team. Not build the deck. Not transcribe notes by hand. Not manage three tabs of diagramming tools.

ChampPreso runs a local web app with a live Excalidraw canvas and a listening agent. You speak, your team speaks, the agent draws and structures what's being said in real time as native, editable Excalidraw shapes and Mermaid diagrams. The result is a beautiful, structured artifact of the conversation that everyone can see, edit, and walk away with.

It is the ideal brainstorming partner for:

- Solo strategic thinking (talk out a problem, get a visual back)
- Team product design sessions (everyone contributes, the canvas captures structure)
- Live presentations to a client (you talk, polished diagrams appear)
- Zoom co-thinking with a partner (transcript captures both voices, agent visualizes)

## The Champ Suite

ChampPreso is part of the [Champ Suite](https://championsgroup.com), a family of AI-native tools built by Champions Group. Sibling products share the Champ Ember (`#FF6B35`) brand language, the Aegis design system, and a common interaction philosophy.

| Product | What it does |
|---|---|
| **ChampPreso** | This. Realtime speech-to-whiteboard with native Mermaid + 12 visual patterns. |
| [ChampGraph](https://github.com/Champ-Deep/champgraph) | Knowledge graph per prospect (Neo4j / FalkorDB). |
| [ChampQuest](https://github.com/Champ-Deep/champquest) | Gamified task management with vault sync. |
| [Champmail](https://github.com/Champ-Deep/champmail) | Email outreach automation with Stalwart SMTP. |
| [ChampVoice](https://github.com/Champ-Deep/champvoice) | Voice qualifying agent (ElevenLabs + Vapi). |
| [ChampDeck](https://github.com/Champ-Deep/champdeck) | AI presentation deck generator. |
| [Champ IQ](https://github.com/Champ-Deep/champiq) | Multi-channel AI SDR orchestration platform. |

All Champ Suite products use the same brand palette, same UI Settings drawer pattern, same provider configuration model, and where it makes sense, the same Aegis dark/light theme tokens.

## Quick start

### Local (Mac, the natural habitat)

```sh
git clone https://github.com/Champ-Deep/champpreso.git
cd champpreso
npm install
npm install -g .
champpreso
```

A browser opens at `http://127.0.0.1:3210`. The dark Aegis panel slides in. Click Start Preso and start talking.

### Cloud (Railway, Render, Fly, anywhere with Node 24+)

```sh
# In your hosting platform's environment variables tab:
GROQ_API_KEY=gsk_your_key_here
GROQ_MODEL=llama-3.3-70b-versatile

# Deploy. The server auto-detects cloud env vars and binds to 0.0.0.0:$PORT.
```

For Railway specifically:

```sh
npm install -g @railway/cli
railway login
railway init
railway up
```

Then open the generated `*.up.railway.app` URL. Browser mic access works because Railway provides HTTPS automatically.

## What's integrated

### Drawing surfaces

- **Excalidraw canvas** as the primary drawing surface, hand-feel and editable
- **Mermaid integration** via `@excalidraw/mermaid-to-excalidraw`: 14 diagram types (flowchart, sequence, state, ER, class, Gantt, mindmap, timeline, Sankey, quadrant, XYChart, C4, journey, block) materialize as editable Excalidraw shapes
- **12 visual patterns** the agent picks from: hub-and-spoke, 2×2 matrix, timeline, flow, tree, stack, side-by-side, causal loop, funnel, spectrum, sticky cluster, annotated screenshot
- **3 canvas zones** declared by the agent: sketches (ideation), structured (diagrams), notes (capture)
- **Icon vocabulary** the agent embeds inside labels (👤 💰 ⚠ ✓ 🎯 etc.)

### Agent providers

Six LLM providers, all OpenAI-compatible at the API surface so swapping is one-click in the UI:

| Provider | Speed | Cost | Setup |
|---|---|---|---|
| **Groq** | 400-800 tok/s on Llama 3.3 70B | Free 14,400 min/day | One env var |
| **Cerebras** | 2000+ tok/s | Free tier + paid | One env var |
| **OpenRouter** | Varies | Pay per token, 200+ models | One env var |
| **OpenAI** | 60-80 tok/s | Paid | One env var |
| **Codex** | Subscription | Free if you have ChatGPT Plus | Sign in via Codex CLI |
| **Ollama** | Local | Free, slow | Local install (won't work in cloud) |

### Transcription engines

- **Moonshine medium** (local Mac, free, mediocre on names)
- **OpenAI Realtime** (cloud, very accurate, low latency, paid)
- **Transcript hygiene** layer filters Whisper hallucinations (Thanks for watching, music tags, repeated tokens, see-you-next-time spam) across every engine
- **Groq Whisper Large v3 Turbo** scaffolding for free streaming-friendly STT (full wire-up in v0.15)

### Live session controls

| Control | Trigger | Effect |
|---|---|---|
| **Interrupt** | Cmd+I or red button | Cancels the in-flight agent turn so you can redirect mid-think |
| **Undo turn** | Cmd+Z or ↶ button | Reverts the agent's last drawing (your manual edits are preserved) |
| **Pin selection** | Cmd+Shift+P or 📌 button | Agent's system prompt sees pinned IDs and never modifies them |
| **Pause Capture** | Space or ❚❚ button | Drops incoming audio without ending the session |
| **Nudge bar** | Cmd+K or click input | One-line steer that injects into the next agent turn |
| **Quick Actions** | Click chip | One-tap pre-baked nudges (Reorganize, Mermaid flow, Add icons, etc.) |
| **Pattern Picker** | Click `+ Patterns` | Force a visual pattern (2×2 matrix, hub-spoke, timeline, etc.) |
| **Clarifying Question Card** | Agent decides | Non-blocking tap-to-answer when the agent is genuinely uncertain |

### Side panel

- **Aegis dark/light** themable from UI Settings
- **Session Mode tabs**: Strategy (solo) / Present (live) / Co-think (multi-speaker)
- **Backlog Pill** with severity states (caught-up / calm / warn / alert)
- **Status state machine** for the agent dot (idle → warming → thinking → drawing → done → error)
- **Notes & Transcripts dropzone** in STAGING: drag .txt/.md/.vtt/.srt/.log/.json/.csv/.html
- **Agent Instructions** textarea for persistent directives
- **UI Settings drawer** with 11 toggles (theme, palette, captions, layouts, micro-interactions, etc.)

### Data lifecycle

- **Auto-save** every 10 seconds to browser localStorage
- **Resume last session toast** on launch if a snapshot from the last 24h exists
- **Pre-turn snapshot** so Undo can revert agent edits cleanly
- **Export** as PNG (2x high-res), SVG, or `.excalidraw` (re-importable)
- **Settings persistence** in `~/.config/champpreso/settings.json` with 0600 file mode

### Reliability

- **30-second per-turn timeout** with retry (down from autopreso's 90s)
- **Loop detection** in every tool execute: same tool with same input 3x = abort
- **Interrupt signal** propagated to every tool so cancellation is instant
- **Session reset clears**: queue + pins + interrupt signal + tool history + cost
- **Provider fallback chain** scaffolded in settings (full runtime wire-up in v0.15)

### Keyboard

| Shortcut | Action |
|---|---|
| `Cmd+I` | Interrupt |
| `Cmd+Z` | Undo last agent turn |
| `Cmd+Shift+P` | Pin selection |
| `Cmd+K` | Focus the Nudge bar |
| `Space` | Pause / Resume capture |
| `Esc` | Close menu / dismiss Question Card |

### Toast notifications

Ephemeral feedback for every successful action. Four variants: success (green ✓), info (blue ⓘ), warn (amber ⚠), error (red ⊘). Glassmorphism + glow. Click to dismiss, auto-fade after 2.4s.

## How seamless is it?

End to end from a cold install:

1. `git clone` + `npm install` + `npm install -g .` — about 30 seconds
2. Set `GROQ_API_KEY` (free) — 60 seconds to get a key from console.groq.com
3. `champpreso` — browser opens, dark Aegis panel appears
4. Click Start Preso
5. Talk for 30 seconds about anything
6. Watch the canvas fill with a structured Mermaid diagram
7. Drag a shape with your mouse — it's a real Excalidraw element
8. Press Cmd+Shift+P to pin it
9. Keep talking — the agent works around your pin
10. Press Cmd+Z to undo the last thing it drew
11. Click Share → PNG to export

That's the whole loop. About 3 minutes from clone to a useful canvas.

## Architecture

```
┌─────────────┐   audio    ┌──────────────┐   text   ┌──────────────┐
│   browser   │──────────► │     STT      │────────► │   agent      │
│   mic       │   24kHz    │  Moonshine / │ chunks   │  6 providers │
│             │            │  OpenAI RT   │          │   OpenAI cmp │
└─────────────┘            └──────────────┘          └──────┬───────┘
                                  │                          │
                            transcript                  tool calls
                            hygiene                          ▼
                                  │            ┌────────────────────┐
                                  └───────────►│  whiteboard tools  │
                                               │  apply / overwrite │
                                               │  mermaid / question│
                                               │  zone / pin / undo │
                                               └──────────┬─────────┘
                                                          ▼
                                               ┌────────────────────┐
                                               │  Excalidraw scene  │
                                               │  + Mermaid render  │
                                               │  + side panel UI   │
                                               └────────────────────┘
```

- Express + WebSocket server (port 3210 local, $PORT cloud)
- Single-page React app via importmap (no bundler)
- All state in `state.elements` on the server; broadcast diffs over WS
- Settings persisted in `~/.config/champpreso/settings.json` (0600)

## Configuration

All settings live in `~/.config/champpreso/settings.json` and are managed from the in-app UI Settings drawer. Environment variables only seed defaults on first run.

See `.env.example` for the complete environment variable reference.

## Deploy to Railway

1. Push this repo to GitHub
2. railway.app → New Project → Deploy from GitHub repo
3. Add `GROQ_API_KEY` (and `GROQ_MODEL`) to the Variables tab
4. Wait ~2 minutes for the first deploy
5. Open the generated URL

Cloud detection (`CHAMPPRESO_CLOUD=1` or any of `RAILWAY_ENVIRONMENT`, `RENDER`, `FLY_APP_NAME`, `NIXPACKS_METADATA`) auto-binds to `0.0.0.0:$PORT` and disables the browser-open hook.

## Acknowledgments

Built on top of an incredible open-source stack:

- [autopreso](https://github.com/kunchenguid/autopreso) by Kun Chen — the project this fork starts from. MIT.
- [Excalidraw](https://github.com/excalidraw/excalidraw) — the whiteboard canvas, scene model, and rendering.
- [Moonshine](https://github.com/usefulsensors/moonshine) by Useful Sensors — the local speech-to-text model that makes the offline path possible.
- [Mermaid](https://github.com/mermaid-js/mermaid) — the declarative diagram syntax.
- [@excalidraw/mermaid-to-excalidraw](https://github.com/excalidraw/mermaid-to-excalidraw) — the converter that makes Mermaid land as editable Excalidraw shapes.
- [Vercel AI SDK](https://github.com/vercel/ai) — tool-calling agent loop and provider abstraction.
- [Groq](https://groq.com) — the LPU silicon that makes 400-800 tok/s inference free.

## License

MIT. See [LICENSE](LICENSE). Upstream attribution retained per Apache-2.0 norms.

## Brand

ChampPreso is part of the Champ Suite design language.

| Token | Hex | Use |
|---|---|---|
| Champ Ember | `#FF6B35` | Primary, CTAs, accent |
| Champ Ember Deep | `#C2410C` | Hover, pressed |
| Champ Ember Glow | `#FFB088` | Highlights on dark |
| Champ Ink | `#0B0D12` | Surface (dark theme) |
| Champ Carbon | `#14171F` | Elevated surface |
| Champ Slate | `#1E222D` | Card backgrounds |

Type: Space Grotesk (display), Inter (body), JetBrains Mono (labels), Caveat (canvas annotations).

---

<p align="center">
  <em>Built by Champions Group. Used everywhere we talk.</em>
</p>
