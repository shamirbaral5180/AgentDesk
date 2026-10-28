import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { WebContents } from 'electron'
import {
  IPC_CHANNELS,
  type MeetingEvent
} from '@shared/types'
import { getAppPaths } from './config/appPaths'
import { removeRecentProject } from './config/settings'
import { closeProject, openProject } from './project/projectService'
import { getTeam, setAgentModel, updateAgent, addAgent, deleteAgent } from './project/teamService'
import {
  addModel,
  createProvider,
  deleteProvider
} from './providers/providerService'
import {
  approveMeetingPlan,
  createMeeting,
  getMeeting,
  sendDirectMeetingMessage,
  startMeeting,
  stopMeeting
} from './meetings/meetingService'
import { killAllManagedProcesses } from './commands/commandRunner'
import {
  createPhase6MockServer,
  type Phase6MockServer,
  PHASE6_MOCK_KEY
} from './phase6Mock'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fakeSender(events: MeetingEvent[]): WebContents {
  return {
    isDestroyed: () => false,
    send: (channel: string, event: MeetingEvent) => {
      if (channel === IPC_CHANNELS.meetingEvent) {
        events.push(event)
      }
    }
  } as unknown as WebContents
}

type TerminalMeetingEvent = Extract<MeetingEvent, { type: 'done' | 'cancelled' | 'error' }>

function terminalMeetingEvent(
  events: MeetingEvent[],
  meetingId: string
): TerminalMeetingEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'meeting-start' || event.type === 'meeting-update') {
      continue
    }
    if (
      event.meetingId === meetingId &&
      (event.type === 'done' || event.type === 'cancelled' || event.type === 'error')
    ) {
      return event
    }
  }
  return null
}

async function waitForMeetingTerminal(
  events: MeetingEvent[],
  meetingId: string,
  timeoutMs = 40_000
): Promise<TerminalMeetingEvent> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const event = terminalMeetingEvent(events, meetingId)
    if (event) {
      return event
    }
    await delay(50)
  }
  throw new Error(`Timed out waiting for meeting ${meetingId}`)
}

function writeProject(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'phase6-plan-project',
        version: '1.0.0',
        private: true,
        scripts: { test: 'node -e "console.log(\\"phase6 tests ok\\")"' }
      },
      null,
      2
    ),
    'utf8'
  )
  fs.writeFileSync(
    path.join(root, 'src', 'App.tsx'),
    'export function App() { return null }\n',
    'utf8'
  )
  fs.writeFileSync(
    path.join(root, 'src', 'styles.css'),
    ':root { color-scheme: dark; }\n',
    'utf8'
  )
}

function treeSnapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {}
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) {
      break
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.agentdesk') {
        continue
      }
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(absolute)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      result[relative] = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
    }
  }
  return result
}

