import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("MCP server advertises the embedded app and guarded commit tools", async (context) => {
  const child = spawn(process.execPath, [path.join(root, "mcp", "server.mjs")], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  context.after(() => child.kill());
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });

  let nextId = 1;
  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP timeout for ${method}: ${stderr}`)), 5000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(initialized.serverInfo.name, "Codex Context Studio");
  const listed = await request("tools/list");
  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
  assert.ok(byName.has("open_context_studio"));
  assert.deepEqual(byName.get("context_studio_stage")._meta.ui.visibility, ["app"]);
  assert.deepEqual(byName.get("context_studio_subagent_fork")._meta.ui.visibility, ["app"]);
  assert.deepEqual(byName.get("commit_staged_context_action")._meta.ui.visibility, ["model"]);

  const resources = await request("resources/list");
  assert.equal(resources.resources.length, 1);
  assert.equal(resources.resources[0].mimeType, "text/html;profile=mcp-app");
  const resource = await request("resources/read", { uri: resources.resources[0].uri });
  assert.match(resource.contents[0].text, /__CONTEXT_STUDIO_MCP_CALL__/);
  assert.match(resource.contents[0].text, /__CONTEXT_STUDIO_REQUEST_FULLSCREEN__/);
  assert.match(resource.contents[0].text, /ui\/request-display-mode/);
  assert.match(resource.contents[0].text, /__CONTEXT_STUDIO_OPEN_BROWSER__/);
  assert.match(resource.contents[0].text, /Context Studio/);
  assert.match(resource.contents[0].text, /缓存命中率/);
  assert.match(resource.contents[0].text, /function analyzePrefixReuse/);
  assert.doesNotMatch(resource.contents[0].text, /import\s+\{[^}]*analyzePrefixReuse/);

  const browserUrl = resource.contents[0].text.match(/window\.__CONTEXT_STUDIO_BROWSER_URL__=("http:\/\/127\.0\.0\.1:[^";]+\/+")/)?.[1];
  assert.ok(browserUrl);
  const browserResponse = await fetch(JSON.parse(browserUrl));
  assert.equal(browserResponse.status, 200);
  assert.match(await browserResponse.text(), /__CONTEXT_STUDIO_EXTERNAL__/);

  const rollouts = await request("tools/call", { name: "context_studio_read", arguments: { action: "rollouts" } });
  assert.ok(Array.isArray(rollouts.structuredContent.rollouts));

  const opened = await request("tools/call", { name: "open_context_studio", arguments: {} });
  assert.equal(opened.structuredContent.ready, true);
  assert.equal(opened._meta.ui.resourceUri, resources.resources[0].uri);
});
