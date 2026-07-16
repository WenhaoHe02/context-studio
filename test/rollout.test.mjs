import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyDeletions, applyPatches, approxTokens, parseJsonl, readRollout, safeSave, serializeDocument, sha256, toolOutputTokens } from "../lib/rollout.mjs";
import { createManualBackup, ensureOriginalBackup, listBackups, restoreBackup } from "../lib/backups.mjs";
import { discoverRollouts } from "../lib/discovery.mjs";
import { replaceFileVerified } from "../lib/safe-replace.mjs";
import { commitStagedAction, hotReloadPrompt, stageContextAction, verifyStagedAction } from "../lib/staged-actions.mjs";

function line(type, payload, timestamp = "2026-01-01T00:00:00Z") {
  return JSON.stringify({ timestamp, type, payload });
}

function fixture({ complete = true } = {}) {
  const records = [
    line("session_meta", { id: "thread-test", session_id: "thread-test", cwd: "C:\\repo", history_mode: "legacy", context_window: 128000 }),
    line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: "2026-01-01T00:00:00Z" }),
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the login bug" }] }),
    line("event_msg", { type: "user_message", message: "Fix the login bug", images: [], local_images: [], text_elements: [] }),
    line("response_item", { type: "function_call", name: "shell", call_id: "call-1", arguments: "{}" }),
    line("response_item", { type: "function_call_output", call_id: "call-1", output: "A very long test output" }),
    line("response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done" }] }),
    line("event_msg", { type: "agent_message", message: "Done", phase: "final_answer" }),
    line("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 100, output_tokens: 10 }, model_context_window: 128000 } }),
  ];
  if (complete) records.push(line("event_msg", { type: "task_complete", turn_id: "turn-1", last_agent_message: "Done" }));
  return `${records.join("\n")}\n`;
}

test("parses editable messages, paired tool outputs, usage, and idle state", () => {
  const doc = parseJsonl(Buffer.from(fixture()), "fixture.jsonl");
  assert.equal(doc.validation.ok, true);
  assert.equal(doc.status.idle, true);
  assert.equal(doc.meta.threadId, "thread-test");
  assert.equal(doc.entries.filter((entry) => entry.editable).length, 3);
  assert.equal(doc.entries.find((entry) => entry.kind === "tool-output").paired, true);
  assert.equal(doc.usage.model_context_window, 128000);
});

test("detects an active turn", () => {
  const doc = parseJsonl(Buffer.from(fixture({ complete: false })), "fixture.jsonl");
  assert.equal(doc.status.idle, false);
  assert.equal(doc.status.activeTurnId, "turn-1");
});

test("edits canonical messages and synchronizes nearby display events", () => {
  const doc = parseJsonl(Buffer.from(fixture()), "fixture.jsonl");
  const user = doc.entries.find((entry) => entry.role === "user" && entry.editable);
  const tool = doc.entries.find((entry) => entry.kind === "tool-output");
  applyPatches(doc, [
    { id: user.id, text: "Fix auth" },
    { id: tool.id, text: "[Output compacted]" },
  ]);
  const output = serializeDocument(doc);
  assert.match(output, /Fix auth/);
  assert.doesNotMatch(output, /Fix the login bug/);
  assert.match(output, /\[Output compacted\]/);
  assert.equal(parseJsonl(Buffer.from(output)).validation.ok, true);
});

test("deletes an editable completed message together with its mirrored display event", () => {
  const doc = parseJsonl(Buffer.from(fixture()), "fixture.jsonl");
  const user = doc.entries.find((entry) => entry.role === "user" && entry.editable);
  assert.equal(user.deletable, true);
  assert.equal(user.deleteLineIndices.length, 2);
  applyDeletions(doc, [user.id]);
  const output = serializeDocument(doc);
  assert.doesNotMatch(output, /Fix the login bug/);
  assert.match(output, /Done/);
  assert.equal(doc.validation.ok, true);
});

test("uses the same UTF-8 byte approximation as Codex core", () => {
  assert.equal(approxTokens("1234"), 1);
  assert.equal(approxTokens("你好"), 2);
});

test("counts structured tool images using Codex visual token cost instead of base64 text", () => {
  const imageOutput = [{ type: "input_image", image_url: `data:image/jpeg;base64,${"A".repeat(30000)}` }];
  assert.equal(toolOutputTokens(imageOutput), 1844);
  assert.ok(toolOutputTokens(JSON.stringify(imageOutput)) > 7000);
});

