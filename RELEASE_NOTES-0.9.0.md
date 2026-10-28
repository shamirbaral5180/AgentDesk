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
- Size: 157,846,329 bytes
- SHA-256: `C04DDC538D2F20A397469818DC5DD40A60C681E9CC6ECCE4FD543C2429B98D68`

## Upgrade notes

See [docs/UPGRADE-0.9.0.md](docs/UPGRADE-0.9.0.md). Project databases receive migration v7 (indexes) and v8 (`run_leases`). A pre-migration backup is created automatically; five backups are kept by default.
