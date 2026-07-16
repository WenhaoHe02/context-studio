import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { replaceFileVerified } from "./safe-replace.mjs";

const EDITABLE_ROLES = new Set(["user", "assistant"]);
const TOOL_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);
const CALL_TYPES = new Set(["function_call", "custom_tool_call", "local_shell_call"]);

export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function approxTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ""), "utf8") / 4);
}

const DEFAULT_IMAGE_TOKENS = 1844;

function structuredContentTokens(value) {
  if (Array.isArray(value)) {
    return value.reduce((result, item) => {
      const child = structuredContentTokens(item);
      return { tokens: result.tokens + child.tokens, images: result.images + child.images };
    }, { tokens: 0, images: 0 });
  }
  if (!value || typeof value !== "object") return { tokens: 0, images: 0 };
  if (value.type === "input_image" || value.type === "image_url") {
    return { tokens: DEFAULT_IMAGE_TOKENS, images: 1 };
  }
  let tokens = 0; let images = 0;
  if (["input_text", "output_text", "text"].includes(value.type) && typeof value.text === "string") {
    tokens += approxTokens(value.text);
  }
  for (const key of ["content", "content_items", "items"]) {
    if (!(key in value)) continue;
    const child = structuredContentTokens(value[key]);
    tokens += child.tokens; images += child.images;
  }
  return { tokens, images };
}

export function toolOutputTokens(output) {
  if (typeof output === "string") return approxTokens(output);
  const estimate = structuredContentTokens(output);
  return estimate.images ? estimate.tokens : approxTokens(typeof output === "string" ? output : JSON.stringify(output ?? ""));
}

export function parseJsonl(buffer, filePath = "") {
  const source = buffer.toString("utf8");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = /\r?\n$/.test(source);
  const rawLines = source.split(/\r?\n/);
  if (hadTrailingNewline) rawLines.pop();

  const records = [];
  const errors = [];
  rawLines.forEach((raw, index) => {
    if (!raw.trim()) {
      records.push({ index, raw, value: null, blank: true, dirty: false });
      return;
    }
    try {
      records.push({ index, raw, value: JSON.parse(raw), blank: false, dirty: false });
    } catch (error) {
      errors.push({ line: index + 1, message: error.message });
      records.push({ index, raw, value: null, blank: false, parseError: true, dirty: false });
    }
  });

  const document = { filePath, newline, hadTrailingNewline, records, errors };
  document.entries = buildEntries(document);
  document.status = deriveStatus(document);
  document.meta = deriveMeta(document);
  document.usage = deriveUsage(document);
  document.validation = validateDocument(document);
  return document;
}

function payloadOf(record) {
  return record?.value?.payload ?? record?.value?.item ?? null;
}

function textParts(payload) {
  if (!Array.isArray(payload?.content)) return [];
  return payload.content
    .map((part, contentIndex) => ({ part, contentIndex }))
    .filter(({ part }) => part && typeof part.text === "string" && ["input_text", "output_text"].includes(part.type));
}

function nonTextParts(payload) {
  if (!Array.isArray(payload?.content)) return [];
  return payload.content
    .map((part, contentIndex) => ({ part, contentIndex }))
    .filter(({ part }) => part && !(typeof part.text === "string" && ["input_text", "output_text"].includes(part.type)));
}

function structuredMessagePartEntry({ id, lineIndex, historyIndex = null, sortIndex, item, part, contentIndex, contextScope, archived, sourceLabel }) {
  const text = JSON.stringify(part, null, 2);
  return {
    id,
    lineIndex,
    historyIndex,
    container: historyIndex == null ? undefined : "replacement_history",
    sortIndex,
    kind: "message-part",
    role: part.type === "input_image" ? "image" : item.role ?? "content",
    phase: item.phase ?? null,
    turnId: item.internal_chat_message_metadata_passthrough?.turn_id ?? null,
    text,
    originalText: text,
    tokens: toolOutputTokens(part),
    editable: false,
    deletable: false,
    deleteLineIndices: [],
    deleteHistoryIndices: [],
    lockedReason: "Structured message content is preserved exactly and shown read-only",
    inActiveContext: contextScope !== "pre-compact" && contextScope !== "excluded",
    contextScope,
    archived,
    sourceLabel,
    contentPartIndex: contentIndex,
    contentPartType: part.type ?? "unknown",
  };
}

function stableEntryId(lineIndex, kind, callId = "") {
  return `${lineIndex}:${kind}:${callId}`;
}

function replacementEntryId(lineIndex, historyIndex, kind, callId = "") {
  return `${lineIndex}:replacement:${historyIndex}:${kind}:${callId}`;
}

function isSkillFragment(text) {
  const trimmed = String(text ?? "").trim();
  return trimmed.startsWith("<skill>") && trimmed.endsWith("</skill>");
}

function activeHistoryBaseIndex(document) {
  return document.records.reduce((last, record) => record.value?.type === "compacted" ? record.index : last, -1);
}

function turnCompletionMap(document) {
  const completed = new Map();
  for (const record of document.records) {
    const payload = payloadOf(record);
    if (record.value?.type !== "event_msg" || !payload?.turn_id) continue;
    if (payload.type === "task_started") completed.set(payload.turn_id, false);
    if (["task_complete", "turn_aborted"].includes(payload.type)) completed.set(payload.turn_id, true);
  }
  return completed;
}

