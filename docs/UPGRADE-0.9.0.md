# Upgrade notes: v0.8.0 to v0.9.0

## Before upgrading

1. Close every running AgentDesk instance.
2. Keep your current portable folder and any open repositories backed up or committed.
3. Extract the v0.9.0 zip to a new folder; do not merge it over an old extraction while the app is running.

## Data compatibility

- Settings schema is additive. Existing providers, models, recent projects, window state, and theme are preserved.
- A new section-by-section settings recovery keeps valid fields even when one field is invalid.
- Secrets remain in the same DPAPI store. One undecryptable entry is removed alone; unrelated keys remain.
- Each project database receives migration v7 (extra indexes) and v8 (`run_leases` for checkpoints).
- A pre-migration database backup is created automatically in `.agentdesk/backups`.
- Five backups are kept by default. Retention is configurable in Settings, Data.

## Behavior changes

- Plan and Build meetings persist checkpoints. After a crash, a recovery banner offers Resume or Mark stopped. Completed turns and tasks are skipped.
- Interrupted chat responses are marked interrupted and require a manual Retry.
- Destructive MCP tools always require Boss approval, even if the project policy is `allow`.
- MCP output is capped and labeled as untrusted data. A dropped transport is retried once after reconnect.
- MCP tools can be listed from the last discovery cache before warmup finishes; the call connects on demand.
- A monthly cost cap warns at 80 percent and hard-stops at 100 percent by default.
- Update notifications remember the dismissed version and Settings, About has a manual check.

## Database restore

Settings, Data, Restore newest closes and reopens the database. If a view looks stale after restore, close and reopen the project.

## Rollback

v0.9.0 adds `run_leases` and indexes. Older builds ignore unknown tables and indexes. If you need to roll back, restore the pre-migration backup from `.agentdesk/backups` while the app is closed.