test("token context uses the latest compaction base and model-visible suffix", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-studio-context-"));
  const filePath = path.join(dir, "rollout.jsonl");
  const replacementHistory = [
    { type: "message", role: "system", content: [{ type: "input_text", text: "retained system" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "compact summary" }] },
  ];
  const records = [
    line("session_meta", { id: "thread-context", history_mode: "legacy" }),
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "old history" }] }),
    line("compacted", { message: "", replacement_history: replacementHistory }),
    line("response_item", { type: "message", role: "system", content: [{ type: "input_text", text: "ignored suffix system" }] }),
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "new history" }] }),
    line("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 321, output_tokens: 4 }, model_context_window: 1000 } }),
    line("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 0, output_tokens: 0 }, model_context_window: 1000 } }),
  ];
  fs.writeFileSync(filePath, `${records.join("\n")}\n`);
  const summary = readRollout(filePath).summary;
  const expected = approxTokens("retained system") + approxTokens("compact summary") + approxTokens("new history");
  assert.equal(summary.contextStats.activeVisibleTokens, expected);
  assert.equal(summary.usage.reference_input_usage.input_tokens, 321);
  assert.equal(summary.entries.find((entry) => entry.text === "old history").inActiveContext, false);
  assert.equal(summary.entries.find((entry) => entry.text === "ignored suffix system").inActiveContext, false);
  assert.equal(summary.entries.find((entry) => entry.text === "new history").inActiveContext, true);
  assert.equal(summary.contextStats.prefixSegments.length, 3);
  assert.equal(summary.contextStats.prefixSegments.reduce((sum, segment) => sum + segment.tokens, 0), expected);
  assert.ok(summary.contextStats.prefixSegments.at(-1).editId);
  assert.equal(summary.entries.find((entry) => entry.text === "compact summary").contextScope, "compact");
  assert.equal(summary.entries.find((entry) => entry.text === "new history").contextScope, "post-compact");
  assert.equal(summary.entries.find((entry) => entry.text === "old history").contextScope, "pre-compact");
});

test("shows a legacy compacted message as a standalone full summary", () => {
  const records = [
    line("session_meta", { id: "thread-legacy-compact", history_mode: "legacy" }),
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "old source" }] }),
    line("compacted", { message: "legacy compact summary in full" }),
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "new suffix" }] }),
  ];
  const doc = parseJsonl(Buffer.from(`${records.join("\n")}\n`));
  const compact = doc.entries.find((entry) => entry.kind === "compaction-summary");
  assert.equal(compact.text, "legacy compact summary in full");
  assert.equal(compact.contextScope, "compact");
  assert.equal(compact.inActiveContext, true);
  assert.equal(compact.editable, false);
});

test("edits and deletes items inside the latest compacted replacement history", () => {
  const records = [
    line("session_meta", { id: "thread-replacement", history_mode: "legacy" }),
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "archived original" }] }),
    line("compacted", { message: "", replacement_history: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "active compacted user" }] },
      { type: "message", role: "user", content: [
        { type: "input_text", text: "message with image" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ] },
      { type: "function_call", name: "mcp__demo__read", call_id: "compact-call", arguments: "{}" },
      { type: "function_call_output", call_id: "compact-call", output: "compacted output" },
      { type: "reasoning", summary: [{ type: "summary_text", text: "compacted reasoning" }], encrypted_content: "encrypted" },
      { type: "compaction", encrypted_content: "compact-encrypted" },
    ] }),
  ];
  const doc = parseJsonl(Buffer.from(`${records.join("\n")}\n`));
  const archived = doc.entries.find((entry) => entry.text === "archived original");
  const activeUser = doc.entries.find((entry) => entry.text === "active compacted user");
  assert.equal(archived.archived, true);
  assert.equal(activeUser.container, "replacement_history");
  assert.equal(activeUser.editable, true);
  applyPatches(doc, [{ id: activeUser.id, text: "short compacted user" }]);
  const reasoning = doc.entries.find((entry) => entry.container === "replacement_history" && entry.kind === "reasoning");
  const tool = doc.entries.find((entry) => entry.container === "replacement_history" && entry.kind === "mcp-call");
  const compactState = doc.entries.find((entry) => entry.container === "replacement_history" && entry.kind === "compaction-state");
  const imagePart = doc.entries.find((entry) => entry.container === "replacement_history" && entry.kind === "message-part");
  assert.equal(imagePart.contextScope, "compact");
  assert.equal(imagePart.role, "image");
  assert.match(imagePart.text, /data:image\/png;base64,AAAA/);
  assert.equal(imagePart.tokens, 1844);
  assert.equal(imagePart.editable, false);
  assert.equal(compactState.contextScope, "compact");
  assert.equal(compactState.editable, false);
  assert.equal(compactState.deletable, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-studio-prefix-segments-"));
  const filePath = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(filePath, `${records.join("\n")}\n`);
  const toolSegments = readRollout(filePath).summary.contextStats.prefixSegments.filter((segment) => segment.deleteId === tool.id);
  assert.equal(toolSegments.length, 2);
  assert.equal(toolSegments[0].editId, null);
  assert.equal(toolSegments[1].editId, tool.id);
  applyDeletions(doc, [reasoning.id, tool.id]);
  const output = serializeDocument(doc);
  assert.match(output, /short compacted user/);
  assert.match(output, /archived original/);
  assert.doesNotMatch(output, /compacted reasoning|compact-call|compacted output/);
  assert.equal(doc.validation.ok, true);
});

