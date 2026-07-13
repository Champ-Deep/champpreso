import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  BRAINSTORM_TEMPLATES,
  TEMPLATE_ELEMENT_ID_PREFIX,
  isTemplateElementId,
} from "../public/brainstorm-templates.js";

const rootDir = path.join(import.meta.dirname, "..");

// The five brainstorming shapes the product is built around.
const EXPECTED_TEMPLATE_IDS = [
  "product-brainstorm",
  "campaign-planning",
  "team-strategy",
  "org-efficiency",
  "team-retro",
];

test("templates cover the five core brainstorming use cases", () => {
  assert.deepEqual(
    BRAINSTORM_TEMPLATES.map((t) => t.id),
    EXPECTED_TEMPLATE_IDS,
  );
  for (const template of BRAINSTORM_TEMPLATES) {
    assert.ok(template.label.length > 0, `${template.id} needs a label`);
    assert.ok(template.label.length <= 24, `${template.id} label must fit a chip`);
    assert.ok(template.intent.length >= 40, `${template.id} intent should be a real steer, not a stub`);
    assert.ok(template.intent.length <= 400, `${template.id} intent must stay concise`);
  }
});

test("every template element id carries the swap prefix so switching templates can remove the old skeleton", () => {
  for (const template of BRAINSTORM_TEMPLATES) {
    assert.ok(template.elements.length >= 4, `${template.id} should lay down a real structure`);
    for (const element of template.elements) {
      assert.ok(
        element.id.startsWith(`${TEMPLATE_ELEMENT_ID_PREFIX}${template.id}-`),
        `${template.id} element ${element.id} must be prefixed for swap/removal`,
      );
      assert.ok(isTemplateElementId(element.id));
    }
  }
  assert.equal(isTemplateElementId("some-user-element"), false);
  assert.equal(isTemplateElementId(undefined), false);
});

test("template element ids are globally unique", () => {
  const ids = BRAINSTORM_TEMPLATES.flatMap((t) => t.elements.map((e) => e.id));
  assert.equal(new Set(ids).size, ids.length);
});

test("template text elements reserve enough width for their longest line", () => {
  for (const template of BRAINSTORM_TEMPLATES) {
    for (const element of template.elements) {
      if (element.type !== "text") continue;
      const longest = Math.max(...element.text.split("\n").map((l) => l.length));
      assert.ok(
        element.width >= longest * element.fontSize * 0.55,
        `${element.id} width ${element.width} clips "${element.text}"`,
      );
    }
  }
});

test("template zone boxes avoid bound labels (they clip; explicit text elements are used instead)", () => {
  for (const template of BRAINSTORM_TEMPLATES) {
    for (const element of template.elements) {
      if (element.type === "rectangle") {
        assert.equal(element.label, undefined, `${element.id} must not use a bound label`);
      }
    }
  }
});

test("setup screen wires templates: fills intent, swaps tpl- skeleton on the canvas", () => {
  const source = readFileSync(path.join(rootDir, "public", "screens", "setup-screen.js"), "utf8");

  assert.match(source, /from "\.\.\/brainstorm-templates\.js"/);
  assert.match(source, /convertToExcalidrawElements/);
  assert.match(source, /isTemplateElementId/);
  // Old skeleton elements are filtered out before the new template lands.
  assert.match(source, /filter\(\s*\(?\w+\)?\s*=>\s*!isTemplateElementId\(/);
  // No stale copy of the old generic chip list.
  assert.doesNotMatch(source, /INTENT_TEMPLATES/);
});
