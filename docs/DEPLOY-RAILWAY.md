# Deploying ChampPreso to Railway (OpenRouter)

Host ChampPreso on [Railway](https://railway.app) with [OpenRouter](https://openrouter.ai) as the
agent provider. OpenRouter is the standard for ChampPreso: one key, many models, dial cost vs quality
per task. Groq and Cerebras remain available as fast-lane alternatives (see the end).

---

## 1. How the agent provider is chosen

ChampPreso seeds `~/.config/champpreso/settings.json` from environment variables **on first run
only**, then the file wins. On an ephemeral cloud container the file is rebuilt from env on every
boot, so env vars are effectively the configuration.

The agent provider is auto-selected from whichever key is present, in this order
(`src/settings-store.js`): `GROQ_API_KEY` → `CEREBRAS_API_KEY` → Codex auth → `OPENROUTER_API_KEY`
→ `OLLAMA_MODEL` → OpenAI. If you set **only** `OPENROUTER_API_KEY`, the provider is `openrouter`.

### Variables you set in Railway

| Variable | Required? | Value |
|---|---|---|
| `OPENROUTER_API_KEY` | **Yes** | Your `sk-or-...` key from [openrouter.ai/keys](https://openrouter.ai/keys). Selects the OpenRouter agent. |
| `OPENROUTER_MODEL` | Optional | Defaults to `deepseek/deepseek-v4-flash` (cheap, tool-calling capable). Override with any OpenRouter slug. |
| `OPENAI_API_KEY` | Only for cloud voice | Speech-to-text via OpenAI Realtime. See the STT note below. |

`PORT` is injected by Railway automatically — do not set it. `RAILWAY_ENVIRONMENT` is detected
automatically and makes the server bind `0.0.0.0` and skip the browser-open step
(`src/cli-options.js`).

### Picking an OpenRouter model

The single production LLM job is the live whiteboard agent (warmup + every turn, same model). It
needs reliable tool-calling under realtime latency:

- `deepseek/deepseek-v4-flash` — **default**; tool-calling capable, 1M context, ~$0.09/$0.18 per 1M
  tokens. The cost-effective pick for long sessions.
- `deepseek/deepseek-v4-pro` — same family, higher quality, still far cheaper than the Claude/GPT tier.
- `anthropic/claude-3.5-sonnet` — strongest tool-calling, but ~30–80× the cost of DeepSeek Flash.
- `meta-llama/llama-3.3-70b-instruct:free` — $0, weaker tool-calling — fine for testing, not a demo.

The model field is free text — use any current OpenRouter slug.

### Speech-to-text on Linux (important)

OpenRouter is text-only; it has **no speech-to-text**. The local Moonshine STT engine ships as a
macOS-only optional binary and the cloud install runs `npm ci --omit=optional`, so **Moonshine is
unavailable on Railway**. ChampPreso starts cleanly anyway — if STT can't initialize it logs
"voice input is disabled" and keeps serving (so the agent and healthcheck still work), but the
microphone won't transcribe until you set `OPENAI_API_KEY`, which seeds the OpenAI Realtime STT
provider (`src/settings-store.js`). For a working **voice** deploy you therefore need:

| Env var | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Agent / tool-calling (the brain). |
| `OPENAI_API_KEY` | Speech-to-text via OpenAI Realtime (the ears — Moonshine isn't available on Linux). |

> Without `OPENAI_API_KEY` the app still loads and the agent runs; only cloud mic transcription is off.

---

## 2. Local OpenRouter quick-start

```sh
export OPENROUTER_API_KEY="sk-or-your-key-here"
# optional: override the default model (defaults to deepseek/deepseek-v4-flash)
export OPENROUTER_MODEL="deepseek/deepseek-v4-flash"
champpreso
```

Or set it in the in-app **Agent** settings drawer: pick **OpenRouter**, paste the key, optionally set
the model, and **Save** — it takes effect immediately.

---

## 3. Deploy to Railway

The repo ships Railway config: `railway.json` (NIXPACKS builder, healthcheck `/api/config`),
`nixpacks.toml`, and a `Procfile`.

### Option A — Deploy from local with the Railway CLI (no GitHub needed)

```sh
railway init --name champpreso        # creates + links a project
railway up                            # builds with NIXPACKS and deploys this directory
railway domain                        # generates a public SSL domain
```

Then add `OPENROUTER_API_KEY` (and optionally `OPENROUTER_MODEL` / `OPENAI_API_KEY`) in the
service's **Variables** tab. Saving a variable auto-redeploys the existing image and it goes healthy.

> Note: `railway up` uploads the working directory respecting `.gitignore` (so `node_modules` is
> excluded). A deploy with no agent key will build fine but fail the healthcheck — that's expected;
> it recovers as soon as `OPENROUTER_API_KEY` is set.

### Option B — Deploy from GitHub

1. Push the repo to GitHub.
2. Railway → **New Project** → **Deploy from GitHub repo** → select it (NIXPACKS auto-detected).
3. Add the same Variables, generate a domain.

### Verify

- The deploy goes healthy against `GET /api/config` (returns 200).
- Open the domain: the frontend loads, the WebSocket connects, and (with `OPENAI_API_KEY` set) a
  spoken turn drives a canvas edit.

---

## 4. Local vs Railway

| Detail | Local (macOS) | Railway (Linux) |
|---|---|---|
| Agent | Any provider | OpenRouter via `OPENROUTER_API_KEY` |
| STT | Moonshine (local binary) or OpenAI Realtime | OpenAI Realtime only (`OPENAI_API_KEY`); none → voice disabled, app still healthy |
| Port | `3210` default | Injected via `PORT` |
| Bind / browser | `127.0.0.1`, auto-opens | `0.0.0.0`, no auto-open (cloud-detected) |
| Settings | `~/.config/champpreso/settings.json` | Ephemeral; re-seeded from env each boot |

---

## 5. Fast-lane alternatives (optional)

Both are native OpenAI-compatible providers and auto-select ahead of OpenRouter if their key is set:

- **Groq** — `GROQ_API_KEY`, 400–800 tok/s, default model `llama-3.3-70b-versatile` (`GROQ_MODEL` to override).
- **Cerebras** — `CEREBRAS_API_KEY`, 2000+ tok/s, default model `llama-3.3-70b` (`CEREBRAS_MODEL` to override).

Both run open-weight Llama. The same STT caveat applies — they don't do speech-to-text either.
