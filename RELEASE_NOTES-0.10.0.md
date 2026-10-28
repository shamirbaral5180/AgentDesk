# AgentDesk v0.10.0

Project desk UI and team workflow update.

## Highlights

- One Project desk replaces the separate Chat, Plan room, and Build room views.
- Left pane: team roster with live statuses (Ready, Waiting, Reading, Writing, Testing, Reviewing, Blocked, and more).
- Middle pane: Boss-to-Coordinator main chat. Only the Coordinator addresses the Boss.
- Right pane: agent-to-agent discussion, task board, and active file claims.
- Plan and Build are the only composer mode controls. Plan is read-only; Build can create, edit, and test.
- New plans and builds start directly from the main chat.
- Approve plan and start Build from the main chat.
- The team works inside the opened project folder; `.agentdesk` only stores memory, tasks, snapshots, and state.
- Build agents use `write_file`/`patch_file`; if a model describes files without calling a write tool, AgentDesk recovers those file blocks into the project so QA can review real files.
- Project-relative paths with a leading slash are normalized into the project.
- Larger Build output budget to reduce truncated file writes.

## Verification

- Typecheck passed.
- Phase 6, 7, and 9 smokes passed.
- New Project desk rendered through the screenshot harness.
- Packaged smokes passed from a clean extraction.

## Artifact

- File: `AgentDesk-0.10.0-x64.zip`
- Size: 157,829,821 bytes
- SHA-256: `AA78FC1AA218ADB1A1258654ADC59FF8DD914FDCC09DDB0EE1BBC52C31FE59E2`

## Upgrade

Existing v0.9.0 projects open with the same database. No schema migration is required for this UI update.
