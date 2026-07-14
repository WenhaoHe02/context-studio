import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { codexHome } from "./discovery.mjs";
import { ensureOriginalBackup, readBackup, restoreBackup } from "./backups.mjs";
import {
  applyDeletions,
  applyPatches,
  parseJsonl,
  readRollout,
  safeSave,
  serializeDocument,
} from "./rollout.mjs";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

function dataRoot() {
  return path.resolve(process.env.PLUGIN_DATA || path.join(codexHome(), "context-studio"));
}

function stageRoot() {
  return path.join(dataRoot(), "staged-actions");
}

function stagePath(requestId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(requestId))) {
    throw Object.assign(new Error("Invalid staged request id."), { code: "INVALID_REQUEST_ID" });
  }
  return path.join(stageRoot(), `${requestId}.json`);
}

function writeStage(stage) {
  fs.mkdirSync(stageRoot(), { recursive: true });
  const target = stagePath(stage.requestId);
  // This is control-plane metadata, not a rollout. Writing it in place avoids
  // Windows rename failures when advancing an existing stage to committed or
  // complete. A malformed partial write is rejected by readStagedAction.
  fs.writeFileSync(target, `${JSON.stringify(stage, null, 2)}\n`);
  return stage;
}

export function readStagedAction(requestId) {
  const target = stagePath(requestId);
  if (!fs.existsSync(target)) {
    throw Object.assign(new Error("Staged context action was not found."), { code: "STAGE_NOT_FOUND" });
  }
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (cause) {
    throw Object.assign(new Error("Staged context action metadata is invalid."), {
      code: "INVALID_STAGE",
      cause,
    });
  }
}

function validateThreadId(threadId) {
  if (!THREAD_ID.test(String(threadId))) {
    throw Object.assign(new Error("Invalid thread id."), { code: "INVALID_THREAD_ID" });
  }
  return String(threadId);
}

function walkForThread(root, threadId) {
  if (!fs.existsSync(root)) return [];
  const suffix = `${threadId}.jsonl`.toLowerCase();
  const stack = [root];
  const matches = [];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(candidate);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) matches.push(candidate);
    }
  }
  return matches;
}

export function resolveThreadRollout(threadId, location = "any") {
  const id = validateThreadId(threadId);
  const roots = location === "archived"
    ? [path.join(codexHome(), "archived_sessions")]
    : location === "sessions"
      ? [path.join(codexHome(), "sessions")]
      : [path.join(codexHome(), "sessions"), path.join(codexHome(), "archived_sessions")];
  const matches = roots.flatMap((root) => walkForThread(root, id));
  for (const candidate of matches) {
    try {
      const rollout = readRollout(candidate);
      if (rollout.document.meta.threadId === id) return rollout;
    } catch {}
  }
  const error = new Error(`Could not find ${location} rollout for thread ${id}.`);
  error.code = location === "archived" ? "THREAD_NOT_ARCHIVED" : "THREAD_NOT_FOUND";
  throw error;
}

function assertStageable(current, expectedHash) {
  if (current.hash !== expectedHash) {
    throw Object.assign(new Error("The rollout changed after it was opened."), { code: "RACE_DETECTED" });
  }
  if (!current.document.status.idle) {
    throw Object.assign(new Error(`Turn ${current.document.status.activeTurnId} is active.`), { code: "THREAD_ACTIVE" });
  }
  if (!current.document.validation.ok) {
    throw Object.assign(new Error("The rollout does not pass structural validation."), { code: "INVALID_ORIGINAL" });
  }
}

function validateSavePreview(current, patches, deletions) {
  const preview = parseJsonl(current.buffer, current.resolved);
  applyPatches(preview, patches);
  applyDeletions(preview, deletions);
  const roundTrip = parseJsonl(Buffer.from(serializeDocument(preview), "utf8"), current.resolved);
  if (!roundTrip.validation.ok || roundTrip.meta.threadId !== current.document.meta.threadId) {
    throw Object.assign(new Error("The staged edit failed round-trip validation."), {
      code: "INVALID_EDIT",
      details: roundTrip.validation.issues,
    });
  }
}

