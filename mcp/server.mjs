import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createManualBackup, listBackups } from "../lib/backups.mjs";
import { codexHome, discoverRollouts } from "../lib/discovery.mjs";
import { readRollout } from "../lib/rollout.mjs";
import { prepareSubagentFork } from "../lib/subagent-fork.mjs";
import { compactUiSummary, findUiEntry } from "../lib/ui-summary.mjs";
import {
  commitStagedAction,
  hotReloadPrompt,
  readStagedAction,
  stageContextAction,
  verifyStagedAction,
} from "../lib/staged-actions.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));
const TEMPLATE_URI = `ui://context-studio/editor-${manifest.version}.html`;
const MIME = "text/html;profile=mcp-app";
const JsonRpcError = { METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 };
const browserToken = crypto.randomBytes(24).toString("hex");
const pendingBrowserPrompts = [];
let browserStudioUrl = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message, data = undefined) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function normalizeRolloutPath(candidate) {
  if (typeof candidate !== "string" || !candidate.toLowerCase().endsWith(".jsonl")) {
    throw Object.assign(new Error("Select a rollout JSONL file."), { code: "INVALID_PATH" });
  }
  const resolved = path.resolve(candidate);
  const allowedRoots = [path.join(codexHome(), "sessions"), path.join(codexHome(), "archived_sessions")]
    .map((item) => `${path.resolve(item)}${path.sep}`);
  if (!allowedRoots.some((allowed) => resolved.startsWith(allowed))) {
    throw Object.assign(new Error("The rollout path is outside Codex session storage."), { code: "INVALID_PATH" });
  }
  if (!fs.statSync(resolved).isFile()) {
    throw Object.assign(new Error("The rollout path is not a file."), { code: "INVALID_PATH" });
  }
  return resolved;
}

function publicToolResult(data, text, meta = {}) {
  return {
    content: [{ type: "text", text }],
    structuredContent: data,
    _meta: meta,
  };
}

function appToolResult(data) {
  return {
    content: [],
    // Some Codex MCP App hosts do not expose result _meta to the iframe.
    // These tools are app-only, so the UI payload belongs here as well.
    structuredContent: data,
    _meta: { data },
  };
}

function bridgeScript() {
  return String.raw`
(() => {
  let nextId = 1;
  const pending = new Map();
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0" || message.id === undefined) return;
    const waiter = pending.get(String(message.id));
    if (!waiter) return;
    pending.delete(String(message.id));
    if (message.error) {
      const err = new Error(message.error.message || "MCP request failed");
      err.code = message.error.data?.code || "MCP_ERROR";
      err.details = message.error.data?.details;
      waiter.reject(err);
    } else waiter.resolve(message.result);
  }, { passive: true });

  function rpc(method, params) {
    const id = String(nextId++);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        const err = new Error("MCP App request timed out");
        err.code = "MCP_APP_TIMEOUT";
        reject(err);
      }, 30000);
    });
  }

  async function callTool(name, args) {
    if (window.openai?.callTool) return window.openai.callTool(name, args);
    return rpc("tools/call", { name, arguments: args });
  }

  async function followUp(prompt) {
    if (window.openai?.sendFollowUpMessage) {
      return window.openai.sendFollowUpMessage({ prompt, scrollToBottom: true });
    }
    window.parent.postMessage({
      jsonrpc: "2.0",
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: prompt }] },
    }, "*");
  }

  function bodyOf(options) {
    try { return options?.body ? JSON.parse(options.body) : {}; }
    catch { return {}; }
  }

  window.__CONTEXT_STUDIO_MCP_CALL__ = async (apiPath, options = {}) => {
    const url = new URL(apiPath, "https://context-studio.local");
    const body = bodyOf(options);
    let tool = "context_studio_read";
    let args;
    if (url.pathname === "/api/rollouts") args = { action: "rollouts" };
    else if (url.pathname === "/api/open") args = { action: "open", path: body.path };
    else if (url.pathname === "/api/backups" && (options.method || "GET") === "GET") {
      args = { action: "backups", path: url.searchParams.get("path") };
    } else if (url.pathname === "/api/backups") {
      tool = "context_studio_stage";
      args = { action: "backup", payload: body };
    } else if (url.pathname === "/api/save") {
      tool = "context_studio_stage";
      args = { action: "save", payload: body };
    } else if (url.pathname === "/api/restore") {
      tool = "context_studio_stage";
      args = { action: "restore", payload: body };
    } else if (url.pathname === "/api/subagent-fork") {
      tool = "context_studio_subagent_fork";
      args = body;
    } else if (url.pathname === "/api/entry") {
      args = { action: "entry", path: body.path, entryId: body.entryId };
    } else throw Object.assign(new Error("Unsupported Context Studio action"), { code: "UNSUPPORTED_ACTION" });
    const response = await callTool(tool, args);
    const data = response?._meta?.data || response?.structuredContent?.data || response?.structuredContent;
    if (data?.hostActionPrompt || data?.hotReloadPrompt) await followUp(data.hostActionPrompt || data.hotReloadPrompt);
    return data;
  };

  async function requestFullscreen() {
    if (window.openai?.requestDisplayMode) {
      return window.openai.requestDisplayMode({ mode: "fullscreen" });
    }
    return rpc("ui/request-display-mode", { mode: "fullscreen" });
  }

  window.__CONTEXT_STUDIO_REQUEST_FULLSCREEN__ = requestFullscreen;
  window.__CONTEXT_STUDIO_OPEN_BROWSER__ = async () => {
    const href = window.__CONTEXT_STUDIO_BROWSER_URL__;
    if (!href) throw new Error("Browser studio is not ready");
    if (window.openai?.openExternal) return window.openai.openExternal({ href });
    const opened = window.open(href, "_blank", "noopener,noreferrer");
    if (!opened) throw new Error("The host blocked the browser window");
  };

  async function drainBrowserPrompts() {
    try {
      const response = await callTool("context_studio_read", { action: "browser_prompts" });
      const data = response?._meta?.data || response?.structuredContent?.data || response?.structuredContent;
      for (const item of data?.prompts || []) {
        await followUp(item.prompt);
        await callTool("context_studio_read", { action: "browser_prompt_ack", promptId: item.id });
      }
    } catch {}
  }

  queueMicrotask(() => requestFullscreen().catch(() => {}));
  setInterval(drainBrowserPrompts, 1000);
})();`;
}

