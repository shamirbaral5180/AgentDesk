# AgentDesk 0.22.0

This release adds specialist skills to every agent, animated working/stopped indicators, and fixes the duplicate-request loop seen in the Demo Test history.

## What changed

- **Specialist skills for every agent.** Agents now carry assigned skills inspired by public engineering practice from Google, Cloudflare, OWASP, and web.dev:
  - Coordinator: technical coordination and decision records, Google-style code review.
  - Frontend: design system quality, web performance/Core Web Vitals, accessibility, testing strategy.
  - Backend: Google-style API design, Cloudflare-style reliability, secure by default, testing strategy.
  - Database: schema and migrations, reliability, secure by default.
  - QA: testing strategy, secure by default, code review, reliability.
  - DevOps: delivery and observability, reliability, secure by default.
- **Skills are in the Build prompt.** Each agent sees its skill summaries and can call `load_skill` for the full checklist. Existing projects automatically receive default role skills when their team file has none.
- **Animated agent status.** Agent dots pulse while working, blink while waiting, stay steady when ready, and appear grey when stopped. Reduced-motion preferences disable the animation.
- **Duplicate request fix.** `request_from_agent` no longer creates duplicate tasks with the same title and owner. Repeated requests reuse the existing task. The Coordinator only has one open request task at a time, preventing the pile-up seen in the Demo Test run.
- **Commit/audit guidance.** Build prompts now tell agents to run the real command and report its output for audit, verification, and commit tasks instead of only narrating what they found.
- **Skills visible in the UI.** The team list shows the skill count and a tooltip with assigned skills; Settings, Team shows the assigned skills for the selected agent.
- **Continuous Build and Coordinator questions remain.** No meeting time, turn, message, token, or cost stop, no fixed review cap, and question cards with options for genuine blockers.

## Why this release exists

The latest Demo Test build still created duplicate request tasks. Frontend requested an infrastructure task that was already done, QA repeatedly asked the Coordinator to commit code, and the Coordinator created another copy of work already complete. It also kept retrying tasks that produced no file or command. This release prevents exact duplicate requests, limits the Coordinator to one open request, and gives agents concrete skills and instructions for audit/commit tasks.

## Verification

- `typecheck` passes.
- `smoke:phase10` covers four parallel builds, request/wait/resume, question cards, continuous reviews, host runtime detection, specialist skills in the prompt, and duplicate request prevention.
- Packaged smoke matrix and desk screenshot are rerun for the release zip.

## Download

- `AgentDesk-0.22.0-x64.zip`
- Size: 157,857,346 bytes
- SHA-256: 3F447697EA514E199ED6D7E438C051CAF6C52F075B0673A9D0B2757083A5540B

The update check will show v0.22.0 as the latest release.
