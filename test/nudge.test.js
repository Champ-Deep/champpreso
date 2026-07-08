import assert from "node:assert/strict";
import { test } from "node:test";

import { createWhiteboardSession } from "../src/whiteboard-session.js";

function makeSession() {
  return createWhiteboardSession({
    options: {},
    wss: { clients: new Set() },
    runAgent: async () => {},
  });
}

test("applyNudge pushes a role:user message, never role:system, so the ai SDK never flags it", () => {
  const session = makeSession();
  session.agentHistory = [{ role: "user", content: "primer" }];
  const applied = session.applyNudge("focus on the budget numbers");
  assert.equal(applied, true);
  const pushed = session.agentHistory.at(-1);
  assert.equal(pushed.role, "user");
  assert.match(pushed.content, /focus on the budget numbers/);
  assert.ok(
    session.agentHistory.every((m) => m.role !== "system"),
    "no message in agentHistory should ever use role:system - the ai SDK warns/throws on that",
  );
});