function buildEntries(document) {
  const entries = [];
  const calls = new Map();
  const completedTurns = turnCompletionMap(document);
  const lastCompactedIndex = activeHistoryBaseIndex(document);
  let currentTurnId = null;

  for (const record of document.records) {
    const value = record.value;
    const payload = payloadOf(record);
    if (!value || !payload) continue;

    if (value.type === "event_msg" && payload.type === "task_started") {
      currentTurnId = payload.turn_id ?? null;
    }
    if (value.type === "turn_context" && payload.turn_id) {
      currentTurnId = payload.turn_id;
    }

    if (value.type === "response_item" && payload.type === "message") {
      const parts = textParts(payload);
      const structuredParts = nonTextParts(payload);
      const afterCompaction = record.index > lastCompactedIndex;
      const inActiveContext = afterCompaction && payload.role !== "system";
      const contextScope = inActiveContext ? "post-compact" : afterCompaction ? "excluded" : "pre-compact";
      const sourceLabel = afterCompaction ? "compact 后新增" : "compact 前原始";
      if (parts.length) {
        const text = parts.map(({ part }) => part.text).join("\n\n");
        const skillOnly = parts.every(({ part }) => isSkillFragment(part.text));
        const turnComplete = !currentTurnId || completedTurns.get(currentTurnId) === true;
        const editable = EDITABLE_ROLES.has(payload.role) && !skillOnly;
        const messageDeleteLines = editable && afterCompaction && turnComplete
          ? matchingDisplayEventLineIndices(document, record.index, payload.role, text)
          : [];
        entries.push({
          id: stableEntryId(record.index, skillOnly ? "skill" : "message"),
          lineIndex: record.index,
          kind: skillOnly ? "skill" : "message",
          role: payload.role ?? "unknown",
          phase: payload.phase ?? null,
          turnId: currentTurnId,
          text,
          originalText: text,
          tokens: approxTokens(text),
          inActiveContext,
          contextScope,
          editable,
          deletable: (skillOnly || editable) && afterCompaction && turnComplete,
          deleteLineIndices: skillOnly ? [record.index] : editable && afterCompaction && turnComplete ? [record.index, ...messageDeleteLines] : [],
          lockedReason: editable
            ? null
            : skillOnly
              ? !afterCompaction ? "Skill fragments before the last compaction are retained" : !turnComplete ? "Skill fragment belongs to an incomplete turn" : "Selected skill context can only be removed as a whole"
              : "Developer and system context is permanently protected",
          contentPartCount: payload.content.length,
          archived: !afterCompaction,
          sourceLabel,
          sortIndex: record.index * 100000,
        });
      }
      for (const { part, contentIndex } of structuredParts) {
        entries.push(structuredMessagePartEntry({
          id: stableEntryId(record.index, `message-part-${contentIndex}`),
          lineIndex: record.index,
          sortIndex: record.index * 100000 + contentIndex + 1,
          item: payload,
          part,
          contentIndex,
          contextScope,
          archived: !afterCompaction,
          sourceLabel,
        }));
      }
    }

    if (value.type === "response_item" && payload.type === "reasoning") {
      const summary = Array.isArray(payload.summary)
        ? payload.summary.map((item) => item?.text ?? item?.summary ?? "").filter(Boolean).join("\n")
        : "";
      const encryptedBytes = typeof payload.encrypted_content === "string" ? Buffer.byteLength(payload.encrypted_content, "utf8") : 0;
      const text = summary || (encryptedBytes ? `[Encrypted reasoning state · ${encryptedBytes.toLocaleString()} bytes]` : "[Reasoning state]");
      const afterCompaction = record.index > lastCompactedIndex;
      const turnComplete = !currentTurnId || completedTurns.get(currentTurnId) === true;
      entries.push({
        id: stableEntryId(record.index, "reasoning"), lineIndex: record.index, kind: "reasoning",
        role: "reasoning", phase: null, turnId: currentTurnId, text, originalText: text,
        tokens: approxTokens(summary) + Math.ceil(encryptedBytes / 4), editable: false,
        inActiveContext: afterCompaction,
        contextScope: afterCompaction ? "post-compact" : "pre-compact",
        deletable: afterCompaction && turnComplete, deleteLineIndices: [record.index],
        lockedReason: !afterCompaction ? "Reasoning before the last compaction is retained" : !turnComplete ? "Reasoning belongs to an incomplete turn" : "Encrypted reasoning can only be removed as a whole",
        archived: !afterCompaction, sourceLabel: afterCompaction ? "compact 后新增" : "compact 前原始", sortIndex: record.index * 100000,
      });
    }

    if (value.type === "response_item" && CALL_TYPES.has(payload.type) && payload.call_id) {
      calls.set(payload.call_id, {
        lineIndex: record.index,
        name: payload.name ?? payload.type,
        type: payload.type,
        turnId: currentTurnId,
      });
    }

    if (value.type === "response_item" && TOOL_OUTPUT_TYPES.has(payload.type) && payload.call_id) {
      const output = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? "", null, 2);
      const call = calls.get(payload.call_id);
      const afterCompaction = record.index > lastCompactedIndex && (call?.lineIndex ?? -1) > lastCompactedIndex;
      const turnComplete = !call?.turnId || completedTurns.get(call.turnId) === true;
      const isMcp = call?.name?.startsWith("mcp__") ?? false;
      entries.push({
        id: stableEntryId(record.index, isMcp ? "mcp-call" : "tool-output", payload.call_id),
        lineIndex: record.index,
        callLineIndex: call?.lineIndex ?? null,
        kind: isMcp ? "mcp-call" : "tool-output",
        role: "tool",
        phase: null,
        turnId: call?.turnId ?? currentTurnId,
        callId: payload.call_id,
        toolName: call?.name ?? "Unknown tool",
        paired: Boolean(call),
        text: output,
        originalText: output,
        tokens: toolOutputTokens(payload.output),
        structuredOutput: typeof payload.output !== "string",
        inActiveContext: afterCompaction,
        contextScope: afterCompaction ? "post-compact" : "pre-compact",
        editable: typeof payload.output === "string" && Boolean(call),
        deletable: Boolean(call) && afterCompaction && turnComplete,
        deleteLineIndices: call ? [call.lineIndex, record.index] : [],
        lockedReason: !call
          ? "The matching tool call is missing"
          : !afterCompaction
            ? "Tool transactions before the last compaction are retained"
            : !turnComplete
              ? "Tool transaction belongs to an incomplete turn"
          : typeof payload.output !== "string"
            ? "Only string tool outputs are editable in this version"
            : null,
        archived: !afterCompaction, sourceLabel: afterCompaction ? "compact 后新增" : "compact 前原始", sortIndex: record.index * 100000,
      });
    }
  }

  const compactedRecord = lastCompactedIndex >= 0 ? document.records.find((record) => record.index === lastCompactedIndex) : null;
  const replacementHistory = payloadOf(compactedRecord)?.replacement_history;
  if (compactedRecord && Array.isArray(replacementHistory)) {
    entries.push(...buildReplacementHistoryEntries(document, compactedRecord.index, replacementHistory));
  } else if (compactedRecord && typeof payloadOf(compactedRecord)?.message === "string" && payloadOf(compactedRecord).message.length) {
    const text = payloadOf(compactedRecord).message;
    entries.push({
      id: stableEntryId(compactedRecord.index, "compaction-summary"),
      lineIndex: compactedRecord.index,
      kind: "compaction-summary",
      role: "compact",
      phase: null,
      turnId: null,
      text,
      originalText: text,
      tokens: approxTokens(text),
      inActiveContext: true,
      contextScope: "compact",
      editable: false,
      deletable: false,
      deleteLineIndices: [],
      lockedReason: "Legacy compaction summary is the active history base and remains read-only",
      archived: false,
      sourceLabel: "compact 摘要全文",
      sortIndex: compactedRecord.index * 100000,
    });
  }

  return entries.sort((a, b) => (a.sortIndex ?? a.lineIndex) - (b.sortIndex ?? b.lineIndex));
}

