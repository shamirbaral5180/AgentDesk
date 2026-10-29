# AgentDesk 0.20.1

This patch makes the chat read like a conversation instead of structured data, and makes the Coordinator actively direct the team and report to the Boss.

## What changed

- **No raw JSON in the Boss chat.** Plan, intake, and review responses are converted to English before they are stored or shown. The plan message now reads as a short summary, a numbered work list with owners and dependencies, decisions, and risks.
- **Legacy structured messages are hidden.** Old sessions that already contain raw JSON show a short English notice instead of the JSON block.
- **The team channel is text-only.** Large code blocks are omitted from chat and point to the project files instead. Review JSON is shown as an English approval or change request.
- **Live agent activity.** The right pane now shows each agent's current task, status, latest tool, and blocker note, so you can see who is reading, writing, testing, reviewing, or waiting.
- **Coordinator acts as the interface.** The Coordinator now reports to the Boss when Build starts, when an agent requests work from another agent, when a task waits, when QA requests changes, when an agent blocks, and when a task completes. It also posts clear directions to the relevant agent in the team channel.
- **No behavior change to parallel execution, requests, waiting, todos, approvals, sessions, or model choice.** The tool-capable model guard remains.

## Verification

- `typecheck`, `smoke`, `smoke:phase6`, `smoke:phase7`, `smoke:phase9`, and `smoke:phase10` pass.
- Phase 6 now asserts that intake and plan messages are conversational and contain no raw JSON.
- Phase 10 now asserts that Build records Coordinator status messages and leaks no structured JSON into chat.

## Download

- `AgentDesk-0.20.1-x64.zip`
- Size: 157,847,214 bytes
- SHA-256: 8A1A9F5822D86A7CBBECB0688F76B28EC3CD801927873656E77A016E12AFB379

The release feed still checks GitHub latest, so v0.20.1 appears as the update for v0.20.0.