test("compacted message edits and deletions synchronize the Desktop-visible original", () => {
  const turnId = "00000000-0000-7000-8000-000000000123";
  const message = "remove me everywhere";
  const compactedItem = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: message }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  };
  const records = [
    line("session_meta", { id: "thread-display-sync", history_mode: "legacy" }),
    line("event_msg", { type: "task_started", turn_id: turnId }),
    line("turn_context", { turn_id: turnId }),
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: message }] }),
    line("event_msg", { type: "user_message", message, turn_id: turnId }),
    line("event_msg", { type: "task_complete", turn_id: turnId }),
    line("compacted", { message: "", replacement_history: [compactedItem] }),
  ];

  const edited = parseJsonl(Buffer.from(`${records.join("\n")}\n`));
  const editable = edited.entries.find((entry) => entry.container === "replacement_history");
  assert.equal(editable.desktopDisplaySync, "matched");
  applyPatches(edited, [{ id: editable.id, text: "edited everywhere" }]);
  const editedOutput = serializeDocument(edited);
  assert.equal((editedOutput.match(/edited everywhere/g) ?? []).length, 3);
  assert.doesNotMatch(editedOutput, /remove me everywhere/);

  const deleted = parseJsonl(Buffer.from(`${records.join("\n")}\n`));
  const deletable = deleted.entries.find((entry) => entry.container === "replacement_history");
  applyDeletions(deleted, [deletable.id]);
  const deletedOutput = serializeDocument(deleted);
  assert.doesNotMatch(deletedOutput, /remove me everywhere/);
  assert.equal(deleted.records.find((record) => record.value?.type === "compacted").value.payload.replacement_history.length, 0);
  assert.equal(deleted.validation.ok, true);
});

test("replacement uses atomic rename and never falls back to in-place overwrite", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-studio-replace-"));
  const targetPath = path.join(dir, "rollout.jsonl");
  const tempPath = `${targetPath}.tmp`;
  const original = Buffer.from("original\n");
  const replacement = Buffer.from("replacement\n");
  fs.writeFileSync(targetPath, original);
  fs.writeFileSync(tempPath, replacement);
  const result = replaceFileVerified({
    tempPath,
    targetPath,
    expectedTargetHash: sha256(original),
    replacementHash: sha256(replacement),
  });
  assert.equal(result.mode, "atomic-rename");
  assert.equal(fs.readFileSync(targetPath, "utf8"), "replacement\n");
  assert.equal(fs.existsSync(tempPath), false);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".recovery.")), false);
});

test("serialization preserves untouched JSONL bytes exactly", () => {
  const unusual = '{"timestamp":"2026-01-01T00:00:00Z", "type":"event_msg", "payload":{"type":"token_count","ratio":3.0}}';
  const source = `${fixture()}${unusual}\n`;
  const doc = parseJsonl(Buffer.from(source));
  const assistant = doc.entries.find((entry) => entry.role === "assistant" && entry.editable);
  applyPatches(doc, [{ id: assistant.id, text: "Updated" }]);
  const output = serializeDocument(doc);
  assert.equal(output.split("\n").at(-2), unusual);
  assert.match(output, /Updated/);
});

