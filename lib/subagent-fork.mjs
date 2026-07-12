import { discoverRollouts } from "./discovery.mjs";
import crypto from "node:crypto";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

function validateThreadId(value, field) {
  const id = String(value || "");
  if (!THREAD_ID.test(id)) {
    throw Object.assign(new Error(`${field} is not a valid thread id.`), { code: "INVALID_THREAD_ID" });
  }
  return id;
}

function validateTask(value) {
  const task = String(value || "").trim();
  if (!task) throw Object.assign(new Error("Describe the task for the new subagent."), { code: "EMPTY_SUBAGENT_TASK" });
  if (task.length > 4000) throw Object.assign(new Error("The subagent task is longer than 4000 characters."), { code: "SUBAGENT_TASK_TOO_LONG" });
  return task;
}

export function prepareSubagentFork(
  { childThreadId, parentThreadId, task },
  { rollouts = discoverRollouts({ limit: 2000 }) } = {},
) {
  const childId = validateThreadId(childThreadId, "childThreadId");
  const parentId = validateThreadId(parentThreadId, "parentThreadId");
  const delegatedTask = validateTask(task);
  const child = rollouts.find((item) => item.threadId === childId);
  const parent = rollouts.find((item) => item.threadId === parentId);
  if (!child || !parent) {
    throw Object.assign(new Error("The selected parent or subagent is no longer available."), { code: "THREAD_NOT_FOUND" });
  }
  if (!child.isSubagent || child.parentThreadId !== parentId) {
    throw Object.assign(new Error("The selected task is not a child of the requested parent."), { code: "SUBAGENT_PARENT_MISMATCH" });
  }
  if (!parent.status?.idle) {
    throw Object.assign(new Error("Wait for the parent task to become idle before forking its context."), { code: "PARENT_THREAD_ACTIVE" });
  }

  const taskName = `context_fork_${childId.slice(0, 8)}_${crypto.randomBytes(3).toString("hex")}`;
  const parentPrompt = [
    "Context Studio request: create a replacement subagent with your complete context.",
    `The user selected existing subagent ${childId} as the task reference. Do not modify or archive that existing subagent.`,
    `Call spawn_agent exactly once with task_name=${JSON.stringify(taskName)}, fork_turns=\"all\", and message equal to the delegated task below.`,
    "Because you are the parent task, fork_turns=\"all\" gives the new subagent your complete completed conversation context and preserves the real parent/subagent relationship.",
    "After spawning, report the new subagent id and nickname. If no agent slot is available, report that error without creating an independent thread.",
    "<delegated_task>",
    delegatedTask,
    "</delegated_task>",
  ].join("\n");
  const hostActionPrompt = [
    "Context Studio full-parent-context subagent fork request.",
    `The parent task ${parentId} was verified idle and subagent ${childId} was verified as its child.`,
    "Call codex_app.send_message_to_thread exactly once with:",
    `- threadId: ${parentId}`,
    `- prompt: ${JSON.stringify(parentPrompt)}`,
    "Do not call codex_app.fork_thread: that creates an independent fork, not a true subagent of the selected parent.",
    "Do not copy or rewrite rollout JSONL. Briefly report that the request was dispatched to the parent task.",
  ].join("\n");

  return {
    childThreadId: childId,
    parentThreadId: parentId,
    task: delegatedTask,
    taskName,
    hostActionPrompt,
  };
}
