# AgentDesk

AgentDesk is a portable, local-first Windows desktop studio for a Boss-led multi-agent software team.

You direct the team. Six editable specialists inspect the repository, discuss the work, produce an approved plan, and then execute it with explicit file claims, QA review, approvals, snapshots, and a full audit trail.

## What is included

- **Project desk**: one unified workspace with sessions, project files, live agent activity, a plain-English Boss-to-Coordinator chat, the team channel, agent flows, the task board, and file claims.
- **Parallel team**: plan, build, agent requests, waiting tasks, notifications, and per-agent todo flows; up to four agents build in parallel by default.
- **Build**: enforced snapshots and claims, QA review cycles, task-level revert, Boss interrupts, pause/resume, final report, and diff summary.
- **Tools**: repository read/search/write/edit/patch/delete/move, shell and background processes, memory, coordination, and MCP for Build agents; read-only tools for Plan.
- **Approvals**: opencode-style permission cards for outside-project paths, installs, downloads, container builds and runs, deploys, pushes, inline execution, destructive commands, and risky MCP tools.
- **Memory**: personal agent memory, shared project memory, rolling summaries, pinned memories, and cross-session recall.
- **MCP**: global server catalog in the app folder, project-scoped enablement and tool policies, stdio/Streamable HTTP/legacy SSE transports, discovery, approvals, audit rows, logs, and restart controls.
- **Providers**: OpenAI, Google Gemini, Ollama, and custom OpenAI-compatible endpoints.
- **Recovery**: persisted run leases, Plan/Build checkpoints, resume or mark stopped, stale claim/approval cleanup, interrupted chat retry, and process reconciliation.
- **Data controls**: SQLite integrity checks, rotated backups, restore, retention pruning, vacuum, export, reset, diagnostics, and a monthly cost guard.
- **Portable data**: no installer, no registry, no AppData dependency. The app folder owns the global catalog; each repository owns its `.agentdesk` workspace.

## Requirements

- Windows x64.
- A model provider or a local OpenAI-compatible endpoint.
- Package-based stdio MCP servers use the bundled Electron Node runtime and the bundled npm/npx runtime in the release zip. A host Node/npm on `PATH` is only a fallback when the bundled runtime is unavailable.

## Run

```powershell
npm install
npm run dev
```

## Verify

```powershell
npm run typecheck
npm run smoke
npm run smoke:phase2
npm run smoke:phase3
npm run smoke:phase4
npm run smoke:phase5
npm run smoke:phase6
npm run smoke:phase7
npm run smoke:phase8
npm run smoke:phase9
npm run smoke:phase10
```

## Package

```powershell
npm run dist:win
```

The portable zip is written to `dist/AgentDesk-<version>-x64.zip`.

## Release and updates

Only the portable `.zip` is attached to GitHub releases. AgentDesk checks the latest GitHub release at startup and shows an in-app banner when a newer zip release exists. A dismissed version stays dismissed, and Settings, About has a manual check with release notes. No telemetry is sent.

## Documentation

- [User guide](docs/USER_GUIDE.md)
- [Upgrade notes v0.8.0 to v0.9.0](docs/UPGRADE-0.9.0.md)
- [Release notes v0.20.1](RELEASE_NOTES-0.20.1.md)
- [Release notes v0.20.0](RELEASE_NOTES-0.20.0.md)
- [Release notes v0.10.0](RELEASE_NOTES-0.10.0.md)
- [Release notes v0.9.0](RELEASE_NOTES-0.9.0.md)

## Repository layout

- `src/main`: Electron main process, SQLite, providers, chat, meetings, MCP, updates.
- `src/preload`: sandboxed typed bridge.
- `src/renderer`: React Project desk, settings, approvals, changes, memory, MCP.
- `src/shared`: shared types and IPC contracts.

## License

MIT
