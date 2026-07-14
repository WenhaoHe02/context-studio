---
name: context-studio
description: Open the embedded Codex Context Studio MCP App to inspect and safely edit an idle Codex rollout JSONL, or create a replacement subagent that inherits its parent's complete context. Includes token estimates, staged writes, backups, race detection, validation, and per-task hot reload. Use only when the user explicitly asks to inspect, trim, restore, edit, or fork stored Codex conversation context.
---

# Context Studio

This skill opens an embedded visual editor for Codex rollout history.

1. Tell the user that Context Studio edits stored history. Use a separate controller task and never edit the task currently hosting the app.
2. Call the `open_context_studio` tool from the plugin's `context-studio` MCP server. The tool renders the embedded editor.
3. When the widget posts a staged hot-reload message, follow its exact request id and thread id. Execute this sequence without substituting shell file edits:
   - Call `codex_app.set_thread_archived` with `archived: true` for the target thread.
   - Call `commit_staged_context_action` with the staged request id.
   - Always call `codex_app.set_thread_archived` with `archived: false`, including when commit fails.
   - If commit succeeded, call `verify_staged_context_action` with the same request id.
   - If verification succeeded, call `codex_app.navigate_to_codex_page` with the target thread id. This reopens the task after its app-server cache was unloaded so Codex Desktop rebuilds visible turns from the committed rollout.
   - If navigation is unavailable or fails, do not undo a verified edit; report that the Desktop transcript still needs to be reopened manually.
4. Never call `commit_staged_context_action` before the archive call succeeds. The MCP server also rejects commits whose rollout is not under `archived_sessions`.
5. Do not bypass `THREAD_ACTIVE`, `RACE_DETECTED`, `THREAD_NOT_ARCHIVED`, `FILE_BUSY`, or hash-verification errors.
6. When the widget posts a full-parent-context subagent fork request, call `codex_app.send_message_to_thread` exactly as specified by the widget. The selected parent was verified idle. Its message instructs that parent to call `spawn_agent` with `fork_turns="all"`, which preserves the real parent/subagent relationship and inherits all completed parent history. Do not substitute `codex_app.fork_thread`, `codex_app.create_thread`, or JSONL copying.
7. Keep the standalone server only as a recovery fallback when the MCP App cannot render. Start it with:

```powershell
node "${PLUGIN_ROOT}/server.mjs" --open
```

8. Do not select a rollout, stage edits, or request a subagent fork on the user's behalf unless they explicitly identify the target and request the action.
