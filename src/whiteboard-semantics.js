// Structural reader for the whiteboard.
//
// The drawing agent sees the canvas as line-numbered element JSON
// (formatLineNumberedWhiteboard in whiteboard-tools.js). That is exactly the
// right contract for editing by line number, but it carries no structure: you
// cannot tell from it which stickies sit inside which zone, what the arrows
// connect, or how the diagram reads.
//
// The ASK agent needs the opposite: a semantic view. This module derives one -
// zones and their contents, connections between elements, and spatial clusters
// of anything that isn't in a zone - and renders it as compact markdown.
//
// Pure functions, no I/O. Additive: nothing here touches the edit contract or
// the cached prompt prefix used by the drawing agent.

// Shapes that can hold other elements. Frames are Excalidraw's explicit
// grouping primitive; the rest are containers by geometry (our brainstorm
// templates draw zones as plain rectangles).
const CONTAINER_TYPES = new Set(["rectangle", "ellipse", "diamond", "frame", "magicframe"]);
const LINEAR_TYPES = new Set(["arrow", "line"]);

// A header text sitting within this many px of a container's top edge names
// the zone rather than counting as one of its items.
const HEADER_BAND_PX = 44;
// Two loose elements belong to the same horizontal band if their vertical gap
// is under this. Roughly "the next row of stickies down".
const CLUSTER_GAP_PX = 120;
// How close an unbound arrow endpoint must be to an element to count as
// pointing at it.
const ENDPOINT_SNAP_PX = 60;

// Caps so a huge board still produces a promptable digest.
const MAX_ITEMS_PER_GROUP = 40;
const MAX_CONNECTIONS = 60;
const MAX_LABEL_CHARS = 160;

export function describeWhiteboard(elements) {
  const live = liveElements(elements);
  if (live.length === 0) return "(the board is empty - nothing has been drawn yet)";

  const structure = readBoardStructure(live);
  const lines = [];

  lines.push(
    `# Board - ${live.length} elements, ${structure.zones.length} zones, ${structure.connections.length} connections`,
  );

  for (const zone of structure.zones) {
    lines.push("");
    const where = describePosition(zone, structure.bounds);
    lines.push(`## Zone "${zone.title || "(untitled)"}"${where ? `  (${where})` : ""}`);
    if (zone.items.length === 0) {
      lines.push("- (empty)");
      continue;
    }
    for (const item of zone.items.slice(0, MAX_ITEMS_PER_GROUP)) {
      lines.push(`- ${renderItem(item)}`);
    }
    if (zone.items.length > MAX_ITEMS_PER_GROUP) {
      lines.push(`- ...and ${zone.items.length - MAX_ITEMS_PER_GROUP} more`);
    }
  }

  if (structure.connections.length > 0) {
    lines.push("");
    lines.push("## Connections");
    for (const conn of structure.connections.slice(0, MAX_CONNECTIONS)) {
      const label = conn.label ? ` [${conn.label}]` : "";
      const arrow = conn.type === "line" ? "--" : "->";
      lines.push(`- "${conn.from}" ${arrow}${label} "${conn.to}"`);
    }
    if (structure.connections.length > MAX_CONNECTIONS) {
      lines.push(`- ...and ${structure.connections.length - MAX_CONNECTIONS} more`);
    }
  }

  structure.clusters.forEach((cluster, index) => {
    lines.push("");
    const heading =
      structure.clusters.length === 1
        ? "## Loose items (not inside any zone)"
        : `## Loose group ${index + 1} (not inside any zone)`;
    lines.push(heading);
    for (const item of cluster.items.slice(0, MAX_ITEMS_PER_GROUP)) {
      lines.push(`- ${renderItem(item)}`);
    }
    if (cluster.items.length > MAX_ITEMS_PER_GROUP) {
      lines.push(`- ...and ${cluster.items.length - MAX_ITEMS_PER_GROUP} more`);
    }
  });

  return lines.join("\n");
}