function bundledAppScript() {
  const helpers = fs.readFileSync(path.join(root, "public", "prefix-reuse.js"), "utf8")
    .replace(/^export\s+/gm, "");
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8")
    .replace(/^import\s+[^;]+;\s*/m, "");
  return `${helpers}\n${app}`.replaceAll("</script>", "<\\/script>");
}

function widgetHtml() {
  let html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  const app = bundledAppScript();
  html = html.replace(/<link[^>]+href="\/styles\.css"[^>]*>/, `<style>${css}</style>`);
  html = html.replace(/<script type="module" src="\/app\.js"><\/script>/, `<script>${bridgeScript()}</script><script>window.__CONTEXT_STUDIO_BROWSER_URL__=${JSON.stringify(browserStudioUrl)};</script><script type="module">${app}</script>`);
  return html;
}

function browserHtml() {
  let html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  const app = bundledAppScript();
  const prefix = `/${browserToken}`;
  const bridge = `window.__CONTEXT_STUDIO_EXTERNAL__=true;window.__CONTEXT_STUDIO_MCP_CALL__=async(path,options={})=>{const response=await fetch(${JSON.stringify(prefix)}+path,options);const data=await response.json();if(!response.ok){const error=new Error(data.error?.message||"Request failed");error.code=data.error?.code;throw error;}return data;};`;
  html = html.replace(/<link[^>]+href="\/styles\.css"[^>]*>/, `<style>${css}</style>`);
  html = html.replace(/<script type="module" src="\/app\.js"><\/script>/, `<script>${bridge}</script><script type="module">${app}</script>`);
  return html;
}

