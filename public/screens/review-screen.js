// Review screen (redesign "REVIEW PANEL" layout). Translates the design
// source's REVIEW PANEL section (docs/design-handoff/frontend-source/
// ChampPreso-Shell.dc.html, ~lines 368-412) into real React wired against the
// live backend.
//
// Review is a CLIENT-SIDE-ONLY phase: the server's state.mode stays "live"
// throughout, so manual canvas edits keep syncing via the existing
// whiteboard:user-elements path with zero special-casing. This screen renders
// as absolutely-positioned overlays on top of the still-editable, full-bleed
// Excalidraw canvas — a floating "Reviewing. Canvas is still editable." pill
// top-left and the session-review panel pinned to the right.
//
// On mount it calls POST /api/session/review once (api.reviewSession()), shows
// a loading state while the model extracts decisions + a summary, then renders
// them — or a graceful error state if the call fails (the endpoint can 500,
// e.g. on a provider timeout).
//
// PROPS:
//   excalidrawApi  object   — Excalidraw API (used to derive the review title
//                             from the first text element on the canvas)
//   cost           object   — { agent, transcription } from the cost WS message
//   turnCount      number   — completed agent turns this session ("drawings")
//   sessionStartedAt number — Date.now() when the preso went live (duration)
//   onExport(fmt)           — reuse app.js's exportCanvas("png"|"svg")
//   onNewSession()          — reset the session and return to Setup

import React from "react";

import { reviewSession as apiReviewSession } from "../api-client.js";
import { AskPanel } from "./ask-panel.js";

const h = React.createElement;

function formatUsd(value) {
  if (typeof value !== "number" || !isFinite(value)) return "$0.00";
  return `$${value.toFixed(2)}`;
}

function totalCostOf(cost) {
  const agent = cost?.agent ?? {};
  const stt = cost?.transcription ?? {};
  const agentCost = agent.priced ? agent.cost ?? 0 : 0;
  const sttCost = stt.priced ? stt.cost ?? 0 : 0;
  return agentCost + sttCost;
}

// Title: first text element on the canvas, else a neutral fallback — mirrors
// the design's `s.texts.length ? s.texts[0].label : …` derivation.
function deriveTitle(excalidrawApi) {
  try {
    const els = excalidrawApi?.getSceneElements?.() || [];
    const firstText = els.find(
      (el) => el && el.type === "text" && typeof el.text === "string" && el.text.trim(),
    );
    if (firstText) {
      const line = firstText.text.trim().split("\n")[0].trim();
      if (line) return line.length > 48 ? line.slice(0, 46) + "…" : line;
    }
  } catch {
    /* getSceneElements can throw if the canvas isn't ready; fall through */
  }
  return "Session review";
}

function svg(children, size = 13, strokeWidth = 1.5, stroke = "currentColor") {
  return h(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke,
      strokeWidth,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    },
    ...children,
  );
}

const penIcon = () =>
  svg([
    h("path", {
      key: "a",
      d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
    }),
  ]);

const checkIcon = () =>
  svg([h("path", { key: "a", d: "M20 6 9 17l-5-5" })], 13, 2, "#FF6B35");

