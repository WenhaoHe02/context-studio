import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
let DatabaseSync = null;
try { ({ DatabaseSync } = require("node:sqlite")); } catch {}

const fileCache = new Map();
let stateDb = null;

function stateDatabase() {
  if (stateDb) return stateDb;
  if (!DatabaseSync) return null;
  const dbPath = path.join(codexHome(), "state_5.sqlite");
  if (!fs.existsSync(dbPath)) return null;
  try { stateDb = new DatabaseSync(dbPath, { readOnly: true }); }
  catch { stateDb = null; }
  return stateDb;
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function threadMetadata() {
  const db = stateDatabase();
  if (!db) return { byPath: new Map(), byId: new Map(), parentByChild: new Map() };
  try {
    const rows = db.prepare("SELECT id, rollout_path, title, first_user_message, thread_source, source, agent_nickname, agent_path FROM threads").all();
    const edges = db.prepare("SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges").all();
    return {
      byPath: new Map(rows.filter((row) => row.rollout_path).map((row) => [pathKey(row.rollout_path), row])),
      byId: new Map(rows.map((row) => [row.id, row])),
      parentByChild: new Map(edges.map((edge) => [edge.child_thread_id, { parentThreadId: edge.parent_thread_id, edgeStatus: edge.status }])),
    };
  } catch { return { byPath: new Map(), byId: new Map(), parentByChild: new Map() }; }
}

function cleanTitle(value) {
  const raw = String(value || "");
  const delegatedInput = raw.match(/<input>([\s\S]*?)<\/input>/i)?.[1];
  const text = String(delegatedInput || raw).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text ? (text.length > 72 ? `${text.slice(0, 72)}…` : text) : null;
}

function sourceParent(row) {
  if (!row?.source || typeof row.source !== "string" || !row.source.startsWith("{")) return null;
  try { return JSON.parse(row.source)?.subagent?.thread_spawn?.parent_thread_id ?? null; }
  catch { return null; }
}

function childDisplayTitle(row) {
  const nickname = cleanTitle(row?.agent_nickname) || "子代理";
  const agentPath = String(row?.agent_path || "").replace(/^\/root\//, "");
  return agentPath ? `${nickname} · ${agentPath}` : nickname;
}

const SCAN_CHUNK_BYTES = 256 * 1024;
const LIFECYCLE_LINE_OVERLAP = 16 * 1024;

function parseSessionMeta(text) {
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.includes('"session_meta"')) continue;
    try {
      const value = JSON.parse(raw);
      const payload = value.payload ?? value.item;
      if (value.type === "session_meta") return { threadId: payload?.id ?? payload?.session_id ?? null, cwd: payload?.cwd ?? null };
    } catch {}
  }
  return { threadId: null, cwd: null };
}

function lifecycleFromLine(raw) {
  if (!raw.includes('"task_started"') && !raw.includes('"task_complete"') && !raw.includes('"turn_aborted"')) return null;
  try {
    const value = JSON.parse(raw);
    const payload = value.payload ?? value.item;
    if (value.type !== "event_msg") return null;
    if (payload?.type === "task_started") {
      return { idle: false, activeTurnId: payload.turn_id ?? "unknown", lastLifecycle: payload.type };
    }
    if (["task_complete", "turn_aborted"].includes(payload?.type)) {
      return { idle: true, activeTurnId: null, lastLifecycle: payload.type };
    }
  } catch {}
  return null;
}

function readLifecycleSummary(filePath, size) {
  const fd = fs.openSync(filePath, "r");
  try {
    const firstLength = Math.min(size, SCAN_CHUNK_BYTES);
    const first = Buffer.allocUnsafe(firstLength);
    fs.readSync(fd, first, 0, firstLength, 0);
    const meta = parseSessionMeta(first.toString("utf8"));

    let position = size;
    let leadingFragment = "";
    while (position > 0) {
      const start = Math.max(0, position - SCAN_CHUNK_BYTES);
      const length = position - start;
      const chunk = Buffer.allocUnsafe(length);
      fs.readSync(fd, chunk, 0, length, start);
      const lines = `${chunk.toString("utf8")}${leadingFragment}`.split(/\r?\n/);
      // Lifecycle records are short. Cap the cross-chunk fragment so a single
      // multi-megabyte tool/image JSON line cannot cause quadratic copying.
      leadingFragment = start > 0 ? (lines.shift() ?? "").slice(0, LIFECYCLE_LINE_OVERLAP) : "";
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const status = lifecycleFromLine(lines[index]);
        if (status) return { ...meta, status };
      }
      position = start;
    }
    return { ...meta, status: { idle: true, activeTurnId: null, lastLifecycle: null } };
  } finally {
    fs.closeSync(fd);
  }
}

function scanLifecycle(filePath, stat) {
  const cached = fileCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;
  const summary = readLifecycleSummary(filePath, stat.size);
  const result = { size: stat.size, mtimeMs: stat.mtimeMs, ...summary };
  fileCache.set(filePath, result);
  return result;
}

export function codexHome() {
  return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
}

function walkJsonl(root, output, maxFiles) {
  if (!fs.existsSync(root) || output.length >= maxFiles) return;
  const stack = [root];
  while (stack.length && output.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(full);
    }
  }
}

export function discoverRollouts({ root = path.join(codexHome(), "sessions"), limit = 200 } = {}) {
  const files = [];
  const metadata = threadMetadata();
  walkJsonl(path.resolve(root), files, Math.max(limit * 4, limit));
  return files
    .map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        const scan = scanLifecycle(filePath, stat);
        const dbRow = metadata.byPath.get(pathKey(filePath)) ?? metadata.byId.get(scan.threadId);
        const edge = metadata.parentByChild.get(scan.threadId);
        const parentThreadId = edge?.parentThreadId ?? sourceParent(dbRow);
        const isSubagent = Boolean(parentThreadId || dbRow?.agent_nickname || dbRow?.agent_path);
        return {
          path: filePath,
          name: path.basename(filePath),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          threadId: scan.threadId ?? null,
          cwd: scan.cwd ?? null,
          title: isSubagent ? childDisplayTitle(dbRow) : cleanTitle(dbRow?.title) || cleanTitle(dbRow?.first_user_message) || "未命名线程",
          parentThreadId: parentThreadId ?? null,
          isSubagent,
          agentNickname: dbRow?.agent_nickname ?? null,
          agentPath: dbRow?.agent_path ?? null,
          threadSource: dbRow?.thread_source ?? null,
          edgeStatus: edge?.edgeStatus ?? null,
          status: scan.status,
        };
      } catch (error) {
        return { path: filePath, name: path.basename(filePath), error: error.message, mtimeMs: 0, size: 0 };
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
}
