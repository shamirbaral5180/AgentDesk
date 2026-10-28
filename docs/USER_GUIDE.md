# AgentDesk user guide

AgentDesk is a portable Windows x64 desktop studio for a Boss-led team of coding agents. It runs from a folder, keeps its global data beside the executable, and stores each project's workspace inside that repository.

## 1. First run

1. Extract the portable zip to a writable folder.
2. Start `AgentDesk.exe`.
3. Open a repository folder.
4. AgentDesk creates `<repo>/.agentdesk` with the project database, team, context files, snapshots, logs, and backups.
5. Open Settings, Providers and add a provider.
6. Discover or add a model.
7. Open Settings, Team and assign a model to every agent you want to use.

There is no installer, registry entry, or AppData dependency. Deleting the app folder removes the global catalog; project data stays in each repository. Deleting a repository removes that project's memory.

## 2. Providers and models

Supported provider types:

- OpenAI
- Google Gemini
- Ollama
- Custom OpenAI-compatible endpoints

API keys are encrypted with Windows DPAPI through Electron `safeStorage`. Keys never appear in settings, project files, exports, logs, or diagnostics. Use the model test dialog to stream a short response before assigning the model.

## 3. Team roster

The default team has six editable agents: Coordinator, Frontend, Backend, Database, QA, and DevOps. You can rename agents, edit instructions, change colors, enable or disable them, add custom agents, and set write scopes.

Each agent can be assigned a different model and temperature. Plan mode only offers read-only tools. Build mode offers write, patch, move, delete, and command tools subject to role scope and approvals.

## 4. Project desk

The Project desk is the single workspace for planning and building. It has three panes:

- Left: project files and the team roster with live statuses.
- Middle: the Boss-to-Coordinator chat. Only the Coordinator answers you.
- Right: agent-to-agent discussion, tasks, and active file claims.

The composer has only Plan and Build. Plan mode is read-only. Build mode can create, edit, and test files inside the opened project folder. `.agentdesk` only stores memory, tasks, snapshots, and state; the app being built lives in the project folder itself.

## 5. Plan room

1. Choose Plan room.
2. Describe the goal.
3. Select the participants.
4. Start the meeting.

The Plan room runs intake, discussion, and planning phases. Every turn is stored. The Coordinator returns a structured plan with tasks, decisions, risks, acceptance criteria, and file claims. If the structured plan cannot be parsed, a deterministic fallback plan is used.

You can stop or pause a meeting, send a direct message to a participant, inspect the timeline, and approve the finished plan.

## 5. Build room

Build rooms start from a completed, approved Plan meeting. Tasks run one at a time with one active writer. Each task gets enforced file claims. QA reviews the result; a `changes_requested` review enters a fix cycle, then re-review.

Controls:

- Pause keeps partial work and allows resume.
- Stop ends the meeting and records a partial report.
- Queue interrupt adds Boss guidance for the next turn.
- Immediate interrupt pauses the current turn and cancels open approvals.
- Task-level revert restores the files changed by that task.
- Changes opens the full snapshot-backed change log.

The final report lists files, commands, tests, approvals, unresolved items, and revert instructions.

## 6. Approvals and changes

Approvals are required for writes outside role scope, outside-project paths, installs, downloads, deploys, git pushes, inline code execution, destructive commands, and destructive MCP tools.

A destructive MCP tool always asks the Boss, even when its project policy is `allow`. Approval grants apply only within their scope and project; they cannot bypass hard blocks.

Every file write is snapshotted before it happens. File changes and commands are recorded in the project change log and can be reverted.

## 7. Memory

AgentDesk stores:

- Personal memory per agent
- Shared project memory
- Session summaries
- Rolling summaries
- Pinned memories

Memory is recalled into prompts and can be searched by the `recall_memory` tool. Pinned memory is never removed by retention pruning. Settings, Memory shows the bundle and lets you pin or delete entries.

## 8. MCP