function rawItemCandidates(document, beforeLineIndex, turnId, predicate) {
  const candidates = [];
  let currentTurnId = null;
  for (const record of document.records) {
    if (record.index >= beforeLineIndex) break;
    const payload = payloadOf(record);
    if (record.value?.type === "event_msg" && payload?.type === "task_started") currentTurnId = payload.turn_id ?? null;
    if (record.value?.type === "turn_context" && payload?.turn_id) currentTurnId = payload.turn_id;
    if (record.value?.type !== "response_item" || !payload) continue;
    if (turnId && currentTurnId !== turnId) continue;
    if (predicate(payload)) candidates.push(record.index);
  }
  return candidates;
}

function rawMessageCounterpart(document, beforeLineIndex, item, text) {
  const turnId = item.internal_chat_message_metadata_passthrough?.turn_id ?? null;
  const candidates = rawItemCandidates(document, beforeLineIndex, turnId, (payload) => {
    if (payload.type !== "message" || payload.role !== item.role) return false;
    return textParts(payload).map(({ part }) => part.text).join("\n\n") === text;
  });
  if (candidates.length !== 1) return { lineIndex: null, deleteLineIndices: [], matchCount: candidates.length };
  const line = candidates[0];
  return {
    lineIndex: line,
    deleteLineIndices: [line, ...matchingDisplayEventLineIndices(document, line, item.role, text)],
    matchCount: 1,
  };
}

function rawReasoningCounterpart(document, beforeLineIndex, item) {
  const turnId = item.internal_chat_message_metadata_passthrough?.turn_id ?? null;
  const encrypted = typeof item.encrypted_content === "string" ? item.encrypted_content : null;
  const summary = JSON.stringify(item.summary ?? null);
  const candidates = rawItemCandidates(document, beforeLineIndex, turnId, (payload) => payload.type === "reasoning"
    && (encrypted ? payload.encrypted_content === encrypted : JSON.stringify(payload.summary ?? null) === summary));
  return candidates.length === 1
    ? { lineIndex: candidates[0], deleteLineIndices: [candidates[0]], matchCount: 1 }
    : { lineIndex: null, deleteLineIndices: [], matchCount: candidates.length };
}

function rawToolCounterpart(document, beforeLineIndex, item) {
  const turnId = item.internal_chat_message_metadata_passthrough?.turn_id ?? null;
  const calls = rawItemCandidates(document, beforeLineIndex, turnId, (payload) => CALL_TYPES.has(payload.type) && payload.call_id === item.call_id);
  const outputs = rawItemCandidates(document, beforeLineIndex, turnId, (payload) => TOOL_OUTPUT_TYPES.has(payload.type) && payload.call_id === item.call_id);
  if (calls.length !== 1 || outputs.length !== 1) {
    return { outputLineIndex: null, deleteLineIndices: [], matchCount: Math.max(calls.length, outputs.length) };
  }
  const eventLines = document.records
    .filter((record) => record.index < beforeLineIndex && record.value?.type === "event_msg" && payloadOf(record)?.call_id === item.call_id)
    .map((record) => record.index);
  return { outputLineIndex: outputs[0], deleteLineIndices: [calls[0], outputs[0], ...eventLines], matchCount: 1 };
}

function displaySyncState(matchCount) {
  return matchCount === 1 ? "matched" : matchCount > 1 ? "ambiguous" : "not-found";
}

