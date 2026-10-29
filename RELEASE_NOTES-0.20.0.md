# AgentDesk 0.20.0

## Highlights

- One unified **Project desk**. The separate individual agent chat, Plan room, and Build room views are removed.
- **Parallel team execution**: Build runs up to 4 agents at once by default. Independent tasks start immediately; dependency-gated tasks wait.
- **Agent-to-agent coordination**: agents share a team channel, post progress, request work from each other, go into `Waiting` while a request is built, resume automatically, and notify the team when their part is done.
- **Per-agent todo flows**: every agent owns a personal checklist (`todo_write` / `todo_read`) that is persisted and shown as Agent flows.
- **Real file creation**: Build agents write with `write_file`, `edit_file`, `apply_patch`, `delete_path`, and `move_path`. Code pasted into chat is no longer accepted as delivery; a repair turn asks the agent to call write tools, otherwise the task stops with a clear reason.
- **Better tools**: added `glob`, `grep` with regular expressions and include filters, `edit_file`, `apply_patch`, background commands, and process controls, in addition to reading, listing, and searching.
- **Full access inside the repository**: agents edit and test anywhere inside the project. Paths claimed by another active task are protected. Actions outside the repo, container imagery and containers, installs, downloads, deploys, pushes, inline execution, and destructive commands ask the Boss.
- **opencode-style approval experience**: a centered permission card with the agent, action, reason, full command or patch details, rich risk badge, and `Allow once`, `Always allow`, `Reject` (keys 1, 2, 3).
- **Session management**: sessions load, rename, and delete from the left sidebar; deleting removes the meeting, messages, tasks, todos, activity, claims, usage, approvals, and logs for that session only.
- **Safer recovery**: live pending approvals are no longer cancelled by project-open recovery; only approvals from an actual app restart are cancelled.
- **Tool-capable model guard**: Build refuses to start when a task-owning agent is on a model that cannot call tools, and names the agents to fix.

## Verification

- `typecheck`, `smoke`, `smoke:phase2` through `smoke:phase10` all pass.
- The new Phase 10 smoke proves:
  - 4 build turns ran concurrently (at least 3 required).
  - Backend requested a shared contract from the Database agent.
  - The Backend task entered `Waiting`, resumed after the request completed, and finished.
  - Agents persisted todo lists and the request was visible in the team channel.
  - Files were created in the project folder, including `backend/contract.ts`.
  - Session rename/delete works and Docker commands require approval.

## Download

- `AgentDesk-0.20.0-x64.zip`
- Size: 157,844,423 bytes
- SHA-256: `76447493DD70336A7D75958568FB1B11CEBCA9ACD167FA7DFB22A9997CBC188F`

AgentDesk checks GitHub latest release at startup and shows a banner for a newer version. Dismissed versions stay hidden, and Settings, About has a manual check.