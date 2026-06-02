#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import open from "open";

import { resolveAgentProviderFromSettings } from "./agent-provider.js";
import { parseCliArgs } from "./cli-options.js";
import { startServer } from "./server.js";
import { createSettingsStore } from "./settings-store.js";

const SETTINGS_PATH = path.join(os.homedir(), ".config", "champpreso", "settings.json");
const BRAND_NAME = "ChampPreso";
const BRAND_TAGLINE = "Let the whiteboard whiteboard itself.";
const BRAND_ORG = "Champions Group";

async function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error("Run `champpreso --help` for usage.");
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    printHelp();
    return;
  }

  const settingsStore = createSettingsStore({ filePath: SETTINGS_PATH });
  const settings = await settingsStore.load();

  let agentProvider;
  try {
    agentProvider = resolveAgentProviderFromSettings({ settings, env: process.env });
  } catch (error) {
    console.error(`Whiteboard agent is not configured: ${error.message}`);
    console.error("Open the app and configure the agent in the status panel, or set OPENROUTER_API_KEY / OPENAI_API_KEY / OLLAMA_MODEL in your shell.");
    console.error(`Settings file: ${SETTINGS_PATH}`);
    process.exitCode = 1;
    return;
  }

  if (settings.transcription.provider === "openai" && !(settings.apiKeys?.openai || process.env.OPENAI_API_KEY)) {
    console.error("OpenAI transcription is selected but no API key is configured.");
    console.error("Open the app and add the key in the STT engine row, or set OPENAI_API_KEY in your shell.");
    process.exitCode = 1;
    return;
  }

  const { url } = await startServer({
    ...options,
    settingsStore,
    onStatus: (message) => console.log(message),
  });

  console.log("");
  console.log(`${BRAND_NAME}. ${BRAND_TAGLINE}`);
  console.log(`A ${BRAND_ORG} project.`);
  console.log(`${BRAND_NAME} listening at ${url}`);
  console.log(`Whiteboard agent: ${agentProvider.provider} ${agentProvider.model}`);
  console.log(`Settings file: ${SETTINGS_PATH}`);
  console.log("");

  if (options.openBrowser) {
    await open(url);
  }
}

function printHelp() {
  console.log(`${BRAND_NAME}. ${BRAND_TAGLINE}`);
  console.log(`A ${BRAND_ORG} project. Forked from autopreso by Kun Chen (MIT).`);
  console.log("");
  console.log("Usage:");
  console.log("  champpreso [options]");
  console.log("");
  console.log("Options:");
  console.log("  --no-open                Do not open the browser automatically");
  console.log("  -h, --help               Show this help");
  console.log("");
  console.log("The server binds to 127.0.0.1 locally; 0.0.0.0 in cloud mode.");
  console.log("Cloud detection: CHAMPPRESO_CLOUD=1 | RAILWAY_ENVIRONMENT | RENDER | FLY_APP_NAME | NIXPACKS_METADATA");
  console.log("");
  console.log("Environment (seeds settings.json on first run only):");
  console.log("  PORT                     Port to listen on. Default: 3210");
  console.log("  OPENROUTER_API_KEY       Seeds the OpenRouter key for the agent");
  console.log("  OPENROUTER_MODEL         Seeds the OpenRouter agent model");
  console.log("  OPENROUTER_BASE_URL      Seeds the OpenRouter API base URL");
  console.log("  OPENAI_API_KEY           Seeds the OpenAI key for agent and Realtime STT");
  console.log("  OPENAI_MODEL             Seeds the OpenAI agent model");
  console.log("  OPENAI_BASE_URL          Seeds the OpenAI agent API base URL");
  console.log("  OPENAI_REASONING_EFFORT  Seeds reasoning effort (none, low, medium, high, xhigh)");
  console.log("  CODEX_HOME               Codex CLI home directory. Default: ~/.codex");
  console.log("  CODEX_MODEL              Seeds the Codex model");
  console.log("  CODEX_BASE_URL           Seeds the Codex backend URL");
  console.log("  OLLAMA_MODEL             Seeds the Ollama model");
  console.log("  OLLAMA_BASE_URL          Seeds the Ollama base URL");
  console.log("  CHAMPPRESO_CACHE_LOG     Cache usage log path. Default: ~/.config/champpreso/logs/cache.log");
  console.log("  CHAMPPRESO_DEBUG_LOG     Agent debug log path. Default: ~/.config/champpreso/logs/debug.log");
  console.log("");
  console.log("Models and providers are configured in the UI after launch.");
  console.log("Settings persist at:");
  console.log(`  ${SETTINGS_PATH}`);
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
