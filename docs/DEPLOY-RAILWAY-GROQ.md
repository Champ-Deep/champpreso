# Deploying ChampPreso to Railway with Groq

Host ChampPreso on [Railway](https://railway.app) and run the agent on
[Groq](https://groq.com) for ultra-fast (400-800 tok/s) tool-calling. Groq is a
**first-class native provider** in ChampPreso — you do **not** repurpose the OpenAI
provider or override a base URL.

---

## 1. How the agent provider is chosen

ChampPreso seeds `~/.config/champpreso/settings.json` from environment variables **on first
run only**, then the file wins. On an ephemeral cloud container the file is rebuilt from env on
every boot, so env vars are effectively the configuration.

The agent provider is auto-selected from whichever key is present, in this order
(`src/settings-store.js`): `GROQ_API_KEY` → `CEREBRAS_API_KEY` → Codex auth → `OPENROUTER_API_KEY`
→ `OLLAMA_MODEL` → OpenAI. So **setting `GROQ_API_KEY` alone selects Groq** with the default model
`llama-3.3-70b-versatile`. No base-URL override required.

### Speech-to-text on Linux (important)

The local Moonshine STT engine ships as a macOS-only optional binary, and the cloud install runs
`npm ci --omit=optional`, so **Moonshine is unavailable on Railway**. ChampPreso seeds the OpenAI
Realtime STT provider when `OPENAI_API_KEY` is set (`src/settings-store.js`). For a working
voice deploy you therefore need **both**:

| Env var | Purpose |
|---|---|
| `GROQ_API_KEY` | Agent / tool-calling (auto-selects the native `groq` provider). |
| `OPENAI_API_KEY` | Speech-to-text via OpenAI Realtime (Moonshine isn't available on Linux). |

> Without `OPENAI_API_KEY`, the agent still runs on Groq, but microphone transcription will not work
> in the cloud.

---

## 2. Local Groq quick-start

```sh
export GROQ_API_KEY="gsk_your_groq_api_key_here"
# optional: override the default model
export GROQ_MODEL="llama-3.3-70b-versatile"
champpreso
```

Or set it in the in-app **Agent** settings drawer: pick **Groq**, paste the `gsk_...` key, optionally
set the model, and **Save** — it takes effect immediately.

---

## 3. Deploy to Railway

The repo already ships Railway config: `railway.json` (NIXPACKS builder, healthcheck `/api/config`),
`nixpacks.toml`, and a `Procfile`. Cloud is auto-detected via `RAILWAY_ENVIRONMENT`, which binds the
server to `0.0.0.0` and skips the browser-open step (`src/cli-options.js`).

### Step 1 — Push to GitHub

```sh
git remote add origin git@github.com:Champ-Deep/champpreso.git   # if not already set
git push -u origin main
```

### Step 2 — Create the Railway project

1. Log in to [Railway](https://railway.app).
2. **New Project** → **Deploy from GitHub repo** → select `champpreso`.
3. Railway detects NIXPACKS and builds automatically.

### Step 3 — Set Variables

In the service's **Variables** tab:

- `GROQ_API_KEY` — your `gsk_...` key (agent).
- `OPENAI_API_KEY` — your OpenAI key (cloud STT).

`PORT` is injected by Railway automatically — do not hardcode it.

### Step 4 — Public domain

**Settings → Networking → Generate Domain** (or add a custom domain). Railway provisions an
SSL-enabled URL, e.g. `champpreso-production.up.railway.app`.

### Step 5 — Verify

- The Railway deploy goes healthy against `GET /api/config` (returns 200).
- Open the domain: the frontend loads, the WebSocket connects, and a spoken turn drives a canvas
  edit (Groq agent + OpenAI Realtime STT).

---

## 4. Local vs Railway

| Detail | Local (macOS) | Railway (Linux) |
|---|---|---|
| Agent | Any provider | Groq via `GROQ_API_KEY` |
| STT | Moonshine (local binary) or OpenAI Realtime | OpenAI Realtime only (`OPENAI_API_KEY`) |
| Port | `3210` default | Injected via `PORT` |
| Bind / browser | `127.0.0.1`, auto-opens | `0.0.0.0`, no auto-open (cloud-detected) |
| Settings | `~/.config/champpreso/settings.json` | Ephemeral; re-seeded from env each boot |

---

## 5. Groq model notes

- `llama-3.3-70b-versatile` (default) — strong, accurate tool-calling at high speed.
- Other Groq-hosted models work too; set `GROQ_MODEL` or the in-app model field. The field is free
  text, so use whatever Groq currently serves.

For even lower latency, Cerebras is also a native provider — set `CEREBRAS_API_KEY`
(default model `llama-3.3-70b`).
