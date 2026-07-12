import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { codexHome, discoverRollouts } from "./lib/discovery.mjs";
import { approxTokens, readRollout, safeSave } from "./lib/rollout.mjs";
import { createManualBackup, ensureOriginalBackup, listBackups, removeBackupFiles, restoreBackup } from "./lib/backups.mjs";
import { compactUiSummary, findUiEntry } from "./lib/ui-summary.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const host = "127.0.0.1";
const requestedPort = Number(process.env.CONTEXT_STUDIO_PORT || 43117);
const shouldOpen = process.argv.includes("--open");
const allowDirectWrite = process.env.CONTEXT_STUDIO_ALLOW_DIRECT_WRITE === "1";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function json(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function readBody(request, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Request body is too large"), { code: "BODY_TOO_LARGE" }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(Object.assign(new Error("Invalid JSON request body"), { code: "INVALID_BODY", cause: error }));
      }
    });
    request.on("error", reject);
  });
}

function requireDirectWriteOverride() {
  if (allowDirectWrite) return;
  throw Object.assign(new Error(
    "Direct browser writes are disabled because they cannot unload Codex's in-memory task. Use the embedded MCP App hot-reload workflow. If Codex is fully closed, CONTEXT_STUDIO_ALLOW_DIRECT_WRITE=1 enables recovery-mode writes.",
  ), { code: "EMBEDDED_APP_REQUIRED" });
}

function normalizeRolloutPath(candidate) {
  if (typeof candidate !== "string" || !candidate.toLowerCase().endsWith(".jsonl")) {
    throw Object.assign(new Error("Select a .jsonl rollout file"), { code: "INVALID_PATH" });
  }
  const resolved = path.resolve(candidate);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw Object.assign(new Error("The selected path is not a file"), { code: "INVALID_PATH" });
  return resolved;
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/config") {
    return json(response, 200, { codexHome: codexHome(), version: "0.3.0", approxMethod: "UTF-8 bytes / 4", directWriteEnabled: allowDirectWrite });
  }
  if (request.method === "GET" && url.pathname === "/api/rollouts") {
    const rootPath = url.searchParams.get("root") || undefined;
    return json(response, 200, { rollouts: discoverRollouts({ root: rootPath, limit: 250 }) });
  }
  if (request.method === "POST" && url.pathname === "/api/open") {
    const body = await readBody(request);
    const filePath = normalizeRolloutPath(body.path);
    return json(response, 200, compactUiSummary(readRollout(filePath).summary));
  }
  if (request.method === "POST" && url.pathname === "/api/entry") {
    const body = await readBody(request);
    const filePath = normalizeRolloutPath(body.path);
    return json(response, 200, findUiEntry(readRollout(filePath).summary, body.entryId));
  }
  if (request.method === "POST" && url.pathname === "/api/estimate") {
    const body = await readBody(request);
    const entries = Array.isArray(body.entries) ? body.entries : [];
    const editableTokens = entries.reduce((sum, entry) => sum + approxTokens(entry.text ?? ""), 0);
    const externalTokens = Math.max(0, Number(body.externalTokens) || 0);
    const outputReserve = Math.max(0, Number(body.outputReserve) || 0);
    return json(response, 200, { editableTokens, externalTokens, outputReserve, projectedTotal: editableTokens + externalTokens + outputReserve });
  }
  if (request.method === "POST" && url.pathname === "/api/save") {
    requireDirectWriteOverride();
    const body = await readBody(request);
    const filePath = normalizeRolloutPath(body.path);
    if (typeof body.expectedHash !== "string" || !Array.isArray(body.patches)) {
      throw Object.assign(new Error("Missing expectedHash or patches"), { code: "INVALID_BODY" });
    }
    const result = safeSave({
      filePath, expectedHash: body.expectedHash, patches: body.patches,
      deletions: Array.isArray(body.deletions) ? body.deletions : [],
      backupWriter: (args) => ensureOriginalBackup(args).dataPath,
    });
    return json(response, 200, result);
  }
  if (request.method === "GET" && url.pathname === "/api/backups") {
    const filePath = normalizeRolloutPath(url.searchParams.get("path"));
    const current = readRollout(filePath);
    return json(response, 200, { backups: listBackups(current.document.meta.threadId) });
  }
  if (request.method === "POST" && url.pathname === "/api/backups") {
    const body = await readBody(request); const filePath = normalizeRolloutPath(body.path);
    const current = readRollout(filePath);
    if (current.hash !== body.expectedHash) throw Object.assign(new Error("The rollout changed after it was opened."), { code: "RACE_DETECTED" });
    if (!current.document.status.idle) throw Object.assign(new Error(`Turn ${current.document.status.activeTurnId} is active.`), { code: "THREAD_ACTIVE" });
    const backup = createManualBackup({ sourcePath: current.resolved, buffer: current.buffer, sourceHash: current.hash, threadId: current.document.meta.threadId, label: body.label });
    const finalSnapshot = readRollout(filePath);
    if (finalSnapshot.hash !== current.hash || !finalSnapshot.document.status.idle) {
      removeBackupFiles(backup);
      throw Object.assign(new Error("The rollout became active or changed during backup."), { code: !finalSnapshot.document.status.idle ? "THREAD_BECAME_ACTIVE" : "RACE_DURING_SAVE" });
    }
    return json(response, 200, { backup, backups: listBackups(current.document.meta.threadId) });
  }
  if (request.method === "POST" && url.pathname === "/api/restore") {
    requireDirectWriteOverride();
    const body = await readBody(request); const filePath = normalizeRolloutPath(body.path);
    const result = restoreBackup({ filePath, expectedHash: body.expectedHash, threadId: body.threadId, backupId: body.backupId });
    return json(response, 200, result);
  }
  return json(response, 404, { error: { code: "NOT_FOUND", message: "API endpoint not found" } });
}

function serveStatic(response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(publicDir, relative);
  if (!filePath.startsWith(path.resolve(publicDir) + path.sep) && filePath !== path.join(publicDir, "index.html")) {
    return json(response, 403, { error: { code: "FORBIDDEN", message: "Forbidden" } });
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return json(response, 404, { error: { code: "NOT_FOUND", message: "File not found" } });
  }
  response.writeHead(200, {
    "content-type": mime[path.extname(filePath)] || "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${host}`);
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
    else serveStatic(response, url.pathname);
  } catch (error) {
    const status = ["RACE_DETECTED", "RACE_DURING_SAVE", "RACE_DURING_REPLACE", "THREAD_ACTIVE", "THREAD_BECAME_ACTIVE", "NOT_QUIET", "FILE_REPLACE_FAILED"].includes(error.code) ? 409 : 400;
    json(response, status, { error: { code: error.code || "REQUEST_FAILED", message: error.message, details: error.details } });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && requestedPort !== 0) {
    console.error(`Port ${requestedPort} is already in use. Set CONTEXT_STUDIO_PORT=0 for an automatic port.`);
  } else console.error(error);
  process.exitCode = 1;
});

server.listen(requestedPort, host, () => {
  const address = server.address();
  const url = `http://${host}:${address.port}`;
  console.log(`Codex Context Studio is running at ${url}`);
  console.log("Press Ctrl+C to stop.");
  if (shouldOpen) {
    const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    execFile(command, args, { windowsHide: true }, () => {});
  }
});