test("safe save creates a backup and rejects stale hashes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-studio-"));
  const filePath = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(filePath, fixture());
  const opened = readRollout(filePath);
  const assistant = opened.document.entries.find((entry) => entry.role === "assistant");
  const result = safeSave({ filePath, expectedHash: opened.hash, patches: [{ id: assistant.id, text: "Finished" }], quietPeriodMs: 0 });
  assert.equal(fs.existsSync(result.backupPath), true);
  assert.match(fs.readFileSync(filePath, "utf8"), /Finished/);
  assert.throws(
    () => safeSave({ filePath, expectedHash: opened.hash, patches: [], quietPeriodMs: 0 }),
    (error) => error.code === "RACE_DETECTED",
  );
});

test("safe save refuses an active rollout", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-studio-active-"));
  const filePath = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(filePath, fixture({ complete: false }));
  const opened = readRollout(filePath);
  assert.throws(
    () => safeSave({ filePath, expectedHash: opened.hash, patches: [], quietPeriodMs: 0 }),
    (error) => error.code === "THREAD_ACTIVE",
  );
});

test("backend rechecks activity immediately before replacement", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-studio-race-active-"));
  const filePath = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(filePath, fixture());
  const opened = readRollout(filePath);
  assert.throws(
    () => safeSave({
      filePath, expectedHash: opened.hash, patches: [], quietPeriodMs: 0,
      beforeCommit: () => fs.appendFileSync(filePath, line("event_msg", { type: "task_started", turn_id: "turn-race" }) + "\n"),
    }),
    (error) => error.code === "THREAD_BECAME_ACTIVE",
  );
  assert.match(fs.readFileSync(filePath, "utf8"), /turn-race/);
});

test("deletes completed reasoning, skill fragments, and complete MCP transactions only", () => {
  const records = [
    line("session_meta", { id: "thread-delete", session_id: "thread-delete", history_mode: "legacy" }),
    line("event_msg", { type: "task_started", turn_id: "turn-delete" }),
    line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "Protected system instructions" }] }),
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<skill>\n<name>demo</name>\nbody\n</skill>" }] }),
    line("response_item", { type: "reasoning", summary: [{ type: "summary_text", text: "reasoned" }], encrypted_content: "encrypted" }),
    line("response_item", { type: "function_call", name: "mcp__docs__search", call_id: "mcp-1", arguments: "{}" }),
    line("response_item", { type: "function_call_output", call_id: "mcp-1", output: "result" }),
    line("event_msg", { type: "task_complete", turn_id: "turn-delete" }),
  ];
  const doc = parseJsonl(Buffer.from(`${records.join("\n")}\n`));
  const developer = doc.entries.find((entry) => entry.role === "developer");
  const deletable = doc.entries.filter((entry) => entry.deletable);
  assert.equal(developer.deletable, false);
  assert.deepEqual(new Set(deletable.map((entry) => entry.kind)), new Set(["skill", "reasoning", "mcp-call"]));
  applyDeletions(doc, deletable.map((entry) => entry.id));
  const output = serializeDocument(doc);
  assert.match(output, /Protected system instructions/);
  assert.doesNotMatch(output, /mcp__docs__search|encrypted|<skill>/);
  assert.equal(doc.validation.ok, true);
});

test("does not allow generated items from an incomplete turn to be deleted", () => {
  const records = [
    line("session_meta", { id: "thread-active-delete", history_mode: "legacy" }),
    line("event_msg", { type: "task_started", turn_id: "turn-active" }),
    line("response_item", { type: "reasoning", summary: [], encrypted_content: "encrypted" }),
  ];
  const doc = parseJsonl(Buffer.from(`${records.join("\n")}\n`));
  const reasoning = doc.entries.find((entry) => entry.kind === "reasoning");
  assert.equal(reasoning.deletable, false);
  assert.throws(() => applyDeletions(doc, [reasoning.id]), /cannot be deleted/);
});