function buildReplacementHistoryEntries(document, lineIndex, history) {
  const entries = [];
  const calls = new Map();
  history.forEach((item, historyIndex) => {
    if (CALL_TYPES.has(item?.type) && item.call_id) {
      calls.set(item.call_id, { historyIndex, name: item.name ?? item.type });
    }
    if (item?.type === "message") {
      const parts = textParts(item);
      if (parts.length) {
        const text = parts.map(({ part }) => part.text).join("\n\n");
        const skillOnly = parts.every(({ part }) => isSkillFragment(part.text));
        const editable = EDITABLE_ROLES.has(item.role) && !skillOnly;
        const raw = rawMessageCounterpart(document, lineIndex, item, text);
        entries.push({
          id: replacementEntryId(lineIndex, historyIndex, skillOnly ? "skill" : "message"),
          lineIndex, historyIndex, container: "replacement_history", sortIndex: lineIndex * 100000 + historyIndex + 1,
          kind: skillOnly ? "skill" : "message", role: item.role ?? "unknown", phase: item.phase ?? null,
          turnId: item.internal_chat_message_metadata_passthrough?.turn_id ?? null,
          text, originalText: text, tokens: approxTokens(text), editable,
          deletable: skillOnly || editable, deleteLineIndices: raw.deleteLineIndices, deleteHistoryIndices: [historyIndex],
          displayLineIndex: raw.lineIndex, desktopDisplaySync: displaySyncState(raw.matchCount),
          lockedReason: editable ? null : skillOnly ? "Compacted skill context can only be removed as a whole" : "Developer and system context is permanently protected",
          contentPartCount: item.content.length, inActiveContext: true,
          contextScope: "compact", archived: false, sourceLabel: "compact 内容",
        });
      }
      for (const { part, contentIndex } of nonTextParts(item)) {
        entries.push(structuredMessagePartEntry({
          id: replacementEntryId(lineIndex, historyIndex, `message-part-${contentIndex}`),
          lineIndex,
          historyIndex,
          sortIndex: lineIndex * 100000 + historyIndex + 1 + (contentIndex + 1) / 1000,
          item,
          part,
          contentIndex,
          contextScope: "compact",
          archived: false,
          sourceLabel: "compact 内容",
        }));
      }
    }
    if (item?.type === "reasoning") {
      const summary = Array.isArray(item.summary) ? item.summary.map((part) => part?.text ?? part?.summary ?? "").filter(Boolean).join("\n") : "";
      const encryptedBytes = typeof item.encrypted_content === "string" ? Math.max(0, Math.floor(Buffer.byteLength(item.encrypted_content, "utf8") * 0.75) - 650) : 0;
      const text = summary || (item.encrypted_content ? "[Compacted encrypted reasoning state]" : "[Reasoning state]");
      const raw = rawReasoningCounterpart(document, lineIndex, item);
      entries.push({
        id: replacementEntryId(lineIndex, historyIndex, "reasoning"), lineIndex, historyIndex,
        container: "replacement_history", sortIndex: lineIndex * 100000 + historyIndex + 1,
        kind: "reasoning", role: "reasoning", phase: null,
        turnId: item.internal_chat_message_metadata_passthrough?.turn_id ?? null,
        text, originalText: text, tokens: approxTokens(summary) + Math.ceil(encryptedBytes / 4),
        editable: false, deletable: true, deleteLineIndices: raw.deleteLineIndices, deleteHistoryIndices: [historyIndex],
        desktopDisplaySync: displaySyncState(raw.matchCount),
        lockedReason: "Compacted encrypted reasoning can only be removed as a whole",
        inActiveContext: true, contextScope: "compact", archived: false, sourceLabel: "compact 内容",
      });
    }
    if (TOOL_OUTPUT_TYPES.has(item?.type) && item.call_id) {
      const call = calls.get(item.call_id);
      const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "", null, 2);
      const isMcp = call?.name?.startsWith("mcp__") ?? false;
      const raw = rawToolCounterpart(document, lineIndex, item);
      entries.push({
        id: replacementEntryId(lineIndex, historyIndex, isMcp ? "mcp-call" : "tool-output", item.call_id),
        lineIndex, historyIndex, callHistoryIndex: call?.historyIndex ?? null,
        container: "replacement_history", sortIndex: lineIndex * 100000 + historyIndex + 1,
        kind: isMcp ? "mcp-call" : "tool-output", role: "tool", phase: null,
        turnId: item.internal_chat_message_metadata_passthrough?.turn_id ?? null,
        callId: item.call_id, toolName: call?.name ?? "Unknown tool", paired: Boolean(call),
        text: output, originalText: output, tokens: toolOutputTokens(item.output),
        editable: typeof item.output === "string" && Boolean(call), deletable: Boolean(call),
        deleteLineIndices: raw.deleteLineIndices, deleteHistoryIndices: call ? [call.historyIndex, historyIndex] : [],
        displayLineIndex: raw.outputLineIndex, desktopDisplaySync: displaySyncState(raw.matchCount),
        structuredOutput: typeof item.output !== "string",
        lockedReason: call ? null : "The matching compacted tool call is missing",
        inActiveContext: true, contextScope: "compact", archived: false, sourceLabel: "compact 内容",
      });
    }
    if (["compaction", "context_compaction"].includes(item?.type)) {
      const encryptedBytes = typeof item.encrypted_content === "string" ? Buffer.byteLength(item.encrypted_content, "utf8") : 0;
      const text = encryptedBytes
        ? `[Compact 内部加密状态 · ${encryptedBytes.toLocaleString()} bytes；无可显示明文]`
        : "[Compact 内部状态；无可显示明文]";
      entries.push({
        id: replacementEntryId(lineIndex, historyIndex, "compaction-state"),
        lineIndex,
        historyIndex,
        container: "replacement_history",
        sortIndex: lineIndex * 100000 + historyIndex + 1,
        kind: "compaction-state",
        role: "compact",
        phase: null,
        turnId: item.internal_chat_message_metadata_passthrough?.turn_id ?? null,
        text,
        originalText: text,
        tokens: responseItemTokens(item),
        editable: false,
        deletable: false,
        deleteLineIndices: [],
        deleteHistoryIndices: [],
        lockedReason: "Internal compacted model state is structural and remains read-only",
        inActiveContext: true,
        contextScope: "compact",
        archived: false,
        sourceLabel: "compact 内容",
      });
    }
  });
  return entries;
}

