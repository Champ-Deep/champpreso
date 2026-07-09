import { convertToExcalidrawElements } from "@excalidraw/excalidraw";

// The mode/status-aware canvas <-> server sync contract, extracted verbatim
// from app.js (structural map lines 1241-1268, 762-788, 3136-3196,
// 1270-1300+ pre-extraction). This is the highest-risk extraction in the
// plan: any state-management refactor must preserve the mode/status guards
// exactly, or the live-edit sync will race the agent's in-flight turn. Do
// NOT "clean up" this logic - it is copied byte-for-byte, only the ref
// closures were turned into explicit parameters since this code no longer
// lives inside the component closure.
//
// createExcalidrawSync({ ... }) returns
// { applyScene, handleExcalidrawChange, applyWhiteboardViewportCommand,
//   nativeElementsToSkeletonForSync, stripInternalFields }.
//
// Parameters:
//   getExcalidrawApi()        -> current Excalidraw imperative API or null
//                                 (was `apiRef.current`)
//   getMode()                 -> "staging" | "live" (was `modeRef.current`)
//   getAgentStatus()          -> current agent status string
//                                 (was `agentStatusRef.current`)
//   getWs()                   -> current ws-client instance or null
//                                 (was `wsRef.current`)
//   selectedIdsRef            -> the actual React ref object (`{ current }`)
//                                 used to track selection; mutated directly,
//                                 exactly as the inline code did. Passing the
//                                 ref object itself (not a getter) preserves
//                                 the original read-then-write-in-place
//                                 semantics with no risk of getter/setter
//                                 drift.
//   setSelectedCount(n)       -> React state setter for the selection count
//   userElementsSyncTimerRef  -> ref object holding the debounce timer id
//   lastSyncedElementsHashRef -> ref object holding the last-synced hash
//   scheduleScreenshot()      -> schedules a debounced whiteboard screenshot
//                                 (was `scheduleWhiteboardScreenshot`, which
//                                 stays in app.js since it isn't one of the
//                                 five functions being moved)
//   getZoom()                 -> current whiteboard zoom value
//                                 (was `currentWhiteboardZoom`)
//   setZoom(zoom)             -> clamps + applies a new zoom value
//                                 (was `setWhiteboardZoom`)
export function createExcalidrawSync({
  getExcalidrawApi,
  getMode,
  getAgentStatus,
  getWs,
  selectedIdsRef,
  setSelectedCount,
  userElementsSyncTimerRef,
  lastSyncedElementsHashRef,
  scheduleScreenshot,
  getZoom,
  setZoom,
}) {
  function applyScene(elements, { recenter = false } = {}) {
    const excalidrawAPI = getExcalidrawApi();
    if (!excalidrawAPI || !Array.isArray(elements)) return;
    const looksNative =
      elements.length > 0 &&
      elements[0] &&
      typeof elements[0].versionNonce === "number";
    // CRITICAL: regenerateIds: false. Excalidraw's default is to throw away
    // user-provided ids and assign fresh nanoids. The agent references its
    // elements by stable ids (e.g. "openai-card") in whiteboard_viewport's
    // focus_ids; if we let Excalidraw rewrite them, the frontend's
    // scene.filter(el => focusIds.includes(el.id)) finds nothing and
    // scrollToContent silently fits the full canvas instead.
    const renderable = looksNative
      ? elements
      : convertToExcalidrawElements(elements, { regenerateIds: false });
    excalidrawAPI.updateScene({
      elements: renderable,
      appState: { viewBackgroundColor: "#fffdf8" },
    });
    if (recenter && renderable.length > 0) {
      // Defer so updateScene's commit is flushed before scrollToContent measures bounds.
      requestAnimationFrame(() =>
        excalidrawAPI.scrollToContent(undefined, { animate: false }),
      );
    }
    scheduleScreenshot();
  }

  function handleExcalidrawChange(elements, appState) {
    // v0.15.0: track the current selection (cheap; only re-render on count
    // change) so the "Edit selected" scoped-edit bar can appear in live mode.
    const sel = appState?.selectedElementIds || {};
    const ids = Object.keys(sel).filter((id) => sel[id]);
    if (ids.length !== selectedIdsRef.current.length || ids.some((id, i) => id !== selectedIdsRef.current[i])) {
      selectedIdsRef.current = ids;
      setSelectedCount(ids.length);
    }
    // Only push user edits to the server while in live mode. In staging the
    // canvas is a client-side scratchpad; the server doesn't need to know.
    if (getMode() !== "live") return;
    // Allow user edits while listening, EXCEPT when the agent is actively thinking/processing a turn.
    if (getAgentStatus() === "thinking") return;
    clearTimeout(userElementsSyncTimerRef.current);
    userElementsSyncTimerRef.current = setTimeout(() => {
      const ws = getWs();
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const cleaned = nativeElementsToSkeletonForSync(elements ?? []);
      const hash = JSON.stringify(cleaned);
      if (hash === lastSyncedElementsHashRef.current) return;
      lastSyncedElementsHashRef.current = hash;
      ws.send({ type: "whiteboard:user-elements", elements: cleaned });
    }, 500);
  }

  function applyWhiteboardViewportCommand(command) {
    const excalidrawAPI = getExcalidrawApi();
    if (!excalidrawAPI) return;

    const action = command.action;
    if (action === "scroll_to_content") {
      const focusIds = Array.isArray(command.focus_ids)
        ? command.focus_ids
        : null;
      let target;
      if (focusIds && focusIds.length > 0) {
        const scene = excalidrawAPI.getSceneElements();
        const matched = scene.filter((el) => focusIds.includes(el.id));
        if (matched.length > 0) target = matched;
      }
      excalidrawAPI.scrollToContent(target, { animate: true });
    }
    if (action === "set_zoom") {
      setZoom(command.zoom);
    }
    if (action === "zoom_in") {
      setZoom(getZoom() * 1.2);
    }
    if (action === "zoom_out") {
      setZoom(getZoom() / 1.2);
    }
    if (action === "reset_zoom") {
      setZoom(1);
    }
    scheduleScreenshot();
  }

  return {
    applyScene,
    handleExcalidrawChange,
    applyWhiteboardViewportCommand,
    nativeElementsToSkeletonForSync,
    stripInternalFields,
  };
}

