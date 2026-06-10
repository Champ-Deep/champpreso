# ChampPreso. Setup Notes.

> A Champions Group project. The README has the full story. This file is the speed-run.

## Mac one-shot install

```sh
cd ~/Apps\&Projects/Champ-preso     # wherever you extracted this fork
npm install                          # installs all deps + the darwin-arm64 Moonshine sidecar
npm install -g .                     # registers `champpreso` globally on your $PATH
champpreso                           # boots the server, opens the browser
```

Node 24 or newer is required. Check with `node -v`. If you are on an older Node, install nvm and `nvm install 24`.

## Provider matrix

| Provider | When | How |
|---|---|---|
| **OpenRouter** | Default daily driver. One key, many models. | `export OPENROUTER_API_KEY=sk-or-v1-...` then `champpreso`. |
| **Groq** | Fast lane. 400-800 tok/s Llama tool-calling, cloud-friendly. | `export GROQ_API_KEY=gsk_...; champpreso`. Default model `llama-3.3-70b-versatile` (`GROQ_MODEL` to override). |
| **Cerebras** | Fastest lane. 2000+ tok/s on wafer-scale silicon. | `export CEREBRAS_API_KEY=csk-...; champpreso`. Default model `llama-3.3-70b` (`CEREBRAS_MODEL` to override). |
| **Ollama** | Offline, sensitive content, demos with no internet. | `brew install ollama; ollama serve &; ollama pull qwen2.5:14b; export OLLAMA_MODEL=qwen2.5:14b; champpreso`. |
| **OpenAI** | When you want OpenAI Realtime STT alongside the agent. | `export OPENAI_API_KEY=sk-...; champpreso`. |
| **Codex** | Free if you already pay for ChatGPT Plus/Pro. | `npm i -g @openai/codex; codex; champpreso`. |

> Deploying to the cloud? See [docs/DEPLOY-RAILWAY.md](docs/DEPLOY-RAILWAY.md) for the Railway +
> OpenRouter runbook (and why cloud voice also needs `OPENAI_API_KEY` for STT).

## OpenRouter setup, step by step

1. Sign up at https://openrouter.ai and add a balance. Anthropic Claude and OpenAI GPT-5.x are paid per token. Llama 3.3 70B has a generous free tier through OpenRouter.
2. Generate a key at https://openrouter.ai/keys. Label it `champpreso` for your records.
3. Two ways to wire it:

   **Way A. Env var (recommended).** Add to `~/.zshrc`:

   ```sh
   export OPENROUTER_API_KEY="sk-or-v1-paste-it-here"
   export OPENROUTER_MODEL="anthropic/claude-3.5-sonnet"
   ```

   Reload with `source ~/.zshrc`, then `champpreso`.

   **Way B. In-app panel.** Launch `champpreso` first. In the side panel, click the Agent row, pick `OpenRouter`, paste the key, set the model, hit Save.

4. The model field is free text. Pick anything OpenRouter lists. Good defaults for live whiteboarding:

| Model slug | Strength |
|---|---|
| `anthropic/claude-3.5-sonnet` | Best balance for tool-calling under realtime pressure. |
| `anthropic/claude-3.7-sonnet` | Marginally smarter, slightly slower. |
| `openai/gpt-5.5` | Strong all-rounder, sometimes overdrives the canvas. |
| `google/gemini-2.5-pro` | Fast, cheap, occasionally creative. |
| `meta-llama/llama-3.3-70b-instruct` | Free tier through OpenRouter, weaker tool-calling. |

## Ollama setup, step by step

1. `brew install ollama`
2. Start the daemon: `ollama serve &`. The first run downloads the runtime; later runs are instant.
3. Pull a tool-capable model:

   ```sh
   ollama pull qwen2.5:14b        # ~9 GB, best baseline
   # or
   ollama pull llama3.1:8b        # ~5 GB, lighter
   # or
   ollama pull mistral-nemo:12b   # ~7 GB
   ```

4. Either:

   ```sh
   export OLLAMA_MODEL="qwen2.5:14b"
   champpreso
   ```

   Or pick `Ollama (local)` in the in-app panel and type the model name.

5. Local mode caveats:
   - Agent quality is materially weaker than Claude or GPT-5 for fast tool-calling. Reasonable for offline demos, not your investor pitch.
   - Keep `ollama serve` running. If you killed it, the agent will fail with "fetch failed" until you restart it.
   - Local Moonshine STT is the default. To verify it works, talk into the panel and watch the transcript stream.

## Settings file

Everything lives at `~/.config/champpreso/settings.json` (mode `0600`).

```json
{
  "agent": {
    "provider": "openrouter",
    "openai": { "model": "gpt-5.5", "reasoningEffort": "low", "baseURL": "https://api.openai.com/v1" },
    "codex": { "model": "gpt-5.5-fast" },
    "ollama": { "model": "", "baseURL": "http://localhost:11434/v1" },
    "openrouter": { "model": "anthropic/claude-3.5-sonnet", "baseURL": "https://openrouter.ai/api/v1" }
  },
  "transcription": { "provider": "moonshine", "moonshine": { "model": "medium" } },
  "apiKeys": { "openai": "", "openrouter": "sk-or-v1-..." },
  "agentInstructions": ""
}
```

Edit the file directly if you want, or use the in-app panel. Either way takes effect on the next Start Preso.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `command not found: champpreso` | Global install did not link, or PATH does not include `npm bin -g`. | `npm install -g .` from the project folder. Then `which champpreso`. |
| `Whiteboard agent is not configured` | No API key found for the selected provider. | Set the matching env var or paste a key in the panel. |
| `fetch failed` mid-preso (Ollama) | The Ollama daemon stopped. | `ollama serve &` in a separate terminal. |
| Hero canvas is blank | Excalidraw failed to load from the CDN. Check the browser console. | First-run only. Refresh once with internet. |
| `Codex CLI auth not found` | You picked Codex but never signed into Codex CLI. | `codex` once, then relaunch. |

## Privacy

ChampPreso binds to `127.0.0.1` only. The browser, the agent, and the transcription pipeline all talk over loopback. The only cloud calls are agent and transcription requests, and only when you pick a cloud provider. Ollama plus Moonshine is fully offline.

## Champions Group brand

The orange you see in the side panel is `#F26722`. Hover state is `#D94F0A`. White surface, Ink `#1A1A1A` text. Same as the parent brand.