function deriveStatus(document) {
  let activeTurnId = null;
  let lastLifecycle = null;
  for (const record of document.records) {
    const value = record.value;
    const payload = payloadOf(record);
    if (value?.type !== "event_msg" || !payload) continue;
    if (payload.type === "task_started") {
      activeTurnId = payload.turn_id ?? "unknown";
      lastLifecycle = payload.type;
    } else if (["task_complete", "turn_aborted"].includes(payload.type)) {
      if (!payload.turn_id || payload.turn_id === activeTurnId) activeTurnId = null;
      lastLifecycle = payload.type;
    }
  }
  return { idle: activeTurnId === null, activeTurnId, lastLifecycle };
}

function deriveMeta(document) {
  for (const record of document.records) {
    const payload = payloadOf(record);
    if (record.value?.type === "session_meta" && payload) {
      return {
        threadId: payload.id ?? payload.session_id ?? null,
        cwd: payload.cwd ?? null,
        cliVersion: payload.cli_version ?? null,
        contextWindow: payload.context_window ?? null,
        historyMode: payload.history_mode ?? "legacy",
        modelProvider: payload.model_provider ?? null,
      };
    }
  }
  return {};
}

function deriveUsage(document) {
  let last = null;
  let lastWithInput = null;
  for (const record of document.records) {
    const payload = payloadOf(record);
    if (record.value?.type === "event_msg" && payload?.type === "token_count" && payload.info) {
      last = payload.info;
      if (Number(payload.info.last_token_usage?.input_tokens) > 0) lastWithInput = payload.info.last_token_usage;
    }
  }
  return last ? { ...last, reference_input_usage: lastWithInput } : null;
}

function responseItemTokens(item) {
  if (!item || typeof item !== "object") return 0;
  if (item.type === "message") {
    return (Array.isArray(item.content) ? item.content : [])
      .reduce((sum, part) => {
        if (typeof part?.text === "string") return sum + approxTokens(part.text);
        if (part?.type === "input_image") return sum + 1844;
        return sum;
      }, 0);
  }
  if (item.type === "agent_message") {
    return (Array.isArray(item.content) ? item.content : [])
      .reduce((sum, part) => sum + approxTokens(part?.text ?? ""), 0);
  }
  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary.map((part) => part?.text ?? part?.summary ?? "").join("\n")
      : "";
    const encryptedBytes = typeof item.encrypted_content === "string"
      ? Math.max(0, Math.floor(Buffer.byteLength(item.encrypted_content, "utf8") * 0.75) - 650)
      : 0;
    const encrypted = Math.ceil(encryptedBytes / 4);
    return approxTokens(summary) + encrypted;
  }
  if (CALL_TYPES.has(item.type)) {
    const body = item.arguments ?? item.input ?? item.action ?? "";
    return approxTokens(item.name ?? item.type) + approxTokens(typeof body === "string" ? body : JSON.stringify(body));
  }
  if (TOOL_OUTPUT_TYPES.has(item.type)) {
    const output = item.output ?? "";
    return toolOutputTokens(output);
  }
  if (item.type === "additional_tools") return approxTokens(JSON.stringify(item.tools ?? []));
  if (["tool_search_call", "tool_search_output", "web_search_call", "image_generation_call"].includes(item.type)) {
    return approxTokens(JSON.stringify(item));
  }
  if (["compaction", "context_compaction"].includes(item.type)) {
    return responseItemTokens({ type: "reasoning", summary: [], encrypted_content: item.encrypted_content });
  }
  return 0;
}

function prefixSegmentLabel(item, entry) {
  if (CALL_TYPES.has(item?.type)) return `${item.name || item.type} · call`;
  if (entry?.kind === "message") return `${entry.role || item?.role || "message"} · ${entry.turnId ? `turn ${entry.turnId.slice(0, 8)}` : "message"}`;
  if (entry?.kind === "reasoning") return `reasoning${entry.turnId ? ` · turn ${entry.turnId.slice(0, 8)}` : ""}`;
  if (["tool-output", "mcp-call"].includes(entry?.kind)) return `${entry.toolName || "tool"} · output`;
  return item?.type || "context item";
}

function derivePrefixSegments(document) {
  const entries = document.entries ?? buildEntries(document);
  const byRawLine = new Map(entries
    .filter((entry) => entry.container !== "replacement_history")
    .map((entry) => [entry.lineIndex, entry]));
  const byHistoryIndex = new Map(entries
    .filter((entry) => entry.container === "replacement_history")
    .map((entry) => [entry.historyIndex, entry]));
  const rawCallOwners = new Map(entries
    .filter((entry) => entry.callLineIndex != null)
    .map((entry) => [entry.callLineIndex, entry]));
  const historyCallOwners = new Map(entries
    .filter((entry) => entry.callHistoryIndex != null)
    .map((entry) => [entry.callHistoryIndex, entry]));
  const lastCompactedIndex = activeHistoryBaseIndex(document);
  const segments = [];

  const append = (item, key, entry, callOwner = null) => {
    const isCall = CALL_TYPES.has(item?.type);
    segments.push({
      key,
      tokens: responseItemTokens(item),
      label: prefixSegmentLabel(item, isCall ? callOwner : entry),
      editId: isCall ? null : entry?.editable ? entry.id : null,
      deleteId: (isCall ? callOwner : entry)?.deletable ? (isCall ? callOwner : entry).id : null,
    });
  };

  if (lastCompactedIndex >= 0) {
    const compactedRecord = document.records.find((record) => record.index === lastCompactedIndex);
    const replacementHistory = payloadOf(compactedRecord)?.replacement_history;
    if (Array.isArray(replacementHistory)) {
      replacementHistory.forEach((item, historyIndex) => {
        append(item, `replacement:${lastCompactedIndex}:${historyIndex}`, byHistoryIndex.get(historyIndex), historyCallOwners.get(historyIndex));
      });
    } else {
      const message = payloadOf(compactedRecord)?.message ?? "";
      segments.push({
        key: `compaction:${lastCompactedIndex}`,
        tokens: approxTokens(message),
        label: "compaction summary",
        editId: null,
        deleteId: null,
      });
    }
  }

  for (const record of document.records) {
    if (record.index <= lastCompactedIndex || record.value?.type !== "response_item") continue;
    const item = payloadOf(record);
    if (item?.type === "message" && item.role === "system") continue;
    if (["compaction_trigger", "other"].includes(item?.type)) continue;
    append(item, `line:${record.index}`, byRawLine.get(record.index), rawCallOwners.get(record.index));
  }
  return segments;
}

