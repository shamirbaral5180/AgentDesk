# AgentDesk 0.21.0

This release makes the team work continuously, asks you only when a real decision is needed, stops wasting time on hidden budgets, and makes the desk easier to follow.

## What changed

- **Continuous Build.** Build no longer stops because of a meeting time, turn, message, token, or cost budget. It runs until the work is complete, you stop it, or a genuine no-progress error occurs. Reviews also have no fixed cycle cap.
- **No automatic "review limit" blocking.** The old two-cycle review block is gone. If QA and an implementer repeat the exact same issue, the Coordinator asks you with options instead of silently blocking the task.
- **Coordinator questions with options.** A new question card appears in the app, like the permission prompt. The Coordinator presents the problem and 2-6 concrete choices. The team waits for your answer, then continues.
- **Agents can escalate confusion.** Build agents have an `ask_boss` tool. If an agent is genuinely blocked by ambiguity, it asks through the Coordinator, with options. Routine confusion is posted to the team channel first.
- **Coordinator directs and reports.** The Coordinator now posts concrete directions to the affected agent and reports to you when Build starts, when an agent requests work, when a task waits, when QA asks for changes, when an agent fails, and when a part is completed.
- **Failures ask first.** A task failure no longer becomes a permanent block immediately. The Coordinator asks whether to retry, skip, or stop.
- **Host runtimes are reused.** Build prompts now detect Node.js, npm, Python, pip, Git, Docker, .NET, and Java on the host. Agents use those host runtimes and are told not to install language runtimes inside the project. Project dependencies can still be installed normally.
- **Better UX.** The right pane now has Activity, Team, Tasks, and Flows tabs; chat text is larger; the header shows completed/total work; live activity shows each agent's current task, latest tool, and blocker.
- **Safer host actions.** Container builds/runs, installers such as winget/choco/scoop, outside-project paths, installs, downloads, deploys, pushes, and inline execution still require detailed Boss approval.
- **Model choice is unchanged.** Build still refuses to start when an assigned agent uses a model without tool support and names the agents to fix.

## Why this release exists

The Demo Test history showed that Build stopped with `stop_reason=budget` after only 137 seconds because it crossed the 300,000-token meeting budget. Two review cycles then blocked tasks permanently, which cascaded into other agents being marked blocked. This release removes those artificial stops and replaces them with explicit, user-directed decisions.

## Verification

- `typecheck` passes.
- `smoke`, `smoke:phase6`, `smoke:phase7`, `smoke:phase9`, and `smoke:phase10` pass.
- Phase 10 now covers continuous review cycles, the Coordinator question card flow, a Boss answer, and task resumption.
- Packaged clean-extraction checks cover phase 6, 7, 9, and 10 plus the desk screenshot.

## Download

- `AgentDesk-0.21.0-x64.zip`
- Size: 157,851,401 bytes
- SHA-256: 91AF602767DBEDC2201778D6B15207186F701D2E0902D3356FE217743A88E648

The update check will show v0.21.0 as the latest release.