export async function runPhase6Smoke(): Promise<number> {
  const paths = getAppPaths()
  const projectRoot = path.join(paths.tmpDir, `phase6-smoke-${Date.now()}`)
  let mock: Phase6MockServer | null = null
  let providerId: string | null = null

  try {
    writeProject(projectRoot)
    openProject(projectRoot)
    mock = await createPhase6MockServer()
    const provider = createProvider({
      type: 'custom',
      name: 'Plan Room Lab',
      baseUrl: mock.baseUrl,
      apiKey: PHASE6_MOCK_KEY
    })
    providerId = provider.provider.id
    const model = addModel({
      providerId,
      modelId: 'phase6-chat',
      displayName: 'Plan Room Model',
      contextWindow: 128_000,
      maxOutputTokens: 4096,
      supportsTools: true,
      supportsVision: false,
      inputPricePerMillion: 0.2,
      outputPricePerMillion: 0.8
    })
    const team = getTeam()
    if (!team) {
      throw new Error('The default team did not load')
    }
    for (const agent of team.agents) {
      setAgentModel({
        agentId: agent.id,
        modelRecordId: model.model.id,
        temperature: 0.2
      })
    }

    const before = treeSnapshot(projectRoot)
    const meeting = createMeeting({
      goal: 'Plan a focused first-run onboarding slice with clear ownership.',
      agentIds: ['frontend', 'backend', 'database', 'qa', 'devops'],
      mode: 'plan'
    })
    if (meeting.meeting.participants.length !== 6) {
      throw new Error('The meeting did not include all six participants')
    }

    const events: MeetingEvent[] = []
    startMeeting(fakeSender(events), meeting.meeting.id)
    const terminal = await waitForMeetingTerminal(events, meeting.meeting.id)
    if (terminal.type !== 'done') {
      throw new Error(
        terminal.type === 'error'
          ? terminal.message
          : 'The Phase 6 plan meeting was cancelled'
      )
    }

    const completed = getMeeting(meeting.meeting.id)
    if (completed.meeting.status !== 'completed') {
      throw new Error(`Expected completed meeting, got ${completed.meeting.status}`)
    }
    if (!completed.plan) {
      throw new Error('The meeting did not persist a plan')
    }
    if (completed.plan.fallback) {
      throw new Error('The structured plan unexpectedly used the fallback')
    }
    if (completed.tasks.length < 3) {
      throw new Error('The meeting did not persist the planned tasks')
    }
    if (completed.decisions.length < 1) {
      throw new Error('The meeting did not persist a decision')
    }
    if (completed.fileClaims.length < 2) {
      throw new Error('The meeting did not persist file claims')
    }
    const intakes = completed.messages.filter((message) => message.kind === 'intake')
    const discussions = completed.messages.filter((message) => message.kind === 'discussion')
    if (intakes.length !== 6) {
      throw new Error(`Expected six intake cards, got ${intakes.length}`)
    }
    if (intakes.some((message) => !message.metadata?.card)) {
      throw new Error('An intake card was not structured metadata')
    }
    if (discussions.length !== 6) {
      throw new Error(`Expected six discussion turns, got ${discussions.length}`)
    }
    if (completed.meeting.usage.turns < 13) {
      throw new Error('Meeting usage did not record every turn')
    }
    if (
      completed.meeting.usage.inputTokens + completed.meeting.usage.outputTokens <=
      0
    ) {
      throw new Error('Meeting usage did not record tokens')
    }
    if (completed.meeting.usage.costUsd <= 0) {
      throw new Error('Meeting usage did not record cost')
    }
    if (completed.meeting.stopReason !== 'completed') {
      throw new Error('The completed meeting did not record its stop reason')
    }
    if (!mock.sawMeetingPrompt || !mock.sawIntakePrompt || !mock.sawDiscussionPrompt || !mock.sawPlanPrompt) {
      throw new Error('The meeting prompts were not sent through the expected phases')
    }
    if (mock.sawWriteTool || mock.sawCommandTool) {
      throw new Error('Plan mode offered write or command tools')
    }
    const after = treeSnapshot(projectRoot)
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('The read-only meeting changed repository files')
    }

    const approved = approveMeetingPlan(meeting.meeting.id)
    if (!approved.meeting.planApprovedAt) {
      throw new Error('Approving the plan did not persist')
    }

    updateAgent({ id: 'qa', tagline: 'Tests behavior, reviews code, and verifies the plan.' })
    const withCustom = addAgent({
      name: 'Accessibility Reviewer',
      roleKey: 'accessibility',
      tagline: 'Checks focus, semantics, and contrast.',
      color: '#f2a65a'
    })
    const custom = withCustom.team.agents.find(
      (agent) => agent.name === 'Accessibility Reviewer'
    )
    if (!custom) {
      throw new Error('Adding a custom agent did not persist')
    }
    const afterDelete = deleteAgent(custom.id)
    if (afterDelete.team.agents.some((agent) => agent.id === custom.id)) {
      throw new Error('Deleting the custom agent did not persist')
    }

    closeProject()
    openProject(projectRoot)
    const persisted = getMeeting(meeting.meeting.id)
    if (
      !persisted.plan ||
      persisted.meeting.status !== 'completed' ||
      persisted.tasks.length !== completed.tasks.length ||
      persisted.meeting.planApprovedAt !== approved.meeting.planApprovedAt
    ) {
      throw new Error('The meeting did not survive a project reopen')
    }

    const directEvents: MeetingEvent[] = []
    sendDirectMeetingMessage(fakeSender(directEvents), {
      meetingId: meeting.meeting.id,
      agentId: 'frontend',
      text: 'Which file should you inspect first when Build starts?'
    })
    const directTerminal = await waitForMeetingTerminal(
      directEvents,
      meeting.meeting.id,
      20_000
    )
    if (directTerminal.type !== 'done') {
      throw new Error(
        directTerminal.type === 'error'
          ? directTerminal.message
          : 'The direct follow-up was cancelled'
      )
    }
    const afterDirect = getMeeting(meeting.meeting.id)
    const bossDirect = afterDirect.messages.find(
      (message) => message.kind === 'direct' && message.senderType === 'boss'
    )
    const agentDirect = afterDirect.messages.find(
      (message) => message.kind === 'direct' && message.senderType === 'agent'
    )
    if (!bossDirect || !agentDirect || bossDirect.targetAgentId !== 'frontend') {
      throw new Error('The direct message did not persist with its target')
    }
    if (!agentDirect.content.trim()) {
      throw new Error('The direct message did not produce an agent response')
    }

    const stopMeetingRecord = createMeeting({
      goal: 'Stop test: plan a tiny documentation change.',
      agentIds: ['frontend', 'backend'],
      mode: 'plan'
    })
    const stopEvents: MeetingEvent[] = []
    startMeeting(fakeSender(stopEvents), stopMeetingRecord.meeting.id)
    await delay(140)
    stopMeeting(stopMeetingRecord.meeting.id)
    const stopTerminal = await waitForMeetingTerminal(
      stopEvents,
      stopMeetingRecord.meeting.id,
      20_000
    )
    if (stopTerminal.type !== 'cancelled') {
      throw new Error(
        stopTerminal.type === 'error'
          ? stopTerminal.message
          : 'Stopping the second meeting did not cancel it'
      )
    }
    const stopped = getMeeting(stopMeetingRecord.meeting.id)
    if (stopped.meeting.status !== 'stopped' || stopped.meeting.stopReason !== 'user') {
      throw new Error('The stopped meeting did not record the user stop reason')
    }

    console.log(
      `PHASE6_SMOKE_RESULT ${JSON.stringify({
        ok: true,
        providerId,
        meetingId: meeting.meeting.id,
        participants: completed.meeting.participants.map((participant) => participant.name),
        intakes: intakes.length,
        discussions: discussions.length,
        tasks: completed.tasks.length,
        decisions: completed.decisions.length,
        fileClaims: completed.fileClaims.length,
        turns: completed.meeting.usage.turns,
        tokens:
          completed.meeting.usage.inputTokens + completed.meeting.usage.outputTokens,
        costUsd: completed.meeting.usage.costUsd,
        planFallback: completed.plan.fallback,
        planApprovedAt: approved.meeting.planApprovedAt,
        repoUnchanged: true,
        writeToolsOffered: mock.sawWriteTool,
        commandToolsOffered: mock.sawCommandTool,
        persistedAfterReopen: true,
        directMessages: afterDirect.messages.filter((message) => message.kind === 'direct').length,
        customAgentLifecycle: true,
        stoppedStatus: stopped.meeting.status,
        stoppedReason: stopped.meeting.stopReason
      })}`
    )
    return 0
  } catch (error) {
    console.error('PHASE6_SMOKE_FAILED', error)
    return 1
  } finally {
    if (providerId) {
      try {
        deleteProvider(providerId)
      } catch {
        console.error('PHASE6_SMOKE_CLEANUP_PROVIDER_FAILED')
      }
    }
    killAllManagedProcesses()
    closeProject()
    removeRecentProject(projectRoot)
    if (mock) {
      await mock.close()
    }
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (cleanupError) {
      console.error('PHASE6_SMOKE_CLEANUP_FAILED', cleanupError)
    }
  }
}
