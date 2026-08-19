// Listening / Paused screen (redesign "halo" layout). Translates the design
// source's TOP STATUS STRIP, STATUS DRAWER, QUESTION CARD, CAPTION PILL and
// STEER BAR sections (docs/design-handoff/frontend-source/ChampPreso-Shell.dc
// .html, ~lines 225-366) into real React wired against the live backend.
//
// This replaces the old live-mode side-panel chrome: the record/interrupt/pin
// action row, the NudgeBar, the CaptionFab/PaletteRow/ZoneChip canvas floaters,
// the old QuestionCard mount, the CostCard, and the Live Transcript History.
// A thin top strip carries state + status + zone + session controls; a floating
// bottom steer bar carries the mid-session nudge input; the question card and
// caption pill overlay the canvas. Everything renders as absolutely-positioned
// overlays on top of the full-bleed Excalidraw canvas, matching the halo
// design (no side panel).
//
// PROPS (large surface — this screen aggregates most of the live-session UI):
//   paused          bool    — phase === "paused" (server capture paused)
//   listening       bool    — mic is actively capturing (drives the strip
//                             waveform; false while paused)
//   agentStatus     string  — raw agent:status ("idle" | "thinking" | ...)
//   agentThinking   string  — friendly tool-status text (agent:event/tool:start)
//   activeZone      string  — agent:zone ("sketches" | "structured" | "notes")
//   cost            object  — { agent, transcription } from the cost WS message
//   agentLabel      string  — agent model label for the status drawer
//   transcriptionProvider string — "moonshine" | "openai" (drawer line)
//   turnCount       number  — completed agent turns this session (drawer)
//   captionText     string  — latest transcript:partial/committed text
//   captionsOn      bool     — uiPrefs.captionsOn
//   onToggleCaptions(bool)   — persist the captions toggle (saveSettings)
//   question        object|null — pending agent:question { id, question, options }
//   onAnswerQuestion(text)   — POST the answer (clears the question host-side)
//   onSkipQuestion()         — skip / best-guess (clears the question host-side)
//   onPauseResume()          — toggle server capture pause (pause <-> resume)
//   onUndo()                 — undo the last agent turn
//   onInterrupt()            — abort the in-flight agent turn (only while the
//                             agent is thinking/drawing; POST /api/session/interrupt)
//   sayText          string  — controlled typed-turn input value (host state)
//   saySending       bool    — a typed turn is in flight (disables the input/send)
//   onSayTextChange(text)    — update the typed-turn input value
//   onSendTypedTurn(text)    — inject typed text as a spoken turn (POST /say)
//   onEnd()                  — end the session -> flips app phase to "review"
//                             (stops mic capture); does NOT call /review itself
//   nudgeSignal     object   — { status: "applied"|"failed", text, reason, nonce }
//                             derived from nudge:applied / nudge:failed WS msgs;
//                             a bumped nonce re-triggers the steer banner
//   error           string   — latest error to surface as a floating pill

import React from "react";

import { AskPanel, askIcon } from "./ask-panel.js";

import { sendNudge as apiSendNudge } from "../api-client.js";

const h = React.createElement;

const ZONE_LABELS = {
  sketches: "SKETCHES",
  structured: "STRUCTURED",
  notes: "NOTES",
};

// 5 rotating example steers, cycled every 4s (design placeholderIdx timer).
const STEER_PLACEHOLDERS = [
  "Whisper a steer… “group these by owner”",
  "Whisper a steer… “use a flowchart instead”",
  "Whisper a steer… “highlight the risks”",
  "Whisper a steer… “zoom into the timeline”",
  "Whisper a steer… “drop the licence node”",
];

const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"];

