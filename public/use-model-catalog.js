// React hooks over the live model catalog (GET /api/models).
//
// The pickers used to read hardcoded arrays, which rot: a retired slug looks
// fine in the UI and then kills a live session with "No endpoints found".
// These hooks read from the provider instead, and surface a warning when the
// currently-configured model has disappeared.
//
// Both hooks are deliberately forgiving. The catalog is a convenience; if it
// can't be reached, the picker still works (the server hands back a bundled
// fallback list) and the warning simply stays silent rather than guessing.

import React from "react";

import { listModels as apiListModels, verifyModel as apiVerifyModel } from "./api-client.js";

// Module-level cache shared across mounts. The settings sheet opens and closes
// a lot; refetching 288 models each time is pure waste.
const cache = new Map();

export function useModelCatalog(provider, { enabled = true } = {}) {
  const [state, setState] = React.useState(() => cache.get(provider) ?? { models: [], source: null, error: null });
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!enabled || !provider) return undefined;
    const cached = cache.get(provider);
    if (cached) {
      setState(cached);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    apiListModels(provider)
      .then((result) => {
        if (cancelled) return;
        const next = {
          models: Array.isArray(result?.models) ? result.models : [],
          source: result?.source ?? null,
          error: result?.error ?? null,
        };
        cache.set(provider, next);
        setState(next);
      })
      .catch((error) => {
        if (cancelled) return;
        // The server already degrades internally, so reaching here means the
        // server itself is unreachable. Leave the picker usable and quiet.
        setState({ models: [], source: null, error: error.message });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, enabled]);

  return { ...state, loading };
}

// Warns when the configured model no longer exists. Debounced, because this is
// wired to a free-text combobox and we don't want a request per keystroke.
export function useModelWarning(provider, model, { enabled = true, delayMs = 700 } = {}) {
  const [warning, setWarning] = React.useState(null);
  const [suggestion, setSuggestion] = React.useState(null);

  React.useEffect(() => {
    if (!enabled || !provider || !model) {
      setWarning(null);
      setSuggestion(null);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      apiVerifyModel(provider, model)
        .then((result) => {
          if (cancelled) return;
          // known === null means we couldn't check. Saying "this model is dead"
          // because our own network is down would be worse than saying nothing.
          setWarning(result?.known === false ? result.warning : null);
          setSuggestion(result?.known === false ? result.suggestion : null);
        })
        .catch(() => {
          if (!cancelled) setWarning(null);
        });
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [provider, model, enabled, delayMs]);

  return { warning, suggestion };
}

// Drop cached lists so the next open refetches. Called after a settings save
// that could change which provider or key is in play.
export function invalidateModelCache(provider) {
  if (provider) cache.delete(provider);
  else cache.clear();
}

// "1M ctx · $3/$15 per Mtok" - the two things that decide a pick, compactly.
export function describeModel(model) {
  if (!model) return "";
  const parts = [];
  if (model.contextLength) parts.push(`${formatContext(model.contextLength)} ctx`);
  if (model.free) parts.push("free");
  else if (typeof model.promptPerMillion === "number" && typeof model.completionPerMillion === "number") {
    parts.push(`$${model.promptPerMillion}/$${model.completionPerMillion} per Mtok`);
  }
  return parts.join(" · ");
}

function formatContext(tokens) {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}
