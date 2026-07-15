import assert from "node:assert/strict";
import test from "node:test";
import { analyzePrefixReuseState, matchesEntryFilter } from "../public/prefix-reuse.js";

const entries = [
  { id: "first", text: "static first message" },
  { id: "last", text: "shared beginning and old tail" },
];
const segments = [
  { key: "one", tokens: 5, label: "first", editId: "first", deleteId: "first" },
  { key: "locked", tokens: 7, label: "tool call", editId: null, deleteId: null },
  { key: "last", tokens: 8, label: "last", editId: "last", deleteId: "last" },
];

test("reports an edit to the final model-visible item as suffix-only", () => {
  const result = analyzePrefixReuseState({
    segments,
    entries,
    edits: new Map([["last", "shared beginning and new tail"]]),
    deletions: new Set(),
    activeTokens: 20,
  });
  assert.equal(result.kind, "suffix");
  assert.equal(result.badge, "仅修改尾部");
  assert.ok(result.preservedTokens > 12);
});

test("reports an early edit followed by unchanged content as a broken middle prefix", () => {
  const result = analyzePrefixReuseState({
    segments,
    entries,
    edits: new Map([["first", "changed first message"]]),
    deletions: new Set(),
    activeTokens: 20,
  });
  assert.equal(result.kind, "broken");
  assert.match(result.detail, /first/);
});

test("ignores edits that are outside the current model-visible sequence", () => {
  const result = analyzePrefixReuseState({
    segments,
    entries,
    edits: new Map([["archived", "changed"]]),
    deletions: new Set(),
    activeTokens: 20,
  });
  assert.equal(result.kind, "inactive");
  assert.equal(result.preservedTokens, 20);
});

test("normal filters only show active model context while archive remains opt-in", () => {
  const active = { kind: "message", editable: true, deletable: true, inActiveContext: true, archived: false };
  const archived = { kind: "message", editable: true, deletable: false, inActiveContext: false, archived: true };
  assert.equal(matchesEntryFilter(active, "active"), true);
  assert.equal(matchesEntryFilter(archived, "active"), false);
  assert.equal(matchesEntryFilter(archived, "editable"), false);
  assert.equal(matchesEntryFilter(archived, "message"), false);
  assert.equal(matchesEntryFilter(archived, "archived"), true);
});