const tools = [
  {
    name: "open_context_studio",
    title: "Open Codex Context Studio",
    description: "Open the embedded Context Studio editor for stored Codex rollout history. Use a separate controller task; do not edit the task that is currently hosting this app.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: TEMPLATE_URI, visibility: ["model"] }, "openai/outputTemplate": TEMPLATE_URI },
  },
  {
    name: "context_studio_read",
    title: "Read Context Studio Data",
    description: "Read rollout summaries and backups for the embedded Context Studio UI.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["rollouts", "open", "backups", "stage_status"] }, path: { type: "string" }, requestId: { type: "string" } },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ["app"] } },
  },
  {
    name: "context_studio_stage",
    title: "Stage a Context Studio Action",
    description: "Stage an approved save, restore, or manual backup requested from the embedded UI. Staging does not modify a rollout; committing requires the host hot-reload sequence.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["save", "restore", "backup"] }, payload: { type: "object" } },
      required: ["action", "payload"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ["app"] } },
  },
  {
    name: "context_studio_subagent_fork",
    title: "Fork Parent Context (Temporarily Disabled)",
    description: "Fork is temporarily disabled while registered-task and subagent reuse semantics are being redesigned.",
    inputSchema: {
      type: "object",
      properties: {
        childThreadId: { type: "string" },
        parentThreadId: { type: "string" },
      },
      required: ["childThreadId", "parentThreadId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ["app"] } },
  },
  {
    name: "commit_staged_context_action",
    title: "Commit a Staged Context Edit",
    description: "Commit a Context Studio action only after codex_app set_thread_archived archived the target task. The tool refuses to write unless the rollout is in archived_sessions.",
    inputSchema: { type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ["model"] } },
  },
  {
    name: "verify_staged_context_action",
    title: "Verify a Context Studio Hot Reload",
    description: "Verify that a committed rollout was unarchived into sessions with the exact committed hash and a valid idle structure.",
    inputSchema: { type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ["model"] } },
  },
];

async function callTool(name, args) {
  if (name === "open_context_studio") {
    return publicToolResult({ ready: true }, "Context Studio is open.", { ui: { resourceUri: TEMPLATE_URI } });
  }
  if (name === "context_studio_read") {
    if (args?.action === "rollouts") return appToolResult({ rollouts: discoverRollouts({ limit: 250 }) });
    if (args?.action === "browser_prompts") return appToolResult({ prompts: pendingBrowserPrompts.slice(0, 4) });
    if (args?.action === "browser_prompt_ack") {
      const index = pendingBrowserPrompts.findIndex((item) => item.id === args.promptId);
      if (index >= 0) pendingBrowserPrompts.splice(index, 1);
      return appToolResult({ acknowledged: index >= 0 });
    }
    if (args?.action === "open") return appToolResult(compactUiSummary(readRollout(normalizeRolloutPath(args.path)).summary));
    if (args?.action === "entry") return appToolResult(findUiEntry(readRollout(normalizeRolloutPath(args.path)).summary, args.entryId));
    if (args?.action === "backups") {
      const current = readRollout(normalizeRolloutPath(args.path));
      return appToolResult({ backups: listBackups(current.document.meta.threadId) });
    }
    if (args?.action === "stage_status") return appToolResult(readStagedAction(args.requestId));
    throw Object.assign(new Error("Unknown read action."), { code: "INVALID_ACTION" });
  }
  if (name === "context_studio_stage") {
    const payload = args?.payload || {};
    if (args?.action === "backup") {
      const current = readRollout(normalizeRolloutPath(payload.path));
      if (current.hash !== payload.expectedHash || !current.document.status.idle) {
        throw Object.assign(new Error("The rollout changed or became active before backup."), { code: "RACE_DETECTED" });
      }
      const backup = createManualBackup({ sourcePath: current.resolved, buffer: current.buffer, sourceHash: current.hash, threadId: current.document.meta.threadId, label: payload.label });
      return appToolResult({ backup, backups: listBackups(current.document.meta.threadId) });
    }
    const staged = stageContextAction({
      action: args.action,
      filePath: normalizeRolloutPath(payload.path),
      expectedHash: payload.expectedHash,
      patches: payload.patches || [],
      deletions: payload.deletions || [],
      backupId: payload.backupId || null,
    });
    return appToolResult({
      summary: compactUiSummary(staged.summary),
      staged: true,
      requestId: staged.stage.requestId,
      hotReloadPrompt: hotReloadPrompt(staged.stage),
    });
  }
  if (name === "context_studio_subagent_fork") {
    return prepareSubagentFork(args || {});
  }
  if (name === "commit_staged_context_action") {
    const stage = commitStagedAction(args?.requestId);
    return publicToolResult({ requestId: stage.requestId, threadId: stage.threadId, status: stage.status, committedHash: stage.committedHash }, "Staged Context Studio action committed. Unarchive the task, then verify it.");
  }
  if (name === "verify_staged_context_action") {
    const stage = verifyStagedAction(args?.requestId);
    return publicToolResult({ requestId: stage.requestId, threadId: stage.threadId, status: stage.status, committedHash: stage.committedHash }, "Context Studio hot reload verified.");
  }
  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: "UNKNOWN_TOOL" });
}