export function stageContextAction({ action, filePath, expectedHash, patches = [], deletions = [], backupId = null }) {
  const current = readRollout(filePath);
  assertStageable(current, expectedHash);
  if (action === "save") {
    if (!Array.isArray(patches) || !Array.isArray(deletions)) {
      throw Object.assign(new Error("Patches and deletions must be arrays."), { code: "INVALID_BODY" });
    }
    validateSavePreview(current, patches, deletions);
  } else if (action === "restore") {
    if (typeof backupId !== "string") {
      throw Object.assign(new Error("A backup version is required."), { code: "INVALID_BODY" });
    }
    readBackup(current.document.meta.threadId, backupId);
  } else {
    throw Object.assign(new Error("Unknown staged action."), { code: "INVALID_ACTION" });
  }

  const requestId = crypto.randomUUID();
  const stage = writeStage({
    requestId,
    action,
    threadId: current.document.meta.threadId,
    sourcePath: current.resolved,
    expectedHash,
    patches,
    deletions,
    backupId,
    status: "staged",
    createdAt: new Date().toISOString(),
  });
  return { stage, summary: current.summary };
}

export function commitStagedAction(requestId) {
  const stage = readStagedAction(requestId);
  if (stage.status === "committed" || stage.status === "complete") return stage;
  if (stage.status !== "staged") {
    throw Object.assign(new Error(`Staged action is ${stage.status}.`), { code: "INVALID_STAGE_STATE" });
  }
  const archived = resolveThreadRollout(stage.threadId, "archived");
  assertStageable(archived, stage.expectedHash);
  let result;
  if (stage.action === "save") {
    result = safeSave({
      filePath: archived.resolved,
      expectedHash: stage.expectedHash,
      patches: stage.patches,
      deletions: stage.deletions,
      quietPeriodMs: 0,
      backupWriter: (args) => ensureOriginalBackup(args).dataPath,
    });
  } else {
    result = restoreBackup({
      filePath: archived.resolved,
      expectedHash: stage.expectedHash,
      threadId: stage.threadId,
      backupId: stage.backupId,
    });
  }
  const next = {
    ...stage,
    status: "committed",
    committedAt: new Date().toISOString(),
    committedHash: result.summary.hash,
    committedPath: result.summary.path,
  };
  writeStage(next);
  return next;
}

export function verifyStagedAction(requestId) {
  const stage = readStagedAction(requestId);
  if (stage.status === "complete") return stage;
  if (stage.status !== "committed") {
    throw Object.assign(new Error("The staged action has not been committed."), { code: "NOT_COMMITTED" });
  }
  const current = resolveThreadRollout(stage.threadId, "sessions");
  if (current.hash !== stage.committedHash) {
    throw Object.assign(new Error("The unarchived rollout hash does not match the committed edit."), { code: "RELOAD_HASH_MISMATCH" });
  }
  if (!current.document.status.idle || !current.document.validation.ok) {
    throw Object.assign(new Error("The unarchived rollout failed status or structural validation."), { code: "RELOAD_VALIDATION_FAILED" });
  }
  const next = {
    ...stage,
    status: "complete",
    completedAt: new Date().toISOString(),
    finalPath: current.resolved,
  };
  writeStage(next);
  return next;
}

export function hotReloadPrompt(stage) {
  return [
    `Context Studio staged ${stage.action} request ${stage.requestId} for thread ${stage.threadId}.`,
    "Perform the hot reload now in this exact order:",
    `1. Call codex_app set_thread_archived with threadId=${stage.threadId} and archived=true.`,
    `2. Call commit_staged_context_action with requestId=${stage.requestId}.`,
    `3. Always call codex_app set_thread_archived with threadId=${stage.threadId} and archived=false, even if commit failed.`,
    `4. If commit succeeded, call verify_staged_context_action with requestId=${stage.requestId}.`,
    `5. If verification succeeded, call codex_app navigate_to_codex_page with threadId=${stage.threadId}. This makes Codex Desktop reopen the edited task and rebuild its visible turns from the committed rollout.`,
    "If navigation is unavailable or fails, keep the verified edit and report that Desktop display refresh is still required.",
    "Do not edit the rollout with shell commands. Report the final verification and display-refresh result briefly.",
  ].join("\n");
}
