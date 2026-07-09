// Centralized REST client for the ChampPreso frontend. Every fetch() call
// the app makes against the Express backend routes through the functions
// exported here, all built on top of a single `request()` helper that
// handles JSON serialization, headers, and error unwrapping consistently.
//
// Convention: every exported function returns the parsed JSON body on
// success (or `null` for empty/non-JSON responses), and throws an `Error`
// (message taken from the server's `{ error }` payload when present) on a
// non-2xx response. Callers that need res.ok-style branching (e.g. to show
// an inline error without throwing) should wrap the call in try/catch.

async function request(path, options = {}) {
  const res = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const contentType = res.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await res.json() : null;
  if (!res.ok) {
    throw new Error(payload?.error ?? `${path} failed with status ${res.status}`);
  }
  return payload;
}

export function getConfig() {
  return request("/api/config");
}

export function getSettings() {
  return request("/api/settings");
}

export function saveSettings(patch) {
  return request("/api/settings", { method: "PUT", body: patch });
}

export function startSession({ stagingElements, stagingScreenshot }) {
  return request("/api/session/start", {
    method: "POST",
    body: { stagingElements, stagingScreenshot },
  });
}

export function backToSetup() {
  return request("/api/session/back-to-staging", { method: "POST" });
}

export function pauseSession() {
  return request("/api/session/pause", { method: "POST" });
}

export function resumeSession() {
  return request("/api/session/resume", { method: "POST" });
}

export function undoTurn() {
  return request("/api/session/undo-turn", { method: "POST" });
}

export function interruptTurn() {
  return request("/api/session/interrupt", { method: "POST" });
}

export function pinElement(id) {
  return request("/api/session/pin", { method: "POST", body: { id } });
}

export function unpinElement(id) {
  return request("/api/session/unpin", { method: "POST", body: { id } });
}

export function clearPins() {
  return request("/api/session/pins/clear", { method: "POST" });
}

export function answerQuestion({ id, text }) {
  return request("/api/session/answer", { method: "POST", body: { id, text } });
}

export function sendNudge(text) {
  return request("/api/session/nudge", { method: "POST", body: { text } });
}

export function sendScopedEdit({ selectedIds, instruction }) {
  return request("/api/session/scoped-edit", {
    method: "POST",
    body: { selectedIds, instruction },
  });
}

export function sendTypedTurn(text) {
  return request("/api/session/say", { method: "POST", body: { text } });
}

export function resetSession() {
  return request("/api/session/reset", { method: "POST" });
}

export function getLastBackup() {
  return request("/api/session/last-backup");
}

export function restoreBackup() {
  return request("/api/session/restore-backup", { method: "POST" });
}

export function getCurrentCanvas() {
  return request("/api/session/current-canvas");
}

export function seedCanvas({ text, existingElements }) {
  return request("/api/session/seed", { method: "POST", body: { text, existingElements } });
}

export function reviewSession() {
  return request("/api/session/review", { method: "POST" });
}
