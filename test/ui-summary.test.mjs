import assert from "node:assert/strict";
import test from "node:test";
import { compactUiSummary, findUiEntry } from "../lib/ui-summary.mjs";

test("omits large locked entry text from the initial UI payload", () => {
  const text = "x".repeat(100_000);
  const summary = { entries: [{ id: "large", text, editable: false, tokens: 25_000 }, { id: "edit", text, editable: true }] };
  const compact = compactUiSummary(summary);
  assert.equal(compact.entries[0].textOmitted, true);
  assert.equal(compact.entries[0].text.length, 2_000);
  assert.equal(compact.entries[0].tokens, 25_000);
  assert.equal(compact.entries[1].text.length, text.length);
  assert.deepEqual(findUiEntry(summary, "large"), { id: "large", text });
});
