# Contributing

Thank you for improving Context Studio. Changes should preserve user data, keep the server local-only, and treat Codex rollout JSONL as an unstable private format.

## Development

1. Install Node.js 20 or newer.
2. Create a branch in your own clone.
3. Run `npm test` before and after the change.
4. Run the Codex plugin validator against the plugin root.
5. Test destructive workflows only with synthetic or disposable tasks. Never attach real rollout files to public issues.

The project intentionally has no runtime npm dependencies. Discuss a new dependency before adding it, especially if it handles session contents or starts a network listener.

## Pull requests

- Keep changes focused and explain their safety impact.
- Add or update tests for parsing, editability, deletion pairing, lifecycle detection, backup integrity, staged writes, and race behavior as applicable.
- Document platform-specific behavior. Do not claim macOS or Linux support without testing it.
- Do not add generated session data, backups, database files, credentials, local paths, or personal identifiers.
- Do not weaken protected-record rules or bypass idle/archive/hash checks merely to make a write succeed.
- Do not list tools, automated systems, or fabricated identities as authors or contributors.

## Reporting bugs

Provide the operating system, Node.js version, Codex version, reproduction steps, and sanitized error codes. Replace task IDs, usernames, paths, prompt content, tool output, and tokens before sharing logs.

Security vulnerabilities should follow [SECURITY.md](SECURITY.md), not a public issue.
