// Ask panel: the "hey, what did we decide about pricing?" surface.
//
// Shared by the Listening screen and the Review screen, because the question
// "what does this board actually say?" is just as useful mid-discussion as it
// is after. Both mount the same component; only the placement differs.
//
// The panel itself is presentational. app.js owns the request and the answer
// state, because answers arrive over the WebSocket (`agent:answer`) for every
// client in the room, not just whoever typed the question - a shared
// whiteboard should not hand out private answers.
//
// PROPS:
//   open          bool     - whether the input row is expanded
//   onToggle()             - expand/collapse the input row
//   value         string   - controlled question text
//   onValueChange(text)
//   onSubmit(text)
//   busy          bool     - a question is in flight
//   answer        object   - { question, answer, sources[], model } or null
//   error         string
//   onDismiss()            - clear the current answer
//   onPutOnBoard(text)     - route the answer into the canvas as a typed turn
//   placement     string   - "listening" | "review" (styling hook only)

import React from "react";

const h = React.createElement;

function svg(children, size = 14, strokeWidth = 1.5) {
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

export const askIcon = (size = 15) =>
  svg(
    [
      h("circle", { key: "a", cx: 12, cy: 12, r: 9 }),
      h("path", { key: "b", d: "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" }),
      h("path", { key: "c", d: "M12 17h.01" }),
    ],
    size,
    1.6,
  );

const sendIcon = (size = 14) =>
  svg([h("path", { key: "a", d: "M12 19V5" }), h("path", { key: "b", d: "m5 12 7-7 7 7" })], size, 2);

const closeIcon = (size = 13) =>
  svg([h("path", { key: "a", d: "M18 6 6 18M6 6l12 12" })], size, 2);

const linkIcon = (size = 11) =>
  svg(
    [
      h("path", { key: "a", d: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" }),
      h("path", { key: "b", d: "M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19" }),
    ],
    size,
    1.6,
  );

const ASK_PLACEHOLDERS = [
  "Ask about the board…",
  "What did we decide?",
  "What's still open?",
  "How do these two connect?",
  "What are we missing?",
];

export function AskPanel({
  open = false,
  onToggle,
  value = "",
  onValueChange,
  onSubmit,
  busy = false,
  answer = null,
  error = "",
  onDismiss,
  onPutOnBoard,
  placement = "listening",
}) {
  const inputRef = React.useRef(null);
  const [placeholderIdx, setPlaceholderIdx] = React.useState(0);

  React.useEffect(() => {
    if (!open) return undefined;
    const id = setInterval(() => setPlaceholderIdx((i) => (i + 1) % ASK_PLACEHOLDERS.length), 5000);
    return () => clearInterval(id);
  }, [open]);

  React.useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  function submit() {
    const text = String(value || "").trim();
    if (!text || busy) return;
    onSubmit?.(text);
  }

  return h(
    "div",
    { className: `ask-panel ask-panel-${placement}` },

    // ---- the answer, when there is one ----
    answer
      ? h(
          "div",
          { className: "ask-answer", role: "status", "aria-live": "polite" },
          h(
            "div",
            { className: "ask-answer-head" },
            h("span", { className: "ask-answer-eyebrow" }, "ANSWER"),
            answer.model ? h("span", { className: "ask-answer-model" }, answer.model) : null,
            h("div", { className: "ask-answer-spacer" }),
            h(
              "button",
              {
                type: "button",
                className: "ask-answer-close",
                onClick: () => onDismiss?.(),
                title: "Dismiss",
                "aria-label": "Dismiss answer",
              },
              closeIcon(),
            ),
          ),
          answer.question ? h("div", { className: "ask-answer-q" }, answer.question) : null,
          h("div", { className: "ask-answer-body" }, answer.answer),
          Array.isArray(answer.sources) && answer.sources.length > 0
            ? h(
                "div",
                { className: "ask-answer-sources" },
                ...answer.sources.map((source, i) =>
                  h(
                    "a",
                    {
                      key: `${i}-${source.url}`,
                      className: "ask-answer-source",
                      href: source.url,
                      target: "_blank",
                      rel: "noreferrer noopener",
                      title: source.url,
                    },
                    linkIcon(),
                    h("span", null, source.title || source.url),
                  ),
                ),
              )
            : null,
          h(
            "div",
            { className: "ask-answer-actions" },
            h(
              "button",
              {
                type: "button",
                className: "ask-answer-action",
                onClick: () => onPutOnBoard?.(answer.answer),
                title: "Have the agent draw this answer onto the canvas",
              },
              "Put on board",
            ),
          ),
        )
      : null,

    error ? h("div", { className: "ask-error" }, error) : null,

    // ---- the input row ----
    open
      ? h(
          "div",
          { className: "ask-row" },
          h("span", { className: "ask-eyebrow" }, "ASK THE BOARD"),
          h("input", {
            ref: inputRef,
            type: "text",
            className: "ask-input",
            value,
            placeholder: ASK_PLACEHOLDERS[placeholderIdx],
            maxLength: 500,
            disabled: busy,
            onChange: (e) => onValueChange?.(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onToggle?.();
              }
            },
          }),
          h(
            "button",
            {
              type: "button",
              className: "ask-send",
              disabled: busy || !String(value || "").trim(),
              onClick: submit,
              title: "Ask (Enter)",
              "aria-label": "Ask the board",
            },
            busy ? h("span", { className: "ask-spinner", "aria-hidden": "true" }) : sendIcon(),
          ),
        )
      : null,
  );
}