The MCP catalog is global and lives in the app folder. Project configuration only stores enabled server IDs and per-tool policies. Secrets for MCP environment variables and headers live in the DPAPI store.

Supported transports:

- stdio
- Streamable HTTP
- legacy SSE

The portable release bundles npm and npx under `resources/runtime/npm`, so package-based stdio servers do not depend on a host Node installation. A host `PATH` fallback remains for development builds.

Tools are namespaced as `mcp__<server>__<tool>`. Plan mode only exposes read-only tools. Build mode exposes allowed tools. A transport failure triggers one reconnect before retrying. Tool output is capped and marked as untrusted data.

Use Settings, MCP to add, test, discover, restart, view logs, enable for the project, set policies, and inspect audit rows.

## 9. Recovery and backups

AgentDesk records a run lease and checkpoint while Plan, Build, and direct meeting turns run. If the app stops unexpectedly:

1. Open the project again.
2. A recovery banner shows resumable meetings and interrupted chat messages.
3. Choose Resume to continue from the last checkpoint, or Mark stopped to close the run.
4. Completed intake, discussion, and Build tasks are skipped. Stale claims are released and stale approvals are cancelled.

Chat responses that were streaming are marked interrupted, not left spinning. Retry manually from the message.

Startup also reconciles managed background processes and stale MCP child processes.

Settings and secrets use fsync-backed atomic writes with rotated backups. A bad settings field is recovered section by section. A bad encrypted secret is dropped alone; unrelated keys survive.

## 10. Retention, export, reset

Settings, Data shows database size, table counts, integrity status, backups, and last backup time.

- Backup now creates a consistent SQLite backup and keeps the configured number of backups.
- Prune old data applies retention and never touches active runs or pinned memory.
- Vacuum compacts the database.
- Restore newest restores the newest backup.

Default retention:

- Chat sessions: 90 days
- Meetings: 90 days
- Usage: 180 days
- MCP audit: 30 days
- Tool calls: 30 days
- Command logs: 14 days
- Unreferenced snapshots: 30 days
- Database backups kept: 5

Export writes JSON, Markdown, CSV, and optional attachments. Secrets are never exported.

Reset scopes:

- Personal memory
- Shared project memory
- Session memory
- Logs and cache

Type `RESET` to confirm. The selected scope only is removed.

## 11. Cost controls

Settings, Data shows usage by provider and the current month cost. The default monthly cap is 50 USD with a warning at 80 percent and a hard stop at 100 percent. The hard stop blocks new chat runs and meetings until you raise the cap.

Per-meeting limits still apply independently: rounds, turns, messages, minutes, tokens, cost, tool steps, and review cycles.

## 12. Update notifications

AgentDesk checks the GitHub latest release at startup. Only the portable zip is offered for download. A dismissed version is remembered; Settings, About has a manual Check now button and release notes link.

## 13. Diagnostics

Settings, Data can generate redacted diagnostics, copy them, or export a text file. Diagnostics include versions, paths, database health, counts, and recovery state. Secret values are never included.

## 14. Troubleshooting

- Project already open: another AgentDesk instance holds the project lock. Close it or remove a stale `.agentdesk/app.lock` only after confirming no instance is running.
- Provider failure: check the key, endpoint, and model test in Settings.
- Missing tools: confirm the model supports tools and the agent permissions include the tool family.
- MCP unavailable: test the server, inspect logs, and check the project enablement and policy.
- Corrupt database: AgentDesk tries the newest backup on open. If that fails, restore from Settings, Data or copy the project to a safe place before manual repair.
- Portable zip will not start: move the folder to a writable location. The app must be able to create `data` beside the executable.

## 15. Data locations

- Portable app data: `<app folder>/data`
- Project workspace: `<repo>/.agentdesk`
- Project database: `<repo>/.agentdesk/agentdesk.db`
- Project backups: `<repo>/.agentdesk/backups`
- Logs: `<repo>/.agentdesk/logs` and `<app folder>/data/logs`
- MCP catalog: `<app folder>/data/mcp/servers.json`