export function ReviewScreen({
  excalidrawApi,
  cost = null,
  turnCount = 0,
  sessionStartedAt = null,
  onExport,
  onNewSession,
  // ---- ask the board (same panel the Listening screen uses) ----
  askValue = "",
  askBusy = false,
  askAnswer = null,
  askError = "",
  onAskValueChange,
  onAsk,
  onDismissAnswer,
  onPutAnswerOnBoard,
}) {
  // ---- one-shot POST /api/session/review on mount ----
  const [status, setStatus] = React.useState("loading"); // loading|ready|error
  const [decisions, setDecisions] = React.useState([]);
  const [summary, setSummary] = React.useState("");
  const [errorMsg, setErrorMsg] = React.useState("");

  const runReview = React.useCallback(() => {
    setStatus("loading");
    setErrorMsg("");
    let cancelled = false;
    apiReviewSession()
      .then((res) => {
        if (cancelled) return;
        setDecisions(Array.isArray(res?.decisions) ? res.decisions : []);
        setSummary(typeof res?.summary === "string" ? res.summary : "");
        setStatus("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setErrorMsg(err?.message || "The review couldn't be generated.");
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => runReview(), [runReview]);

  // ---- title + meta (real client-side elapsed time, cost, drawing count) ----
  const title = React.useMemo(() => deriveTitle(excalidrawApi), [excalidrawApi]);
  const elapsedMs = sessionStartedAt ? Date.now() - sessionStartedAt : 0;
  const minutes = Math.max(1, Math.round(elapsedMs / 60000));
  const totalCost = totalCostOf(cost);
  const meta = `${minutes} MIN · ${formatUsd(totalCost)} · ${turnCount} DRAWINGS`;

  // ---- copy summary ----
  const [copied, setCopied] = React.useState(false);
  const copyTimerRef = React.useRef(null);
  React.useEffect(() => () => clearTimeout(copyTimerRef.current), []);
  function copySummary() {
    if (!summary) return;
    // navigator.clipboard.writeText returns a promise that can reject (no
    // secure context / denied permission); swallow it so it doesn't surface as
    // an unhandled rejection. The optimistic "Copied ✓" flip is harmless.
    try {
      Promise.resolve(navigator.clipboard?.writeText(summary)).catch(() => {});
    } catch {
      /* clipboard API entirely unavailable */
    }
    setCopied(true);
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 1800);
  }

  return h(
    React.Fragment,
    null,

    // ============ "still editable" pill ============
    h(
      "div",
      { className: "rv-pill" },
      penIcon(),
      "Reviewing. Canvas is still editable.",
    ),

    // ============ REVIEW PANEL ============
    h(
      "div",
      { className: "rv-panel" },

      // --- header: title + meta ---
      h(
        "div",
        { className: "rv-head" },
        h("div", { className: "rv-eyebrow" }, "SESSION REVIEW"),
        h("div", { className: "rv-title" }, title),
        h("div", { className: "rv-meta" }, meta),
      ),

      // --- loading state ---
      status === "loading"
        ? h(
            "div",
            { className: "rv-loading" },
            h("span", { className: "rv-spinner", "aria-hidden": "true" }),
            h("span", { className: "rv-loading-text" }, "Summarizing what got decided…"),
          )
        : null,

      // --- error state ---
      status === "error"
        ? h(
            "div",
            { className: "rv-error" },
            h("div", { className: "rv-error-title" }, "Couldn't generate the review."),
            h("div", { className: "rv-error-body" }, errorMsg),
            h(
              "button",
              { type: "button", className: "rv-error-retry", onClick: runReview },
              "Try again",
            ),
          )
        : null,

      // --- decisions ---
      status === "ready"
        ? h(
            "div",
            { className: "rv-section" },
            h("div", { className: "rv-section-label rv-decided" }, "WHAT GOT DECIDED"),
            decisions.length
              ? h(
                  "div",
                  { className: "rv-decisions" },
                  ...decisions.map((d, i) =>
                    h(
                      "div",
                      { key: `${i}-${String(d).slice(0, 12)}`, className: "rv-decision" },
                      checkIcon(),
                      h("span", null, String(d)),
                    ),
                  ),
                )
              : h(
                  "div",
                  { className: "rv-empty" },
                  "No clear decisions surfaced in this session.",
                ),
          )
        : null,

      // --- summary ---
      status === "ready"
        ? h(
            "div",
            { className: "rv-section" },
            h("div", { className: "rv-section-label" }, "SUMMARY"),
            h(
              "div",
              { className: "rv-summary" },
              summary || "No summary was generated.",
            ),
          )
        : null,

      // --- ask the board ---
      // Always expanded here. On the review screen, interrogating the board is
      // the primary action, not a secondary one hidden behind a toggle.
      h(AskPanel, {
        open: true,
        value: askValue,
        onValueChange: onAskValueChange,
        onSubmit: onAsk,
        busy: askBusy,
        answer: askAnswer,
        error: askError,
        onDismiss: onDismissAnswer,
        onPutOnBoard: onPutAnswerOnBoard,
        placement: "review",
      }),

      // --- export / copy row ---
      h(
        "div",
        { className: "rv-actions" },
        h(
          "button",
          { type: "button", className: "rv-action", onClick: () => onExport?.("png") },
          "PNG",
        ),
        h(
          "button",
          { type: "button", className: "rv-action", onClick: () => onExport?.("svg") },
          "SVG",
        ),
        h(
          "button",
          {
            type: "button",
            className: "rv-action",
            onClick: copySummary,
            disabled: status !== "ready" || !summary,
          },
          copied ? "Copied ✓" : "Copy summary",
        ),
      ),

      // --- disabled snapshots placeholder (intentional, matches design) ---
      h(
        "button",
        { type: "button", className: "rv-snapshots", disabled: true },
        "Browse snapshots · soon",
      ),

      h("div", { className: "rv-spacer" }),

      // --- new session ---
      h(
        "button",
        { type: "button", className: "rv-new", onClick: () => onNewSession?.() },
        "New session",
      ),
    ),
  );
}