export function readBoardStructure(elements) {
  const live = liveElements(elements);
  const byId = new Map();
  for (const element of live) {
    byId.set(element.id, { element, label: "", role: "item" });
  }

  // --- labels -------------------------------------------------------------
  // A text element bound into a container (containerId, or listed in the
  // container's boundElements) is that container's label, not a board item.
  for (const element of live) {
    const entry = byId.get(element.id);
    if (element.type === "text") {
      entry.label = cleanLabel(element.text);
      const parent = element.containerId ? byId.get(element.containerId) : null;
      if (parent) {
        entry.role = "bound-label";
        if (!parent.label) parent.label = entry.label;
      }
      continue;
    }
    for (const bound of element.boundElements ?? []) {
      if (bound?.type !== "text") continue;
      const child = byId.get(bound.id);
      if (!child) continue;
      child.role = "bound-label";
      if (!entry.label) entry.label = cleanLabel(child.element.text);
    }
  }
  // Anything still unlabelled falls back to a shape description.
  for (const entry of byId.values()) {
    if (!entry.label) entry.label = describeShape(entry.element);
  }

  // --- containment --------------------------------------------------------
  const containers = live
    .filter((el) => CONTAINER_TYPES.has(el.type))
    .map((el) => ({ element: el, area: Math.abs(width(el) * height(el)) }))
    .sort((a, b) => a.area - b.area); // smallest first: innermost wins

  const zoneOf = new Map(); // child id -> container id
  for (const element of live) {
    if (LINEAR_TYPES.has(element.type)) continue;
    if (byId.get(element.id).role === "bound-label") continue;
    const center = centerOf(element);
    for (const candidate of containers) {
      if (candidate.element.id === element.id) continue;
      if (!containsPoint(candidate.element, center)) continue;
      // Skip a container that is itself inside the element (degenerate overlap).
      if (candidate.area >= Math.abs(width(element) * height(element)) && CONTAINER_TYPES.has(element.type)) {
        continue;
      }
      zoneOf.set(element.id, candidate.element.id);
      break;
    }
  }

  // A text element sitting in the header band of its zone titles that zone.
  const zones = [];
  for (const candidate of containers) {
    const container = candidate.element;
    // A container that is itself inside another container is treated as an
    // item of its parent, not as a top-level zone.
    if (zoneOf.has(container.id) && CONTAINER_TYPES.has(container.type)) {
      // Still a zone if it holds children of its own.
      const holdsChildren = live.some((el) => zoneOf.get(el.id) === container.id);
      if (!holdsChildren) continue;
    }
    const entry = byId.get(container.id);
    const children = live.filter((el) => zoneOf.get(el.id) === container.id);

    let title = entry.label === describeShape(container) ? "" : entry.label;
    const items = [];
    for (const child of children) {
      const childEntry = byId.get(child.id);
      if (
        !title &&
        child.type === "text" &&
        child.y - top(container) <= HEADER_BAND_PX
      ) {
        title = childEntry.label;
        childEntry.role = "zone-title";
        continue;
      }
      items.push(childEntry);
    }
    if (children.length === 0 && !title) continue;
    // Promote the derived title onto the container itself so anything else
    // referring to it - an arrow endpoint, most importantly - names the zone
    // instead of falling back to "(unlabelled rectangle 300x300)".
    if (title) entry.label = title;
    zones.push({
      id: container.id,
      title,
      color: container.backgroundColor ?? null,
      element: container,
      items: sortReadingOrder(items),
    });
  }
  // Report zones in reading order, biggest structure first at equal position.
  zones.sort((a, b) => top(a.element) - top(b.element) || left(a.element) - left(b.element));

  // --- connections --------------------------------------------------------
  const connections = [];
  for (const element of live) {
    if (!LINEAR_TYPES.has(element.type)) continue;
    const from = resolveEndpoint(element, "start", byId, live);
    const to = resolveEndpoint(element, "end", byId, live);
    if (!from || !to || from === to) continue;
    connections.push({
      id: element.id,
      type: element.type,
      from: byId.get(from).label,
      to: byId.get(to).label,
      label: connectionLabel(element, byId),
    });
  }

  // --- loose clusters -----------------------------------------------------
  const loose = live
    .filter((el) => !LINEAR_TYPES.has(el.type))
    .filter((el) => !zoneOf.has(el.id))
    .filter((el) => !zones.some((z) => z.id === el.id))
    .map((el) => byId.get(el.id))
    .filter((entry) => entry.role === "item");

  return {
    byId,
    zones,
    connections,
    clusters: clusterByBand(loose),
    loose,
    bounds: boundsOf(live),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function liveElements(elements) {
  if (!Array.isArray(elements)) return [];
  return elements.filter((el) => el && typeof el === "object" && el.id && !el.isDeleted);
}

function cleanLabel(text) {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (value.length <= MAX_LABEL_CHARS) return value;
  return `${value.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

function describeShape(element) {
  const w = Math.round(Math.abs(width(element)));
  const h = Math.round(Math.abs(height(element)));
  return `(unlabelled ${element.type} ${w}x${h})`;
}

function renderItem(entry) {
  const label = entry.label;
  if (entry.element.type === "text") return `"${label}"`;
  return `"${label}" (${entry.element.type})`;
}

function width(el) {
  return Number(el.width ?? 0);
}
function height(el) {
  return Number(el.height ?? 0);
}
function left(el) {
  return Math.min(Number(el.x ?? 0), Number(el.x ?? 0) + width(el));
}
function top(el) {
  return Math.min(Number(el.y ?? 0), Number(el.y ?? 0) + height(el));
}
function right(el) {
  return left(el) + Math.abs(width(el));
}
function bottom(el) {
  return top(el) + Math.abs(height(el));
}
function centerOf(el) {
  return { x: (left(el) + right(el)) / 2, y: (top(el) + bottom(el)) / 2 };
}

function containsPoint(container, point) {
  return (
    point.x >= left(container) &&
    point.x <= right(container) &&
    point.y >= top(container) &&
    point.y <= bottom(container)
  );
}

function boundsOf(elements) {
  if (elements.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return elements.reduce(
    (acc, el) => ({
      minX: Math.min(acc.minX, left(el)),
      minY: Math.min(acc.minY, top(el)),
      maxX: Math.max(acc.maxX, right(el)),
      maxY: Math.max(acc.maxY, bottom(el)),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

// "top-left", "lower-right", "center" - a coarse spatial hint so the agent can
// answer questions like "what's in the top-right of the board?".
function describePosition(zone, bounds) {
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  if (spanX <= 0 || spanY <= 0) return "";
  const c = centerOf(zone.element);
  const fx = (c.x - bounds.minX) / spanX;
  const fy = (c.y - bounds.minY) / spanY;
  const vertical = fy < 0.34 ? "top" : fy > 0.66 ? "lower" : "middle";
  const horizontal = fx < 0.34 ? "left" : fx > 0.66 ? "right" : "center";
  return `${vertical}-${horizontal}`;
}

function sortReadingOrder(entries) {
  return [...entries].sort((a, b) => {
    const ay = top(a.element);
    const by = top(b.element);
    // Treat elements within a band as the same row, then order left to right.
    if (Math.abs(ay - by) > CLUSTER_GAP_PX / 2) return ay - by;
    return left(a.element) - left(b.element);
  });
}

function clusterByBand(entries) {
  if (entries.length === 0) return [];
  const sorted = [...entries].sort((a, b) => top(a.element) - top(b.element));
  const clusters = [];
  let current = { items: [sorted[0]] };
  let bandBottom = bottom(sorted[0].element);

  for (const entry of sorted.slice(1)) {
    if (top(entry.element) - bandBottom > CLUSTER_GAP_PX) {
      clusters.push({ items: sortReadingOrder(current.items) });
      current = { items: [entry] };
      bandBottom = bottom(entry.element);
      continue;
    }
    current.items.push(entry);
    bandBottom = Math.max(bandBottom, bottom(entry.element));
  }
  clusters.push({ items: sortReadingOrder(current.items) });
  return clusters;
}

// Resolve which element an arrow endpoint refers to. Prefer the explicit
// Excalidraw binding; fall back to whatever element sits closest to the
// endpoint coordinate, within a snap radius.
function resolveEndpoint(arrow, which, byId, live) {
  const binding = which === "start" ? arrow.startBinding : arrow.endBinding;
  if (binding?.elementId && byId.has(binding.elementId)) return binding.elementId;

  const point = endpointCoordinate(arrow, which);
  if (!point) return null;

  let best = null;
  let bestDistance = ENDPOINT_SNAP_PX;
  for (const element of live) {
    if (element.id === arrow.id) continue;
    if (LINEAR_TYPES.has(element.type)) continue;
    if (byId.get(element.id).role === "bound-label") continue;
    const distance = distanceToRect(element, point);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = element.id;
    }
  }
  return best;
}

function endpointCoordinate(arrow, which) {
  const x = Number(arrow.x ?? 0);
  const y = Number(arrow.y ?? 0);
  const points = Array.isArray(arrow.points) ? arrow.points : null;
  if (points && points.length >= 2) {
    const point = which === "start" ? points[0] : points[points.length - 1];
    if (Array.isArray(point)) return { x: x + Number(point[0]), y: y + Number(point[1]) };
  }
  // No point list: fall back to the bounding box corners implied by w/h.
  if (which === "start") return { x, y };
  return { x: x + Number(arrow.width ?? 0), y: y + Number(arrow.height ?? 0) };
}

function distanceToRect(element, point) {
  const dx = Math.max(left(element) - point.x, 0, point.x - right(element));
  const dy = Math.max(top(element) - point.y, 0, point.y - bottom(element));
  return Math.sqrt(dx * dx + dy * dy);
}

function connectionLabel(arrow, byId) {
  for (const bound of arrow.boundElements ?? []) {
    if (bound?.type !== "text") continue;
    const child = byId.get(bound.id);
    if (child?.label) return child.label;
  }
  if (arrow.label?.text) return cleanLabel(arrow.label.text);
  return "";
}