test("creates the original backup once, then manual versions, and restores a selected version", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-studio-backups-"));
  const backupDir = path.join(dir, "backups");
  process.env.CONTEXT_STUDIO_BACKUP_DIR = backupDir;
  const filePath = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(filePath, fixture());
  const opened = readRollout(filePath);
  const original1 = ensureOriginalBackup({ sourcePath: filePath, buffer: opened.buffer, sourceHash: opened.hash, threadId: opened.document.meta.threadId });
  const original2 = ensureOriginalBackup({ sourcePath: filePath, buffer: opened.buffer, sourceHash: opened.hash, threadId: opened.document.meta.threadId });
  assert.equal(original1.created, true);
  assert.equal(original2.created, false);
  fs.writeFileSync(filePath, fixture().replace("Done", "Changed"));
  const changed = readRollout(filePath);
  createManualBackup({ sourcePath: filePath, buffer: changed.buffer, sourceHash: changed.hash, threadId: changed.document.meta.threadId });
  assert.equal(listBackups(opened.document.meta.threadId).length, 2);
  const restored = restoreBackup({ filePath, expectedHash: changed.hash, threadId: changed.document.meta.threadId, backupId: original1.id });
  assert.match(fs.readFileSync(filePath, "utf8"), /Done/);
  assert.equal(restored.restored.kind, "original");
  delete process.env.CONTEXT_STUDIO_BACKUP_DIR;
});

test("rejects a backup whose bytes no longer match its metadata", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-studio-backup-integrity-"));
  process.env.CONTEXT_STUDIO_BACKUP_DIR = path.join(dir, "backups");
  try {
    const filePath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(filePath, fixture());
    const opened = readRollout(filePath);
    const backup = createManualBackup({ sourcePath: filePath, buffer: opened.buffer, sourceHash: opened.hash, threadId: opened.document.meta.threadId });
    fs.appendFileSync(backup.dataPath, "tampered\n");
    assert.throws(
      () => restoreBackup({ filePath, expectedHash: opened.hash, threadId: opened.document.meta.threadId, backupId: backup.id }),
      (error) => error.code === "INVALID_BACKUP",
    );
  } finally {
    delete process.env.CONTEXT_STUDIO_BACKUP_DIR;
  }
});

test("staged edits commit only while archived and verify after unarchive", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-studio-staged-"));
  const previousHome = process.env.CODEX_HOME;
  const previousData = process.env.PLUGIN_DATA;
  const previousBackups = process.env.CONTEXT_STUDIO_BACKUP_DIR;
  process.env.CODEX_HOME = dir;
  process.env.PLUGIN_DATA = path.join(dir, "plugin-data");
  process.env.CONTEXT_STUDIO_BACKUP_DIR = path.join(dir, "backups");
  try {
    const threadId = "00000000-0000-7000-8000-000000000001";
    const sessionsDir = path.join(dir, "sessions", "2026", "07", "12");
    const archivedDir = path.join(dir, "archived_sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(archivedDir, { recursive: true });
    const sessionsPath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);
    fs.writeFileSync(sessionsPath, fixture().replaceAll("thread-test", threadId));
    const opened = readRollout(sessionsPath);
    const assistant = opened.document.entries.find((entry) => entry.role === "assistant" && entry.editable);
    const { stage } = stageContextAction({
      action: "save",
      filePath: sessionsPath,
      expectedHash: opened.hash,
      patches: [{ id: assistant.id, text: "Hot reloaded" }],
      deletions: [],
    });
    const prompt = hotReloadPrompt(stage);
    assert.match(prompt, /navigate_to_codex_page/);
    assert.match(prompt, new RegExp(threadId));
    assert.throws(() => commitStagedAction(stage.requestId), (error) => error.code === "THREAD_NOT_ARCHIVED");
    const archivedPath = path.join(archivedDir, path.basename(sessionsPath));
    fs.renameSync(sessionsPath, archivedPath);
    const committed = commitStagedAction(stage.requestId);
    assert.equal(committed.status, "committed");
    assert.match(fs.readFileSync(archivedPath, "utf8"), /Hot reloaded/);
    fs.renameSync(archivedPath, sessionsPath);
    const complete = verifyStagedAction(stage.requestId);
    assert.equal(complete.status, "complete");
    assert.equal(readRollout(sessionsPath).hash, committed.committedHash);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previousData === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previousData;
    if (previousBackups === undefined) delete process.env.CONTEXT_STUDIO_BACKUP_DIR; else process.env.CONTEXT_STUDIO_BACKUP_DIR = previousBackups;
  }
});

test("discovery cache refreshes lifecycle state when a rollout grows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-studio-discovery-"));
  const filePath = path.join(dir, "rollout-live.jsonl");
  fs.writeFileSync(filePath, fixture({ complete: false }));
  assert.equal(discoverRollouts({ root: dir, limit: 5 })[0].status.idle, false);
  fs.appendFileSync(filePath, line("event_msg", { type: "task_complete", turn_id: "turn-1" }) + "\n");
  assert.equal(discoverRollouts({ root: dir, limit: 5 })[0].status.idle, true);
});
