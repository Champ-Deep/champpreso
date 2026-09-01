// Candidate lifecycle: the board shows its own confidence.
//
// Elements born in a "hypothesis" turn render dashed at 50% opacity. They
// solidify when a "decision" turn updates them, when the user edits or pins
// them, and they quietly expire when the room moves on without confirming
// them. Everything here is mechanical - it never trusts the model to manage
// its own provisionality.
//
// Status lives in a server-side registry (a Map of id -> { bornTurn, orig }),
// NOT in element customData: the frontend's stripInternalFields drops
// customData when user edits echo back, so anything stored there would be
// silently erased on the first user touch. strokeStyle/opacity are ordinary
// element props and survive the round-trip.

const CANDIDATE_STYLE = { strokeStyle: "dashed", opacity: 50 };
export const CANDIDATE_MAX_AGE_TURNS = 2;

// Props that count as "the user meaningfully changed this element".
const TOUCH_PROPS = ["x", "y", "width", "height", "text", "backgroundColor", "type", "points"];

function labelText(el) {
  return el?.label?.text ?? null;
}

/**
 * Mark every element that did not exist before this turn as a candidate.
 * Returns fresh {elements, candidates}; inputs are not mutated.
 */
export function markNewCandidates({ beforeIds, elements, candidates, turn }) {
  const nextCandidates = new Map(candidates);
  const nextElements = elements.map((el) => {
    if (!el?.id || beforeIds.has(el.id) || nextCandidates.has(el.id)) return el;
    nextCandidates.set(el.id, {
      bornTurn: turn,
      orig: { strokeStyle: el.strokeStyle, opacity: el.opacity },
    });
    return { ...el, ...CANDIDATE_STYLE };
  });
  return { elements: nextElements, candidates: nextCandidates };
}

/**
 * Promote the given candidate ids: restore their original style and drop the
 * registry entries. An orig value of undefined means the element never had
 * that prop - remove it rather than writing "undefined".
 */
export function promoteCandidates({ elements, candidates, ids }) {
  if (!ids || ids.length === 0) return { elements, candidates, promotedIds: [] };
  const promotable = ids.filter((id) => candidates.has(id));
  if (promotable.length === 0) return { elements, candidates, promotedIds: [] };
  const nextCandidates = new Map(candidates);
  const byId = new Map(promotable.map((id) => [id, nextCandidates.get(id)]));
  for (const id of promotable) nextCandidates.delete(id);
  const nextElements = elements.map((el) => {
    const entry = el?.id ? byId.get(el.id) : undefined;
    if (!entry) return el;
    const restored = { ...el };
    for (const prop of ["strokeStyle", "opacity"]) {
      if (entry.orig[prop] === undefined) delete restored[prop];
      else restored[prop] = entry.orig[prop];
    }
    return restored;
  });
  return { elements: nextElements, candidates: nextCandidates, promotedIds: promotable };
}

/**
 * Delete candidates that have gone unconfirmed for more than maxAgeTurns
 * completed turns. Pinned candidates are never auto-deleted (promote them
 * instead, elsewhere). Registry entries whose element vanished (user delete,
 * undo) are pruned as orphans.
 */
export function expireStaleCandidates({ elements, candidates, turn, pinnedIds = new Set(), maxAgeTurns = CANDIDATE_MAX_AGE_TURNS }) {
  const liveIds = new Set(elements.map((el) => el?.id).filter(Boolean));
  const nextCandidates = new Map();
  const expiredIds = [];
  for (const [id, entry] of candidates) {
    if (!liveIds.has(id)) continue; // orphan - element already gone
    if (pinnedIds.has(id)) {
      nextCandidates.set(id, entry);
      continue;
    }
    if (turn - entry.bornTurn >= maxAgeTurns) {
      expiredIds.push(id);
      continue;
    }
    nextCandidates.set(id, entry);
  }
  if (expiredIds.length === 0) {
    return { elements, candidates: nextCandidates, expiredIds };
  }
  const gone = new Set(expiredIds);
  return {
    elements: elements.filter((el) => !gone.has(el?.id)),
    candidates: nextCandidates,
    expiredIds,
  };
}

/**
 * Which candidates did the user meaningfully change between two synced scenes?
 * Compares only touch-relevant props so frontend normalization noise (version
 * fields are already stripped upstream) cannot fake a touch.
 */
export function detectUserTouchedCandidates({ prevElements, nextElements, candidates }) {
  if (candidates.size === 0) return [];
  const prevById = new Map(prevElements.map((el) => [el?.id, el]));
  const touched = [];
  for (const el of nextElements) {
    if (!el?.id || !candidates.has(el.id)) continue;
    const prev = prevById.get(el.id);
    if (!prev) continue;
    const changed =
      TOUCH_PROPS.some((prop) => JSON.stringify(el[prop]) !== JSON.stringify(prev[prop])) ||
      labelText(el) !== labelText(prev);
    if (changed) touched.push(el.id);
  }
  return touched;
}

/**
 * Which candidates did the agent update this turn? (A decision turn updating
 * a candidate is the conversation confirming it.) Insertions are excluded by
 * construction - a candidate existed before the turn.
 */
export function detectAgentTouchedCandidates({ beforeElements, afterElements, candidates }) {
  if (candidates.size === 0) return [];
  const beforeById = new Map(beforeElements.map((el) => [el?.id, el]));
  const touched = [];
  for (const el of afterElements) {
    if (!el?.id || !candidates.has(el.id)) continue;
    const before = beforeById.get(el.id);
    if (!before) continue;
    if (JSON.stringify(before) !== JSON.stringify(el)) touched.push(el.id);
  }
  return touched;
}
