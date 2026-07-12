# Codex Context Studio

Codex Context Studio is a local, zero-dependency visual editor for inspecting and carefully editing Codex rollout JSONL files. It provides token estimates, live idle-state checks, immutable first-edit backups, manual backup versions, structural validation, race detection, and atomic replacement.

> [!WARNING]
> This is an independent, experimental tool that edits Codex's private on-disk session format. The format is not a stable public API. A malformed or stale edit can make a task unreadable, desynchronize it from Codex's in-memory state, or lose conversation history. Keep external backups and test with disposable tasks first.

## Platform support

| Platform | Status | Notes |
| --- | --- | --- |
| Windows | Primary/tested | Includes a PowerShell launcher. File replacement includes Windows-specific retry handling. |
| macOS | Experimental | The Node.js server and shell launcher are designed to work, but are not regularly tested. |
| Linux | Experimental | The Node.js server and shell launcher are designed to work, but are not regularly tested. |

Node.js 20 or newer is required. Codex Desktop integration and its MCP App APIs may differ by Codex release and platform.

## Safety model

- Saves are accepted only while the selected task has no active turn.
- The server compares the current SHA-256 with the hash captured when the file was opened.
- Session metadata, IDs, ordinals, turn context, world state, calls, and structural fields are never accepted from the browser.
- Only user/assistant message text and string-valued outputs with a matching tool call can be patched.
- Completed reasoning items, selected `<skill>` fragments, and paired tool/MCP transactions after the latest compaction may be removed as whole units.
- Developer/system instructions, tool schemas, dynamic tool definitions, IDs, and structural records are protected.
- The complete document is parsed and validated before and after serialization.
- The first successful edit creates one immutable original backup. Later versions are created only by manual backup.
- Any concurrent file change aborts the save.

These guardrails reduce risk; they do not make private-format editing risk-free. JSONL contents can include prompts, source code, tool output, local paths, secrets, and other sensitive data. The UI is local-only, but backups retain the same sensitive content as the source rollout. Protect the Codex home and backup directories accordingly.

## Install as a Codex plugin

Clone or copy this directory into a local Codex plugin source and install it through a Codex marketplace or the plugin development workflow supported by your Codex release. The required manifest is `.codex-plugin/plugin.json`; the MCP server definition is `.mcp.json`.

Use a separate controller task to open Context Studio. Select only an idle target task, and never select the controller task hosting the app. The embedded write flow stages the operation, asks Codex to archive/unload the target, commits the staged bytes, unarchives/reloads the task, and verifies the final hash.

## Standalone development

There are no npm dependencies:

```shell
npm start
```

Windows launcher:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-context-studio.ps1
```

macOS/Linux launcher:

```shell
sh ./scripts/start-context-studio.sh
```

The server binds only to `127.0.0.1`. The standalone browser UI supports inspection and manual backups, but direct save and restore are disabled by default because it cannot unload a task already held in app-server memory.

Recovery-mode direct writes are available only when Codex is fully closed:

```shell
CONTEXT_STUDIO_ALLOW_DIRECT_WRITE=1 npm start
```

On PowerShell:

```powershell
$env:CONTEXT_STUDIO_ALLOW_DIRECT_WRITE = "1"
npm start
```

Do not expose the HTTP server, recovery mode, or a Codex session directory to untrusted users. `CONTEXT_STUDIO_BACKUP_DIR` may be used to place backups in a separate protected directory.

## Editing rules

Editable:

- canonical `response_item` user messages;
- canonical `response_item` assistant messages;
- string-valued `function_call_output` and `custom_tool_call_output` records with a matching call.

Locked:

- developer/system messages and tool schemas;
- session metadata, thread IDs, ordinals, timestamps, turn context, and world state;
- calls, call IDs, tool names, non-string output structures, and encrypted reasoning metadata.

Whole-item deletion is limited to completed turns after the latest compaction checkpoint:

- reasoning records;
- paired function/custom-tool calls and outputs, including MCP calls;
- pure `<skill>...</skill>` contextual messages.

Edits before the latest compaction alter the archival log but generally do not reduce the active model input, because the model resumes from the compacted replacement history. Token values shown per item are estimates. Budget calibration uses the latest non-zero `last_token_usage.input_tokens` event when available and cannot exactly reconstruct external system prompts, tool schemas, skill injection, image accounting, caching, or future Codex transformations.

The backup selector restores the immutable original or a manually created version. Restore does not automatically create another backup; create a manual version first if the current state must be retained.

## Subagent fork

The optional embedded “Fork parent context” action asks an idle parent task to create a new real subagent with `fork_turns="all"`. This creates a live task and can interact with Codex Desktop routing. It is unrelated to backup/restore and should be used only when explicitly requested. If a Codex release has subagent routing or reconnect issues, avoid this feature.

## Test and validate

```shell
npm test
python /path/to/plugin-creator/scripts/validate_plugin.py .
```

Tests use temporary synthetic rollouts; do not point tests at a real Codex session directory.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development expectations and [SECURITY.md](SECURITY.md) for private vulnerability reporting guidance. This project is licensed under the [MIT License](LICENSE).
