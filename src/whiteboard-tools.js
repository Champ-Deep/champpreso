export function formatLineNumberedWhiteboard(elements) {
  if (!Array.isArray(elements) || elements.length === 0) return "(empty whiteboard)";

  const width = Math.max(3, String(elements.length).length);
  return elements
    .map((element, index) => `${String(index + 1).padStart(width, "0")}: ${JSON.stringify(element)}`)
    .join("\n");
}

export function applyWhiteboardEditOperations(elements, operations) {
  const nextElements = [...elements];

  for (const operation of operations) {
    if (operation.type === "replace") {
      assertLineInRange(operation.line, nextElements.length, `Cannot replace line ${operation.line}`);
      nextElements[operation.line - 1] = operation.element;
      continue;
    }

    if (operation.type === "insert_after") {
      assertLineInInsertRange(operation.line, nextElements.length, `Cannot insert after line ${operation.line}`);
      nextElements.splice(operation.line, 0, operation.element);
      continue;
    }

    if (operation.type === "delete") {
      assertLineInRange(operation.line, nextElements.length, `Cannot delete line ${operation.line}`);
      nextElements.splice(operation.line - 1, 1);
      continue;
    }

    throw new Error(`Unknown whiteboard edit operation "${operation.type}".`);
  }

  return nextElements;
}

// Map a set of Excalidraw element ids to their 1-based line numbers in the
// current line-numbered whiteboard view. Used by scoped editing to tell the
// agent which lines the user selected. Returns an ascending list of lines.
export function mapSelectedIdsToLineNumbers(elements, selectedIds) {
  if (!Array.isArray(elements)) return [];
  const selected = new Set(selectedIds ?? []);
  const lines = [];
  elements.forEach((element, index) => {
    if (element && selected.has(element.id)) lines.push(index + 1);
  });
  return lines;
}

// Hard backstop for scoped edits: given the canvas before the turn, the agent's
// result after the turn, and the set of selected ids the user authorized, keep
// edits to selected elements and any newly added elements, but restore every
// unselected element the agent modified or deleted. Guarantees the rest of the
// canvas cannot drift on a scoped-edit turn regardless of line-number shifts.
export function restoreUnselectedElements(beforeElements, afterElements, selectedIds) {
  const before = Array.isArray(beforeElements) ? beforeElements : [];
  const after = Array.isArray(afterElements) ? afterElements : [];
  const selected = new Set(selectedIds ?? []);
  const beforeById = new Map(before.filter((el) => el && el.id != null).map((el) => [el.id, el]));
  const afterIds = new Set(after.filter((el) => el && el.id != null).map((el) => el.id));

  const result = after.map((element) => {
    if (!element || element.id == null) return element;
    if (selected.has(element.id)) return element; // selected: keep the agent's edit
    const original = beforeById.get(element.id);
    if (!original) return element; // new element the agent added: keep it
    return original; // unselected existing element: restore the original
  });

  // Re-add unselected elements the agent deleted, preserving their order.
  for (const original of before) {
    if (!original || original.id == null) continue;
    if (selected.has(original.id)) continue;
    if (!afterIds.has(original.id)) result.push(original);
  }

  return result;
}

function assertLineInRange(line, lineCount, message) {
  if (!Number.isInteger(line) || line < 1 || line > lineCount) {
    throw new Error(`${message}; whiteboard has ${lineCount} line${lineCount === 1 ? "" : "s"}.`);
  }
}

function assertLineInInsertRange(line, lineCount, message) {
  if (!Number.isInteger(line) || line < 0 || line > lineCount) {
    throw new Error(`${message}; whiteboard has ${lineCount} line${lineCount === 1 ? "" : "s"}.`);
  }
}