function deriveContextStats(document) {
  const lastCompactedIndex = activeHistoryBaseIndex(document);
  const compactedRecord = lastCompactedIndex >= 0 ? document.records.find((record) => record.index === lastCompactedIndex) : null;
  const replacementHistory = payloadOf(compactedRecord)?.replacement_history;
  const hasReplacementHistory = Array.isArray(replacementHistory);
  const compactedHistoryTokens = hasReplacementHistory
    ? replacementHistory.reduce((sum, item) => sum + responseItemTokens(item), 0)
    : approxTokens(payloadOf(compactedRecord)?.message ?? "");
  const postCompactionTokens = document.records
    .filter((record) => record.index > lastCompactedIndex && record.value?.type === "response_item")
    .reduce((sum, record) => {
      const item = payloadOf(record);
      if (item?.type === "message" && item.role === "system") return sum;
      if (["compaction_trigger", "other"].includes(item?.type)) return sum;
      return sum + responseItemTokens(item);
    }, 0);
  return {
    hasCompaction: lastCompactedIndex >= 0,
    hasReplacementHistory,
    baseLineIndex: lastCompactedIndex >= 0 ? lastCompactedIndex + 1 : null,
    compactedHistoryTokens,
    activeVisibleTokens: compactedHistoryTokens + postCompactionTokens,
    prefixSegments: derivePrefixSegments(document),
  };
}

export function validateDocument(document) {
  const issues = [...document.errors.map((error) => ({ severity: "error", code: "invalid-json", ...error }))];
  const nonBlank = document.records.filter((record) => !record.blank && record.value);
  const first = nonBlank[0]?.value;
  if (!first || first.type !== "session_meta") {
    issues.push({ severity: "error", code: "missing-session-meta", message: "The first record must be session_meta" });
  }

  const historyMode = payloadOf(nonBlank[0])?.history_mode;
  if (historyMode === "paginated") {
    let expected = 0;
    for (const record of nonBlank) {
      if (!Number.isSafeInteger(record.value.ordinal) || record.value.ordinal !== expected) {
        issues.push({
          severity: "error",
          code: "invalid-ordinal",
          line: record.index + 1,
          message: `Expected ordinal ${expected}`,
        });
        break;
      }
      expected += 1;
    }
  }

  const calls = new Map();
  const outputs = new Map();
  for (const record of nonBlank) {
    const payload = payloadOf(record);
    if (record.value.type !== "response_item" || !payload?.call_id) continue;
    if (CALL_TYPES.has(payload.type)) calls.set(payload.call_id, (calls.get(payload.call_id) ?? 0) + 1);
    if (TOOL_OUTPUT_TYPES.has(payload.type)) outputs.set(payload.call_id, (outputs.get(payload.call_id) ?? 0) + 1);
  }
  for (const [callId, count] of outputs) {
    if (!calls.has(callId)) {
      issues.push({ severity: "error", code: "orphan-tool-output", message: `Tool output ${callId} has no matching call` });
    } else if (count !== 1 || calls.get(callId) !== 1) {
      issues.push({ severity: "error", code: "duplicate-tool-pair", message: `Tool pair ${callId} is not one-to-one` });
    }
  }
  for (const record of nonBlank) {
    if (record.value.type !== "compacted") continue;
    const history = payloadOf(record)?.replacement_history;
    if (!Array.isArray(history)) continue;
    const nestedCalls = new Map(); const nestedOutputs = new Map();
    for (const item of history) {
      if (!item?.call_id) continue;
      if (CALL_TYPES.has(item.type)) nestedCalls.set(item.call_id, (nestedCalls.get(item.call_id) ?? 0) + 1);
      if (TOOL_OUTPUT_TYPES.has(item.type)) nestedOutputs.set(item.call_id, (nestedOutputs.get(item.call_id) ?? 0) + 1);
    }
    for (const [callId, count] of nestedOutputs) {
      if (!nestedCalls.has(callId)) {
        issues.push({ severity: "error", code: "orphan-compacted-tool-output", line: record.index + 1, message: `Compacted tool output ${callId} has no matching call` });
      } else if (count !== 1 || nestedCalls.get(callId) !== 1) {
        issues.push({ severity: "error", code: "duplicate-compacted-tool-pair", line: record.index + 1, message: `Compacted tool pair ${callId} is not one-to-one` });
      }
    }
  }

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    issues,
    recordCount: document.records.length,
    editableEntryCount: document.entries?.filter((entry) => entry.editable).length ?? 0,
  };
}

function distributeText(parts, text) {
  if (parts.length === 1) {
    parts[0].part.text = text;
    return;
  }
  const originalLengths = parts.map(({ part }) => part.text.length);
  const total = originalLengths.reduce((sum, length) => sum + length, 0) || 1;
  let cursor = 0;
  parts.forEach(({ part }, index) => {
    if (index === parts.length - 1) {
      part.text = text.slice(cursor);
      return;
    }
    const size = Math.round((originalLengths[index] / total) * text.length);
    part.text = text.slice(cursor, cursor + size);
    cursor += size;
  });
}

