# AgentDesk v0.9.0

Final hardening and portable release.

## Highlights

- Crash recovery with persisted run leases and Plan/Build checkpoints.
- Recovery banner with Resume, Mark stopped, and details.
- Interrupted chat messages are marked and retryable manually.
- Startup reconciliation releases stale claims, cancels stale approvals, and cleans stale background and MCP processes.
- Section-by-section settings recovery, per-entry secrets recovery, fsync atomic writes, and rotated backups.
- SQLite quick/integrity checks, backup rotation, restore, retention pruning, vacuum, and database visibility.
- Destructive MCP tools always require Boss approval, even when the project policy says allow.
- MCP transports reconnect once, tool output is capped, and output is marked untrusted.
- Bundled npm/npx runtime for package-based stdio MCP servers.
- Settings, Data: export JSON/Markdown/CSV, scoped resets, diagnostics, retention, cost dashboard, and manual maintenance.
- Monthly cost cap with warning at 80 percent and hard stop at 100 percent.
- Update dismissal persistence, manual update check, and release notes link.
- Security hardening: path traversal, UNC, ADS, reserved names, symlink checks, command bypass checks, approval redaction, CSP, and permission denial.

## Verification

- Typecheck passed.
- Phase 1 through Phase 9 development smokes passed.
- Phase 1 through Phase 9 packaged smokes passed from a clean extraction.
- The portable zip contains no `data/` directory.
- No AppData folder is created.
- No AgentDesk process is left running after the packaged test matrix.

## Artifact

- File: `AgentDesk-0.9.0-x64.zip`
- Size: 157,848,361 bytes
- SHA-256: `624BE8C1F2C181578254AADBCFC35CEBFEAC4E600FD5934B1571D8D1C69441A6`

## Review refinements

- Blue accent theme with a working Dark / Light appearance selector.
- Landing hero reads "You lead. The team does the work."
- Ollama is local-only; cloud endpoints use Custom. Non-custom provider names are fixed.
- Team empty state explains per-project initialization and default system prompts.
- MCP settings include stdio, Streamable HTTP, and SSE example presets.
- Chat is one shared team room: everyone sees the transcript and the selected agent replies.
- Plan/Build mode switching lives in the composer; the top-bar mode switch was removed.
- Typing `/plan` or `/build` in the composer switches modes.

## Upgrade notes

See [docs/UPGRADE-0.9.0.md](docs/UPGRADE-0.9.0.md). Project databases receive migration v7 (indexes) and v8 (`run_leases`). A pre-migration backup is created automatically; five backups are kept by default.
