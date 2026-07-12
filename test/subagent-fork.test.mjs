import assert from "node:assert/strict";
import test from "node:test";
import { prepareSubagentFork } from "../lib/subagent-fork.mjs";

const parentThreadId = "00000000-0000-7000-8000-000000000001";
const childThreadId = "00000000-0000-7000-8000-000000000002";

function fixture({ parentIdle = true, mismatch = false } = {}) {
  return [
    { threadId: parentThreadId, title: "Parent", status: { idle: parentIdle }, isSubagent: false },
    { threadId: childThreadId, title: "Child", status: { idle: true }, isSubagent: true, parentThreadId: mismatch ? "00000000-0000-7000-8000-000000000003" : parentThreadId },
  ];
}

test("prepares a true subagent fork through the verified idle parent", () => {
  const result = prepareSubagentFork(
    { childThreadId, parentThreadId, task: "Continue the delegated investigation" },
    { rollouts: fixture() },
  );
  assert.equal(result.parentThreadId, parentThreadId);
  assert.match(result.hostActionPrompt, /send_message_to_thread/);
  assert.match(result.hostActionPrompt, /spawn_agent/);
  assert.match(result.hostActionPrompt, /fork_turns=\\?"all\\?"/);
  assert.match(result.hostActionPrompt, /Do not call codex_app\.fork_thread/);
});

test("refuses a fork when the parent is active or the relationship is false", () => {
  assert.throws(
    () => prepareSubagentFork({ childThreadId, parentThreadId, task: "Task" }, { rollouts: fixture({ parentIdle: false }) }),
    (error) => error.code === "PARENT_THREAD_ACTIVE",
  );
  assert.throws(
    () => prepareSubagentFork({ childThreadId, parentThreadId, task: "Task" }, { rollouts: fixture({ mismatch: true }) }),
    (error) => error.code === "SUBAGENT_PARENT_MISMATCH",
  );
});