function synchronizeDisplayEvents(document, entry, oldText, newText) {
  const start = Math.max(0, entry.lineIndex - 3);
  const end = Math.min(document.records.length - 1, entry.lineIndex + 3);
  for (let index = start; index <= end; index += 1) {
    const record = document.records[index];
    const payload = payloadOf(record);
    if (record.value?.type !== "event_msg" || !payload) continue;
    if (entry.role === "user" && payload.type === "user_message" && payload.message === oldText) {
      payload.message = newText;
      record.dirty = true;
    }
    if (entry.role === "assistant" && payload.type === "agent_message" && payload.message === oldText) {
      payload.message = newText;
      record.dirty = true;
    }
  }
}

function matchingDisplayEventLineIndices(document, lineIndex, role, text) {
  const matches = [];
  const start = Math.max(0, lineIndex - 3);
  const end = Math.min(document.records.length - 1, lineIndex + 3);
  for (let index = start; index <= end; index += 1) {
    const record = document.records[index];
    const payload = payloadOf(record);
    if (record.value?.type !== "event_msg" || !payload) continue;
    if (role === "user" && payload.type === "user_message" && payload.message === text) matches.push(index);
    if (role === "assistant" && payload.type === "agent_message" && payload.message === text) matches.push(index);
  }
  return matches;
}

export function applyPatches(document, patches) {
  const byId = new Map(document.entries.map((entry) => [entry.id, entry]));
  const applied = [];
  for (const patch of patches) {
    const entry = byId.get(patch.id);
    if (!entry) throw new Error(`Unknown editable entry: ${patch.id}`);
    if (!entry.editable) throw new Error(`Entry is locked: ${patch.id}`);
    if (typeof patch.text !== "string") throw new Error(`Patch text must be a string: ${patch.id}`);
    if (Buffer.byteLength(patch.text, "utf8") > 10 * 1024 * 1024) throw new Error(`Patch is too large: ${patch.id}`);

    const record = document.records.find((item) => item.index === entry.lineIndex);
    const recordPayload = payloadOf(record);
    const payload = entry.container === "replacement_history"
      ? recordPayload?.replacement_history?.[entry.historyIndex]
      : recordPayload;
    record.dirty = true;
    if (entry.kind === "message") {
      const parts = textParts(payload);
      if (!parts.length || !EDITABLE_ROLES.has(payload.role)) throw new Error(`Message structure changed: ${patch.id}`);
      distributeText(parts, patch.text);
      if (entry.container !== "replacement_history") {
        synchronizeDisplayEvents(document, entry, entry.originalText, patch.text);
      } else if (entry.displayLineIndex != null) {
        const displayRecord = document.records.find((item) => item.index === entry.displayLineIndex);
        const displayPayload = payloadOf(displayRecord);
        const displayParts = textParts(displayPayload);
        if (!displayParts.length || displayPayload?.type !== "message" || displayPayload.role !== entry.role) {
          throw new Error(`Desktop message counterpart changed: ${patch.id}`);
        }
        distributeText(displayParts, patch.text);
        displayRecord.dirty = true;
        synchronizeDisplayEvents(document, { ...entry, lineIndex: entry.displayLineIndex }, entry.originalText, patch.text);
      }
    } else if (["tool-output", "mcp-call"].includes(entry.kind)) {
      if (!TOOL_OUTPUT_TYPES.has(payload?.type) || payload.call_id !== entry.callId || typeof payload.output !== "string") {
        throw new Error(`Tool output structure changed: ${patch.id}`);
      }
      payload.output = patch.text;
      if (entry.container === "replacement_history" && entry.displayLineIndex != null) {
        const displayRecord = document.records.find((item) => item.index === entry.displayLineIndex);
        const displayPayload = payloadOf(displayRecord);
        if (!TOOL_OUTPUT_TYPES.has(displayPayload?.type) || displayPayload.call_id !== entry.callId || typeof displayPayload.output !== "string") {
          throw new Error(`Desktop tool counterpart changed: ${patch.id}`);
        }
        displayPayload.output = patch.text;
        displayRecord.dirty = true;
      }
    }
    const afterTokens = ["tool-output", "mcp-call"].includes(entry.kind) ? toolOutputTokens(patch.text) : approxTokens(patch.text);
    applied.push({ id: patch.id, beforeTokens: entry.tokens, afterTokens });
  }

  document.entries = buildEntries(document);
  document.status = deriveStatus(document);
  document.meta = deriveMeta(document);
  document.usage = deriveUsage(document);
  document.validation = validateDocument(document);
  return applied;
}

function renumberOrdinals(document) {
  const first = document.records.find((record) => record.value)?.value;
  if (payloadOf({ value: first })?.history_mode !== "paginated") return;
  let ordinal = 0;
  for (const record of document.records) {
    if (!record.value) continue;
    if (record.value.ordinal !== ordinal) {
      record.value.ordinal = ordinal;
      record.dirty = true;
    }
    ordinal += 1;
  }
}

