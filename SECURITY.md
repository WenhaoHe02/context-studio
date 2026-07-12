# Security Policy

## Scope

Security-sensitive areas include rollout path validation, local HTTP access, MCP tool visibility, staged archive/commit/verify writes, backup confidentiality, symlink/path traversal, race detection, and structural validation.

## Reporting a vulnerability

Do not publish an exploit, real rollout, backup, session database, access token, subscription URL, or unredacted log in a public issue. Use the repository host's private security-advisory feature when available. If no private channel is configured, ask the maintainers for a private contact channel without including sensitive details.

Include a minimal reproduction using synthetic data, affected versions/platforms, impact, and any proposed mitigation. Remove usernames, absolute paths, task IDs, prompt text, source code, credentials, and proxy configuration.

## Operational guidance

- Bind only to loopback; never reverse-proxy Context Studio to a LAN or the internet.
- Keep Codex session and backup directories readable only by the local user.
- Fully close Codex before enabling `CONTEXT_STUDIO_ALLOW_DIRECT_WRITE=1`.
- Do not edit a running task or the controller task hosting the MCP App.
- Treat all rollout text and tool output as untrusted display content and all rollout paths as untrusted input.
- Keep an independent backup before testing a new release.

Because Codex's rollout format and embedded app APIs can change without notice, compatibility failures are possible even when no security boundary was intentionally changed.
