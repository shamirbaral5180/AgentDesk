# AgentDesk

AgentDesk is a portable, local-first Windows desktop studio for a Boss-led multi-agent software team.

You direct the team. Six editable specialists inspect the repository, discuss the work, produce an approved plan, and then execute it with explicit file claims, QA review, approvals, snapshots, and a full audit trail.

## What is included

- **Plan room**: six-agent intake, free-form discussion, coordinator synthesis, tasks, decisions, file claims, budgets, and a structured final plan.
- **Build room**: sequential task execution, one writer at a time, enforced file claims, QA review cycles, task-level revert, Boss interrupts, pause/resume, final report, and diff summary.
- **Approvals**: writes outside role scope, destructive commands, installs, deploys, pushes, outside-project paths, and risky MCP tools pause for the Boss.
- **Memory**: personal agent memory, shared project memory, rolling summaries, pinned memories, and cross-session recall.
- **MCP**: global server catalog in the app folder, project-scoped enablement and tool policies, stdio/Streamable HTTP/legacy SSE transports, discovery, approvals, audit rows, logs, and restart controls.
- **Providers**: OpenAI, Google Gemini, Ollama, and custom OpenAI-compatible endpoints.
- **Portable data**: no installer, no registry, no AppData dependency. The app folder owns the global catalog; each repository owns its `.agentdesk` workspace.

## Requirements

- Windows x64.
- A model provider or a local OpenAI-compatible endpoint.
- Optional: Node/npm on `PATH` for package-based stdio MCP servers. The bundled Electron Node runtime is used when a stdio server command is `node`.

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
```

## Package

```powershell
npm run dist:win
```

The portable zip is written to `dist/AgentDesk-<version>-x64.zip`.

## Release and updates

Only the portable `.zip` is attached to GitHub releases. AgentDesk checks the latest GitHub release at startup and shows an in-app banner when a newer zip release exists. No telemetry is sent.

## Repository layout

- `src/main`: Electron main process, SQLite, providers, chat, meetings, MCP, updates.
- `src/preload`: sandboxed typed bridge.
- `src/renderer`: React workspace, Plan room, Build room, settings, approvals, changes, memory, MCP.
- `src/shared`: shared types and IPC contracts.

## License

MIT