function readHttpBody(request, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) return reject(Object.assign(new Error("Request body is too large."), { code: "BODY_TOO_LARGE" }));
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(Object.assign(new Error("Invalid JSON request body."), { code: "INVALID_BODY" })); }
    });
    request.on("error", reject);
  });
}

function sendHttpJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
}

async function browserApi(request, url, pathname) {
  const body = request.method === "POST" ? await readHttpBody(request) : {};
  let resultValue;
  if (request.method === "GET" && pathname === "/api/rollouts") {
    resultValue = await callTool("context_studio_read", { action: "rollouts" });
  } else if (request.method === "POST" && pathname === "/api/open") {
    resultValue = await callTool("context_studio_read", { action: "open", path: body.path });
  } else if (request.method === "POST" && pathname === "/api/entry") {
    resultValue = await callTool("context_studio_read", { action: "entry", path: body.path, entryId: body.entryId });
  } else if (request.method === "GET" && pathname === "/api/backups") {
    resultValue = await callTool("context_studio_read", { action: "backups", path: url.searchParams.get("path") });
  } else if (request.method === "POST" && pathname === "/api/backups") {
    resultValue = await callTool("context_studio_stage", { action: "backup", payload: body });
  } else if (request.method === "POST" && ["/api/save", "/api/restore"].includes(pathname)) {
    resultValue = await callTool("context_studio_stage", { action: pathname.slice(5), payload: body });
  } else if (request.method === "POST" && pathname === "/api/subagent-fork") {
    resultValue = await callTool("context_studio_subagent_fork", body);
  } else {
    throw Object.assign(new Error("Unsupported browser action."), { code: "UNSUPPORTED_ACTION" });
  }
  const data = resultValue?._meta?.data || resultValue?.structuredContent;
  const prompt = data?.hostActionPrompt || data?.hotReloadPrompt;
  if (prompt) pendingBrowserPrompts.push({ id: crypto.randomUUID(), prompt });
  return data;
}

async function startBrowserStudio() {
  const prefix = `/${browserToken}`;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (!url.pathname.startsWith(prefix)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return response.end("Not found");
    }
    const pathname = url.pathname.slice(prefix.length) || "/";
    if (request.method === "GET" && pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" });
      return response.end(browserHtml());
    }
    Promise.resolve(browserApi(request, url, pathname))
      .then((data) => sendHttpJson(response, 200, data))
      .catch((cause) => sendHttpJson(response, 400, { error: { code: cause?.code || "BROWSER_API_FAILED", message: cause instanceof Error ? cause.message : String(cause) } }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  browserStudioUrl = `http://127.0.0.1:${address.port}/${browserToken}/`;
  return server;
}

await startBrowserStudio();

async function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    result(id, {
      protocolVersion: params?.protocolVersion || "2025-11-25",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "Codex Context Studio", version: manifest.version },
      instructions: "Context Studio stages rollout changes before any write. For a staged request, archive the target with codex_app set_thread_archived, call commit_staged_context_action, always unarchive it, then call verify_staged_context_action. Never commit a task that is not archived.",
    });
  } else if (method === "ping") result(id, {});
  else if (method === "resources/list") result(id, { resources: [{ uri: TEMPLATE_URI, name: "context-studio-editor", title: "Codex Context Studio", mimeType: MIME }] });
  else if (method === "resources/read") {
    if (params?.uri !== TEMPLATE_URI) throw Object.assign(new Error("Unknown UI resource."), { code: "UNKNOWN_RESOURCE" });
    result(id, { contents: [{ uri: TEMPLATE_URI, mimeType: MIME, text: widgetHtml(), _meta: { ui: { prefersBorder: false } } }] });
  } else if (method === "tools/list") result(id, { tools });
  else if (method === "tools/call") result(id, await callTool(params?.name, params?.arguments || {}));
  else if (id !== undefined) error(id, JsonRpcError.METHOD_NOT_FOUND, `Method not found: ${method}`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  Promise.resolve(handle(message)).catch((cause) => {
    if (message.id === undefined) return;
    error(message.id, JsonRpcError.INVALID_PARAMS, cause instanceof Error ? cause.message : String(cause), {
      code: cause?.code || "MCP_TOOL_FAILED",
      details: cause?.details,
    });
  });
});