function formatUsd(value) {
  if (typeof value !== "number" || !isFinite(value) || value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

// Small status text under the state label. Real agent status, not the mock's
// scripted sequence.
function deriveStatusText({ paused, agentStatus, agentThinking }) {
  if (paused) return "holding";
  if (agentThinking) return String(agentThinking).toLowerCase();
  if (agentStatus === "thinking") return "thinking";
  return "listening";
}

function svg(children, size = 12, strokeWidth = 1.5) {
  return h(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    },
    ...children,
  );
}

const undoIcon = () =>
  svg([
    h("path", { key: "a", d: "M9 14 4 9l5-5" }),
    h("path", { key: "b", d: "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" }),
  ]);

const sendIcon = (size = 14) =>
  svg(
    [
      h("path", { key: "a", d: "M12 19V5" }),
      h("path", { key: "b", d: "m5 12 7-7 7 7" }),
    ],
    size,
    2,
  );

const checkIcon = (size = 13) =>
  svg([h("path", { key: "a", d: "M20 6 9 17l-5-5" })], size, 2);

// Interrupt = a filled-ish stop square (rounded), matching the strip's line icons.
const stopIcon = (size = 12) =>
  svg([h("rect", { key: "a", x: 6, y: 6, width: 12, height: 12, rx: 2 })], size, 2);

// Typed-turn toggle = a small keyboard glyph.
const keyboardIcon = (size = 15) =>
  svg(
    [
      h("rect", { key: "a", x: 2, y: 6, width: 20, height: 12, rx: 2 }),
      h("path", { key: "b", d: "M7 10h.01M11 10h.01M15 10h.01M8 14h8" }),
    ],
    size,
    1.5,
  );

export function ListeningScreen({
  paused = false,
  listening = false,
  agentStatus = "idle",
  agentThinking = "",
  activeZone = "structured",
  cost = null,
  agentLabel = "Agent",
  transcriptionProvider = "moonshine",
  turnCount = 0,
  captionText = "",
  captionsOn = true,
  onToggleCaptions,
  question = null,
  onAnswerQuestion,
  onSkipQuestion,
  onPauseResume,
  onUndo,
  onInterrupt,
  onPinSelection,
  onClearPins,
  onEnd,
  sayText = "",
  saySending = false,
  onSayTextChange,
  onSendTypedTurn,
  nudgeSignal = null,
  // ---- ask the board ----
  askValue = "",
  askBusy = false,
  askAnswer = null,
  askError = "",
  onAskValueChange,
  onAsk,
  onDismissAnswer,
  onPutAnswerOnBoard,
  error = "",
}) {
  const isListening = listening && !paused;
  const agentBusy = agentStatus === "thinking";

  // ---- client-owned session clock (display only; not from the server) ----
  const [clock, setClock] = React.useState(0);
  const pausedRef = React.useRef(paused);
  pausedRef.current = paused;
  React.useEffect(() => {
    const id = setInterval(() => {
      if (!pausedRef.current) setClock((c) => c + 1);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ---- caption pill: 4.5s auto-fade, driven by real transcript text ----
  const [visibleCaption, setVisibleCaption] = React.useState("");
  const captionTimerRef = React.useRef(null);
  React.useEffect(() => {
    const text = (captionText || "").trim();
    if (!text) return; // ignore host-side clears; our own 4.5s timer owns fade
    setVisibleCaption(text);
    clearTimeout(captionTimerRef.current);
    captionTimerRef.current = setTimeout(() => setVisibleCaption(""), 4500);
  }, [captionText]);
  React.useEffect(() => () => clearTimeout(captionTimerRef.current), []);

  // ---- status drawer ----
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  // ---- steer bar ----
  const [steerValue, setSteerValue] = React.useState("");
  const [steerFocused, setSteerFocused] = React.useState(false);
  const [placeholderIdx, setPlaceholderIdx] = React.useState(0);
  const [steerState, setSteerState] = React.useState("idle"); // idle|applied|failed
  const [steerEcho, setSteerEcho] = React.useState("");
  const steerInputRef = React.useRef(null);
  const steerAppliedTimerRef = React.useRef(null);

  // ---- ask the board: a question that gets answered, not drawn ----
  const [askOpen, setAskOpen] = React.useState(false);
  // An answer arriving over the WS (from anyone in the room) opens the panel,
  // so the whole room sees the response without anyone having to hunt for it.
  React.useEffect(() => {
    if (askAnswer) setAskOpen(true);
  }, [askAnswer]);

  // ---- typed turn (say): a no-voice path to speak a point into the canvas ----
  const [typedOpen, setTypedOpen] = React.useState(false);
  const typedInputRef = React.useRef(null);

  function submitTypedTurn() {
    const text = String(sayText || "").trim();
    if (!text || saySending) return;
    onSendTypedTurn?.(text);
  }

  React.useEffect(() => {
    const id = setInterval(
      () => setPlaceholderIdx((i) => (i + 1) % STEER_PLACEHOLDERS.length),
      4000,
    );
    return () => clearInterval(id);
  }, []);

  // React to real nudge:applied / nudge:failed WS results (via nudgeSignal).
  const lastNonceRef = React.useRef(0);
  React.useEffect(() => {
    if (!nudgeSignal || nudgeSignal.nonce === lastNonceRef.current) return;
    lastNonceRef.current = nudgeSignal.nonce;
    clearTimeout(steerAppliedTimerRef.current);
    if (nudgeSignal.status === "applied") {
      setSteerEcho(nudgeSignal.text || steerEcho);
      setSteerState("applied");
      steerAppliedTimerRef.current = setTimeout(
        () => setSteerState((s) => (s === "applied" ? "idle" : s)),
        3000,
      );
    } else if (nudgeSignal.status === "failed") {
      setSteerState("failed");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nudgeSignal]);
  React.useEffect(() => () => clearTimeout(steerAppliedTimerRef.current), []);

  function submitSteer() {
    const text = steerValue.trim();
    if (!text) return;
    setSteerEcho(text);
    setSteerValue("");
    // The applied/failed banner is driven by the WS result (nudgeSignal), so we
    // just fire and let the server's nudge:applied / nudge:failed decide.
    apiSendNudge(text).catch(() => {
      /* WS nudge:failed drives the failed banner; swallow the REST rejection */
    });
  }

  function retrySteer() {
    setSteerValue(steerEcho);
    setSteerState("idle");
    setTimeout(() => steerInputRef.current?.focus(), 30);
  }

  // ---- "/" to focus steer, Escape to skip a question ----
  React.useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";
      if (e.key === "/" && !typing) {
        e.preventDefault();
        steerInputRef.current?.focus();
      }
      if (e.key === "Escape" && question) {
        onSkipQuestion?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [question, onSkipQuestion]);

  // ---- derived display values ----
  const stateLabel = paused ? "Paused" : "Listening";
  const stateDotColor = paused ? "var(--champ-mist)" : "var(--champ-ember)";
  const stateDotAnim = paused ? "none" : "ppPulse 2s ease-in-out infinite";
  const stateDotGlow = paused ? "none" : "0 0 12px rgba(255,107,53,0.6)";
  const mm = Math.floor(clock / 60);
  const ss = String(clock % 60).padStart(2, "0");
  const clockText = `${mm}:${ss}`;
  const statusText = deriveStatusText({ paused, agentStatus, agentThinking });
  const zoneText = ZONE_LABELS[activeZone] || "";

  const agent = cost?.agent ?? {};
  const stt = cost?.transcription ?? {};
  const agentCost = agent.priced ? agent.cost ?? 0 : 0;
  const sttCost = stt.priced ? stt.cost ?? 0 : 0;
  const totalCost = agentCost + sttCost;
  const costText = `${formatUsd(totalCost)} ···`;
  const sttLocal = transcriptionProvider === "moonshine";

  const captionShown = Boolean(visibleCaption) && captionsOn && isListening;

  const stripBtn =
    "ls-strip-btn"; // shared class for the ghost strip buttons

  return h(
    React.Fragment,
    null,

    // ============ TOP STATUS STRIP ============
    h(
      "div",
      { className: "ls-strip" },
      h(
        "div",
        { className: "ls-brand" },
        "Champ",
        h("span", { className: "ls-brand-mark" }, "Preso"),
      ),
      h("div", { className: "ls-strip-divider" }),

      h(
        "div",
        { className: "ls-state" },
        h("span", {
          className: "ls-state-dot",
          style: { background: stateDotColor, animation: stateDotAnim, boxShadow: stateDotGlow },
        }),
        h("span", { className: "ls-state-label" }, stateLabel),
        h("span", { className: "ls-clock" }, clockText),
      ),

      isListening
        ? h(
            "div",
            { className: "ls-wave", "aria-hidden": "true" },
            h("span", { style: { animation: "ppWave1 .9s ease-in-out infinite" } }),
            h("span", { style: { animation: "ppWave2 .8s ease-in-out infinite" } }),
            h("span", { style: { animation: "ppWave3 1s ease-in-out infinite" } }),
            h("span", { style: { animation: "ppWave2 .85s ease-in-out infinite" } }),
          )
        : null,

      h("span", { className: "ls-status-text" }, statusText),

      zoneText ? h("span", { className: "ls-zone" }, zoneText) : null,

      h("div", { className: "ls-strip-spacer" }),

      paused
        ? h(
            React.Fragment,
            null,
            h("span", { className: "ls-paused-note" }, "Mic is off. Canvas is yours."),
            h(
              "button",
              { type: "button", className: "ls-resume", onClick: onPauseResume },
              "Resume",
            ),
          )
        : h(
            "button",
            {
              type: "button",
              className: stripBtn,
              onClick: onPauseResume,
              title: "Mic off, agent holds",
            },
            "Pause",
          ),

      h(
        "button",
        { type: "button", className: stripBtn, onClick: onUndo, title: "Undo what it just drew" },
        undoIcon(),
        "Undo",
      ),

      // Only surfaced while the agent is mid-turn — interrupting an idle agent
      // is a no-op. Shares the ghost strip-button style with Undo/End.
      !paused && agentBusy
        ? h(
            "button",
            {
              type: "button",
              className: `${stripBtn} ls-interrupt`,
              onClick: () => onInterrupt?.(),
              title: "Stop the agent mid-turn",
            },
            stopIcon(),
            "Interrupt",
          )
        : null,

      h(
        "button",
        { type: "button", className: stripBtn, onClick: onEnd },
        "End",
      ),

      h(
        "button",
        {
          type: "button",
          className: "ls-cost-btn",
          onClick: () => setDrawerOpen((v) => !v),
          title: "Session cost breakdown",
        },
        costText,
      ),
    ),

    // ============ STATUS DRAWER ============
    drawerOpen
      ? h(
          "div",
          { className: "ls-drawer" },
          h("div", { className: "ls-drawer-eyebrow" }, "THIS SESSION"),
          h(
            "div",
            { className: "ls-drawer-rows" },
            h(
              "div",
              { className: "ls-drawer-row" },
              h("span", { className: "ls-drawer-key" }, `Agent · ${agentLabel}`),
              h("span", { className: "ls-drawer-val" }, agent.priced ? `$${agentCost.toFixed(3)}` : "—"),
            ),
            h(
              "div",
              { className: "ls-drawer-row" },
              h("span", { className: "ls-drawer-key" }, `Transcription · ${sttLocal ? "local" : "cloud"}`),
              h("span", { className: "ls-drawer-val" }, sttLocal ? "free" : formatUsd(sttCost)),
            ),
            h(
              "div",
              { className: "ls-drawer-row" },
              h("span", { className: "ls-drawer-key" }, "Drawings"),
              h("span", { className: "ls-drawer-val" }, String(turnCount)),
            ),
          ),
          h("div", { className: "ls-drawer-divider" }),
          h(
            "label",
            { className: "ls-drawer-check" },
            h("input", {
              type: "checkbox",
              checked: !!captionsOn,
              onChange: (e) => onToggleCaptions?.(e.target.checked),
            }),
            "Live captions",
          ),
          h("div", { className: "ls-drawer-divider" }),
          h(
            "div",
            { className: "ls-drawer-pins" },
            h(
              "button",
              {
                type: "button",
                className: "ls-strip-btn ls-drawer-pin-btn",
                onClick: () => onPinSelection?.(),
                title: "Pin the selected canvas elements so the agent won't touch them",
              },
              "Pin selection",
            ),
            h(
              "button",
              {
                type: "button",
                className: "ls-drawer-pin-clear",
                onClick: () => onClearPins?.(),
                title: "Remove all pins",
              },
              "Unpin all",
            ),
          ),
          h(
            "div",
            { className: "ls-drawer-note" },
            "Select elements on the canvas, then pin them so the agent leaves them alone. Other settings live in Setup.",
          ),
        )
      : null,

    // ============ QUESTION CARD ============
    question
      ? h(LiveQuestionCard, {
          key: question.id,
          question,
          paused,
          onAnswer: onAnswerQuestion,
          onSkip: onSkipQuestion,
        })
      : null,

    // ============ CAPTION PILL ============
    captionShown ? h("div", { className: "ls-caption" }, visibleCaption) : null,

    // ============ STEER BAR ============
    h(
      "div",
      { className: "ls-steer" },
      steerState === "applied"
        ? h(
            "div",
            { className: "ls-steer-applied" },
            checkIcon(),
            `Steering: ${steerEcho.length > 44 ? steerEcho.slice(0, 42) + "…" : steerEcho}`,
          )
        : null,
      steerState === "failed"
        ? h(
            "div",
            { className: "ls-steer-failed" },
            "That steer didn't land.",
            h(
              "button",
              { type: "button", className: "ls-steer-retry", onClick: retrySteer },
              "Try again",
            ),
          )
        : null,
      // Ask panel — questions about the board, answered in place. Rendered
      // above the typed row so an answer sits closest to the conversation.
      h(AskPanel, {
        open: askOpen,
        onToggle: () => setAskOpen((v) => !v),
        value: askValue,
        onValueChange: onAskValueChange,
        onSubmit: onAsk,
        busy: askBusy,
        answer: askAnswer,
        error: askError,
        onDismiss: onDismissAnswer,
        onPutOnBoard: onPutAnswerOnBoard,
        placement: "listening",
      }),
      // Typed-turn row — a distinct, lighter input for "type what you'd have
      // said aloud". Toggled open by the keyboard button on the steer bar.
      typedOpen
        ? h(
            "div",
            { className: "ls-typed" },
            h("span", { className: "ls-typed-eyebrow" }, "SAY IT · NO MIC"),
            h("input", {
              ref: typedInputRef,
              type: "text",
              className: "ls-typed-input",
              value: sayText,
              placeholder: "Type what you'd have said aloud…",
              maxLength: 500,
              disabled: saySending,
              onChange: (e) => onSayTextChange?.(e.target.value),
              onKeyDown: (e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitTypedTurn();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setTypedOpen(false);
                }
              },
            }),
            h(
              "button",
              {
                type: "button",
                className: "ls-typed-send",
                disabled: saySending || !String(sayText || "").trim(),
                onClick: submitTypedTurn,
                title: "Add to the board (Enter)",
                "aria-label": "Send typed turn",
              },
              saySending ? "…" : sendIcon(14),
            ),
          )
        : null,
      h(
        "div",
        {
          className: "ls-steer-bar",
          style: {
            borderColor:
              steerFocused || steerValue ? "var(--champ-ember)" : "rgba(255,255,255,0.1)",
          },
        },
        h(
          "button",
          {
            type: "button",
            className: `ls-type-toggle${typedOpen ? " active" : ""}`,
            onClick: () => {
              setTypedOpen((v) => !v);
              if (!typedOpen) setTimeout(() => typedInputRef.current?.focus(), 30);
            },
            title: "Type a turn instead of speaking it",
            "aria-label": "Type a turn",
            "aria-pressed": typedOpen,
          },
          keyboardIcon(),
        ),
        h(
          "button",
          {
            type: "button",
            className: `ls-ask-toggle${askOpen ? " active" : ""}`,
            onClick: () => {
              setAskOpen((v) => !v);
            },
            title: "Ask a question about the board (answered, not drawn)",
            "aria-label": "Ask the board",
            "aria-pressed": askOpen,
          },
          askIcon(),
        ),
        h("input", {
          ref: steerInputRef,
          type: "text",
          className: "ls-steer-input",
          "data-pp-steer": "1",
          value: steerValue,
          placeholder: STEER_PLACEHOLDERS[placeholderIdx],
          maxLength: 500,
          onChange: (e) => setSteerValue(e.target.value),
          onFocus: () => setSteerFocused(true),
          onBlur: () => setSteerFocused(false),
          onKeyDown: (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitSteer();
            }
          },
        }),
        h("span", { className: "ls-steer-hint" }, "/ TO FOCUS"),
        h(
          "button",
          {
            type: "button",
            className: "ls-steer-send",
            style: { background: steerValue.trim() ? "var(--champ-ember)" : "#2A2F3D" },
            onClick: submitSteer,
            title: "Send steer (Enter)",
            "aria-label": "Send steer",
          },
          sendIcon(),
        ),
      ),
    ),

    error ? h("div", { className: "ls-error" }, error) : null,
  );
}

// Floating clarifying-question card with a 20s countdown that auto-skips.
function LiveQuestionCard({ question, paused, onAnswer, onSkip }) {
  const options = Array.isArray(question.options) ? question.options : [];
  const freeform = options.length === 0;
  const [secsLeft, setSecsLeft] = React.useState(20);
  const [answered, setAnswered] = React.useState(false);
  const [echo, setEcho] = React.useState("");
  const [custom, setCustom] = React.useState("");
  const inputRef = React.useRef(null);
  const commitTimerRef = React.useRef(null);
  const answeredRef = React.useRef(false);
  answeredRef.current = answered;
  const pausedRef = React.useRef(paused);
  pausedRef.current = paused;

  // 20s countdown -> auto-skip. Frozen while answered or paused.
  React.useEffect(() => {
    const id = setInterval(() => {
      if (answeredRef.current || pausedRef.current) return;
      setSecsLeft((left) => {
        const next = left - 0.25;
        if (next <= 0) {
          clearInterval(id);
          onSkip?.();
          return 0;
        }
        return next;
      });
    }, 250);
    return () => clearInterval(id);
  }, [onSkip]);

  React.useEffect(() => {
    if (freeform) {
      const t = setTimeout(() => inputRef.current?.focus(), 400);
      return () => clearTimeout(t);
    }
  }, [freeform]);

  React.useEffect(() => () => clearTimeout(commitTimerRef.current), []);

  function commit(text) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed || answeredRef.current) return;
    setAnswered(true);
    setEcho(trimmed);
    // Show the "answered" echo briefly, then POST it (which clears the card).
    commitTimerRef.current = setTimeout(() => onAnswer?.(trimmed), 1400);
  }

  const qBarPct = answered ? 100 : (secsLeft / 20) * 100;
  const countdownText = answered ? "" : `${Math.ceil(secsLeft)}s`;
  const eyebrow = freeform ? "QUICK QUESTION · TYPE IT" : "QUICK QUESTION · TAP ONE";

  return h(
    "div",
    { className: "ls-question", role: "dialog", "aria-live": "polite" },
    h(
      "div",
      { className: "ls-q-head" },
      h("span", { className: "ls-q-eyebrow" }, eyebrow),
      h("div", { className: "ls-q-spacer" }),
      h("span", { className: "ls-q-countdown" }, countdownText),
      h(
        "button",
        {
          type: "button",
          className: "ls-q-skip",
          onClick: onSkip,
          title: "Skip. The agent uses its best guess.",
        },
        "Skip",
      ),
    ),

    h("div", { className: "ls-q-text" }, question.question),

    answered
      ? h(
          "div",
          { className: "ls-q-answered" },
          checkIcon(15),
          `${echo}. Back to drawing.`,
        )
      : null,

    !answered && !freeform
      ? h(
          "div",
          { className: "ls-q-options" },
          ...options.map((opt, i) =>
            h(
              "button",
              {
                key: `${opt}-${i}`,
                type: "button",
                className: "ls-q-option",
                onClick: () => commit(opt),
              },
              h("span", { className: "ls-q-badge" }, OPTION_LETTERS[i] || "?"),
              opt,
            ),
          ),
        )
      : null,

    !answered
      ? h(
          "div",
          { className: `ls-q-input-row${freeform ? " freeform" : ""}` },
          h("input", {
            ref: inputRef,
            type: "text",
            className: "ls-q-input",
            value: custom,
            placeholder: freeform ? "Type a short answer and press Enter" : "Or type your own answer",
            maxLength: 500,
            onChange: (e) => setCustom(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit(custom);
              }
            },
          }),
          h(
            "button",
            {
              type: "button",
              className: "ls-q-send",
              onClick: () => commit(custom),
              title: "Send",
              "aria-label": "Send answer",
            },
            sendIcon(15),
          ),
        )
      : null,

    h(
      "div",
      { className: "ls-q-progress" },
      h("div", { className: "ls-q-progress-fill", style: { width: `${qBarPct}%` } }),
    ),
  );
}