export function applyDeletions(document, deletionIds) {
  const byId = new Map(document.entries.map((entry) => [entry.id, entry]));
  const lineIndices = new Set();
  const historyIndicesByLine = new Map();
  const deleted = [];
  for (const id of deletionIds) {
    const entry = byId.get(id);
    if (!entry) throw new Error(`Unknown deletable entry: ${id}`);
    const hasRawLines = Boolean(entry.deleteLineIndices?.length);
    const hasHistoryItems = Boolean(entry.deleteHistoryIndices?.length);
    if (!entry.deletable || (!hasRawLines && !hasHistoryItems)) throw new Error(`Entry cannot be deleted: ${id}`);
    entry.deleteLineIndices?.forEach((lineIndex) => lineIndices.add(lineIndex));
    if (hasHistoryItems) {
      const indices = historyIndicesByLine.get(entry.lineIndex) ?? new Set();
      entry.deleteHistoryIndices.forEach((historyIndex) => indices.add(historyIndex));
      historyIndicesByLine.set(entry.lineIndex, indices);
    }
    if (entry.callId) {
      for (const record of document.records) {
        const payload = payloadOf(record);
        if (record.value?.type === "event_msg" && payload?.call_id === entry.callId) lineIndices.add(record.index);
      }
    }
    deleted.push({ id, kind: entry.kind, tokens: entry.tokens });
  }
  for (const [lineIndex, historyIndices] of historyIndicesByLine) {
    const record = document.records.find((item) => item.index === lineIndex);
    const replacementHistory = payloadOf(record)?.replacement_history;
    if (!Array.isArray(replacementHistory)) throw new Error(`Compacted replacement history changed at line ${lineIndex + 1}`);
    payloadOf(record).replacement_history = replacementHistory.filter((_, historyIndex) => !historyIndices.has(historyIndex));
    record.dirty = true;
  }
  document.records = document.records.filter((record) => !lineIndices.has(record.index));
  renumberOrdinals(document);
  document.entries = buildEntries(document);
  document.status = deriveStatus(document);
  document.meta = deriveMeta(document);
  document.usage = deriveUsage(document);
  document.validation = validateDocument(document);
  return deleted;
}

export function serializeDocument(document) {
  const lines = document.records.map((record) => {
    if (record.blank) return "";
    if (!record.value || !record.dirty) return record.raw;
    return JSON.stringify(record.value);
  });
  return lines.join(document.newline) + (document.hadTrailingNewline ? document.newline : "");
}

export function documentSummary(document, stat, hash) {
  const entries = document.entries.map(({ originalText, ...entry }) => entry);
  const editableTokens = entries.filter((entry) => entry.editable).reduce((sum, entry) => sum + entry.tokens, 0);
  const allVisibleTokens = entries.reduce((sum, entry) => sum + entry.tokens, 0);
  return {
    path: document.filePath,
    fileName: path.basename(document.filePath),
    hash,
    size: stat?.size ?? Buffer.byteLength(serializeDocument(document)),
    mtimeMs: stat?.mtimeMs ?? null,
    meta: document.meta,
    status: document.status,
    usage: document.usage,
    contextStats: deriveContextStats(document),
    validation: document.validation,
    tokenStats: { editableTokens, allVisibleTokens },
    entries,
  };
}

export function readRollout(filePath) {
  const resolved = path.resolve(filePath);
  const buffer = fs.readFileSync(resolved);
  const stat = fs.statSync(resolved);
  const hash = sha256(buffer);
  const document = parseJsonl(buffer, resolved);
  return { resolved, buffer, stat, hash, document, summary: documentSummary(document, stat, hash) };
}

export function safeSave({ filePath, expectedHash, patches, deletions = [], quietPeriodMs = 2500, backupWriter = null, beforeCommit = null }) {
  const current = readRollout(filePath);
  if (current.hash !== expectedHash) {
    const error = new Error("The rollout changed after it was opened. Reload before saving.");
    error.code = "RACE_DETECTED";
    throw error;
  }
  if (!current.document.status.idle) {
    const error = new Error(`Turn ${current.document.status.activeTurnId} is still active.`);
    error.code = "THREAD_ACTIVE";
    throw error;
  }
  if (Date.now() - current.stat.mtimeMs < quietPeriodMs) {
    const error = new Error("The rollout was modified too recently. Wait for Codex to become idle.");
    error.code = "NOT_QUIET";
    throw error;
  }
  if (!current.document.validation.ok) {
    const error = new Error("The original rollout does not pass structural validation.");
    error.code = "INVALID_ORIGINAL";
    throw error;
  }

  const applied = applyPatches(current.document, patches);
  const deleted = applyDeletions(current.document, deletions);
  if (!current.document.validation.ok) {
    const error = new Error("The edited rollout does not pass structural validation.");
    error.code = "INVALID_EDIT";
    error.details = current.document.validation.issues;
    throw error;
  }

  const output = Buffer.from(serializeDocument(current.document), "utf8");
  const verified = parseJsonl(output, current.resolved);
  if (!verified.validation.ok || verified.meta.threadId !== current.document.meta.threadId) {
    const error = new Error("Round-trip validation failed; the original file was not changed.");
    error.code = "ROUND_TRIP_FAILED";
    error.details = verified.validation.issues;
    throw error;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = backupWriter
    ? backupWriter({ sourcePath: current.resolved, buffer: current.buffer, reason: "auto-before-save", sourceHash: current.hash, threadId: current.document.meta.threadId })
    : `${current.resolved}.context-studio.${stamp}.bak`;
  const tempPath = `${current.resolved}.context-studio.${process.pid}.${Date.now()}.tmp`;
  if (!backupWriter) fs.copyFileSync(current.resolved, backupPath, fs.constants.COPYFILE_EXCL);
  try {
    fs.writeFileSync(tempPath, output, { flag: "wx" });
    beforeCommit?.();
    const finalSnapshot = readRollout(current.resolved);
    if (!finalSnapshot.document.status.idle) {
      const error = new Error(`Turn ${finalSnapshot.document.status.activeTurnId} became active during save.`);
      error.code = "THREAD_BECAME_ACTIVE";
      throw error;
    }
    if (finalSnapshot.hash !== expectedHash) {
      const error = new Error("The rollout changed during save. The original file was not replaced.");
      error.code = "RACE_DURING_SAVE";
      throw error;
    }
    replaceFileVerified({
      tempPath,
      targetPath: current.resolved,
      expectedTargetHash: expectedHash,
      replacementHash: sha256(output),
    });
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw error;
  }

  const saved = readRollout(current.resolved);
  return { backupPath, applied, deleted, summary: saved.summary };
}