// Convert Excalidraw native elements back into the simple "skeleton" shape the
// server stores. Critical: when the agent emits {rectangle, label: "X"},
// convertToExcalidrawElements expands that into a rectangle PLUS a separate
// bound text element. If we echo both back to the server verbatim, the server's
// state.elements doubles up - on the next agent turn the rectangle has lost its
// label, the agent re-adds it, Excalidraw creates ANOTHER bound text, and now
// the canvas renders the same label twice. Folding bound text back into the
// shape's label field on the way out keeps state.elements in the canonical form
// the agent expects.
export function nativeElementsToSkeletonForSync(nativeElements) {
  const elements = nativeElements.filter((el) => el && !el.isDeleted);
  const byId = new Map(elements.map((el) => [el.id, el]));
  const consumedTextIds = new Set();
  const result = [];

  for (const el of elements) {
    // Bound text whose parent shape is in the scene: skip - it'll be folded
    // into the parent's label below.
    if (el.type === "text" && el.containerId && byId.has(el.containerId)) {
      consumedTextIds.add(el.id);
      continue;
    }

    const boundElements = Array.isArray(el.boundElements)
      ? el.boundElements
      : null;
    const textBinding =
      boundElements && boundElements.find((b) => b?.type === "text");
    const labelText = textBinding && byId.get(textBinding.id);

    if (labelText) {
      consumedTextIds.add(labelText.id);
      result.push({
        ...stripInternalFields(el),
        label: {
          text: labelText.text ?? "",
          fontSize: labelText.fontSize ?? 18,
        },
      });
      continue;
    }

    result.push(stripInternalFields(el));
  }

  return result.filter((el) => !consumedTextIds.has(el.id));
}

export function stripInternalFields(el) {
  // Drop Excalidraw fields that change on every render (cache thrash) or that
  // we don't want the agent reasoning about (locking, grouping, etc.).
  const {
    versionNonce,
    version,
    updated,
    seed,
    index,
    link,
    locked,
    customData,
    frameId,
    groupIds,
    boundElements,
    containerId,
    isDeleted,
    ...rest
  } = el;
  return rest;
}
