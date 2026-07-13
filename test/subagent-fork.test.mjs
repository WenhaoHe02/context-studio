import assert from "node:assert/strict";
import test from "node:test";
import { prepareSubagentFork } from "../lib/subagent-fork.mjs";

test("fork remains disabled until registered-task semantics are finalized", () => {
  assert.throws(
    () => prepareSubagentFork(),
    (error) => error.code === "FORK_FEATURE_DISABLED",
  );
});
