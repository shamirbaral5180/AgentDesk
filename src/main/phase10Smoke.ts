import fs from 'node:fs'
import path from 'node:path'
import type { WebContents } from 'electron'
import {
  IPC_CHANNELS,
  type ApprovalEvent,
  type MeetingEvent,
  type MeetingPlan
} from '@shared/types'
import { getAppPaths } from './config/appPaths'
import { removeRecentProject } from './config/settings'
import { closeProject, openProject } from './project/projectService'
import { getTeam, setAgentModel } from './project/teamService'
import { addModel, createProvider, deleteProvider } from './providers/providerService'
import {
  approveMeetingPlan,
  createBuildMeeting,
  createMeeting,
  deleteMeeting,
  getMeeting,
  listMeetings,
  renameMeeting,
  startMeeting
} from './meetings/meetingService'
import { assessCommand } from './commands/commandPolicy'
import { persistPlan, setMeetingStatus } from './meetings/meetingStore'
import { decideApproval } from './approvals/approvalService'
import { killAllManagedProcesses } from './commands/commandRunner'
import { createPhase10MockServer, type Phase10MockServer, PHASE10_MOCK_KEY } from './phase10Mock'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fakeSender(events: MeetingEvent[], approvals: ApprovalEvent[]): WebContents {
  return {
    isDestroyed: () => false,
    send: (channel: string, event: MeetingEvent | ApprovalEvent) => {
      if (channel === IPC_CHANNELS.meetingEvent) {
        events.push(event as MeetingEvent)
        return
      }
      if (channel !== IPC_CHANNELS.approvalEvent) {
        return
      }
      const approvalEvent = event as ApprovalEvent
      approvals.push(approvalEvent)
      if (approvalEvent.type === 'request') {
        decideApproval({
          approvalId: approvalEvent.approval.id,
          decision: 'once'
        })
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
    if (!('meetingId' in event) || event.meetingId !== meetingId) {
      continue
    }
    if (event.type === 'done' || event.type === 'cancelled' || event.type === 'error') {
      return event
    }
  }
  return null
}

async function waitForTerminal(
  events: MeetingEvent[],
  meetingId: string,
  timeoutMs = 90_000
): Promise<TerminalMeetingEvent> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const event = terminalMeetingEvent(events, meetingId)
    if (event) {
      return event
    }
    await delay(50)
  }
  throw new Error(`Timed out waiting for Build meeting ${meetingId}`)
}

function writeProject(root: string): void {
  fs.mkdirSync(path.join(root, 'frontend'), { recursive: true })
  fs.mkdirSync(path.join(root, 'backend'), { recursive: true })
  fs.mkdirSync(path.join(root, 'database'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'phase10-parallel-project',
        version: '1.0.0',
        private: true,
        scripts: { test: 'node -e "console.log(\\"phase10 tests ok\\")"' }
      },
      null,
      2
    ),
    'utf8'
  )
}

export async function runPhase10Smoke(): Promise<number> {
  const paths = getAppPaths()
  const projectRoot = path.join(paths.tmpDir, `phase10-smoke-${Date.now()}`)
  let mock: Phase10MockServer | null = null
  let providerId: string | null = null

  try {
    writeProject(projectRoot)
    openProject(projectRoot)
    mock = await createPhase10MockServer()
    const provider = createProvider({
      type: 'custom',
      name: 'Parallel Lab',
      baseUrl: mock.baseUrl,
      apiKey: PHASE10_MOCK_KEY
    })
    providerId = provider.provider.id
    const model = addModel({
      providerId,
      modelId: 'phase10-chat',
      displayName: 'Parallel Lab Model',
      contextWindow: 128_000,
      maxOutputTokens: 8192,
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

    const planMeeting = createMeeting({
      goal: 'Build four independent slices in parallel and coordinate one shared request.',
      agentIds: ['frontend', 'backend', 'database', 'qa', 'devops'],
      mode: 'plan'
    })
    const plan: MeetingPlan = {
      summary: 'Four parallel slices plus one shared database request.',
      approach:
        'Run frontend, backend, database, and devops slices in parallel. Backend requests a shared contract from database and waits.',
      tasks: [
        {
          title: 'Frontend shell',
          description: 'Build the frontend shell.',
          assigneeAgentId: 'frontend',
          acceptanceCriteria: 'The frontend file exists.',
          fileGlobs: ['frontend/**'],
          dependsOn: [],
          priority: 2
        },
        {
          title: 'Backend API',
          description: 'Build the backend API and request the shared contract.',
          assigneeAgentId: 'backend',
          acceptanceCriteria: 'The backend files exist and the shared contract is used.',
          fileGlobs: ['backend/**'],
          dependsOn: [],
          priority: 2
        },
        {
          title: 'Database layer',
          description: 'Build the database layer and the shared contract on request.',
          assigneeAgentId: 'database',
          acceptanceCriteria: 'The database files and shared contract exist.',
          fileGlobs: ['database/**'],
          dependsOn: [],
          priority: 2
        },
        {
          title: 'Docs and CI',
          description: 'Write docs and CI notes.',
          assigneeAgentId: 'devops',
          acceptanceCriteria: 'The docs file exists.',
          fileGlobs: ['docs/**'],
          dependsOn: [],
          priority: 2
        }
      ],
      decisions: [],
      fileClaims: [],
      risks: [],
      acceptanceCriteria: ['All four slices and the shared contract are complete.'],
      generatedAt: Date.now(),
      fallback: false
    }
    persistPlan({
      meetingId: planMeeting.meeting.id,
      plan,
      taskIdsByTitle: new Map()
    })
    setMeetingStatus({
      meetingId: planMeeting.meeting.id,
      status: 'completed',
      stopReason: 'completed',
      started: true,
      ended: true
    })
    approveMeetingPlan(planMeeting.meeting.id)

    const build = createBuildMeeting({ planMeetingId: planMeeting.meeting.id })
    const events: MeetingEvent[] = []
    const approvals: ApprovalEvent[] = []
    startMeeting(fakeSender(events, approvals), build.meeting.id)
    const terminal = await waitForTerminal(events, build.meeting.id)
    if (terminal.type !== 'done') {
      throw new Error(
        terminal.type === 'error' ? terminal.message : 'The parallel Build was cancelled'
      )
    }

    const detail = getMeeting(build.meeting.id)
    if (detail.meeting.status !== 'completed') {
      throw new Error(`Expected completed Build, got ${detail.meeting.status}`)
    }
    const blocked = detail.tasks.filter((task) => task.status === 'blocked')
    if (blocked.length > 0) {
      throw new Error(`Blocked tasks: ${blocked.map((task) => task.title).join(', ')}`)
    }
    const requestTask = detail.tasks.find((task) => task.requestKind === 'request')
    if (!requestTask) {
      throw new Error('The shared request task was not created')
    }
    if (requestTask.status !== 'done') {
      throw new Error(`The shared request task is ${requestTask.status}`)
    }
    const backendTask = detail.tasks.find((task) => task.title === 'Backend API')
    if (!backendTask || backendTask.status !== 'done') {
      throw new Error('The waiting backend task did not resume and finish')
    }
    if (!detail.activity.some((event) => event.type === 'waiting')) {
      throw new Error('No waiting event was recorded')
    }
    if (!detail.messages.some((message) => message.kind === 'request')) {
      throw new Error('No team request message was posted')
    }
    if (detail.todos.length === 0) {
      throw new Error('Agents did not persist personal todos')
    }
    if (!mock.sawRequest || mock.maxConcurrentBuilds < 3) {
      throw new Error(
        `Expected at least 3 parallel build turns and a request; saw ${mock.maxConcurrentBuilds} and request=${mock.sawRequest}`
      )
    }
    for (const relative of [
      'frontend/generated.ts',
      'backend/generated.ts',
      'database/generated.ts',
      'docs/generated.ts',
      'backend/contract.ts'
    ]) {
      if (!fs.existsSync(path.join(projectRoot, relative))) {
        throw new Error(`Expected parallel build file: ${relative}`)
      }
    }

    const dockerApproval = assessCommand({
      command: 'docker build -t phase10 .',
      projectRoot,
      cwdOutsideProject: false
    })
    if (!dockerApproval.requiresApproval) {
      throw new Error('Docker builds must require Boss approval')
    }
    const temporary = createMeeting({
      goal: 'Temporary session for rename and delete coverage.',
      agentIds: ['frontend'],
      mode: 'plan'
    })
    const renamed = renameMeeting(temporary.meeting.id, 'Renamed temporary session')
    if (renamed.title !== 'Renamed temporary session') {
      throw new Error('Session rename did not persist')
    }
    deleteMeeting(temporary.meeting.id)
    if (listMeetings().some((meeting) => meeting.id === temporary.meeting.id)) {
      throw new Error('Session delete did not remove the meeting')
    }

    const result = {
      ok: true,
      providerId,
      sessionRenameDelete: true,
      dockerApproval: true,
      planMeetingId: planMeeting.meeting.id,
      buildMeetingId: build.meeting.id,
      tasks: detail.tasks.length,
      tasksDone: detail.tasks.filter((task) => task.status === 'done').length,
      requestTaskId: requestTask.id,
      requestFrom: requestTask.requestedByAgentId,
      maxConcurrentBuilds: mock.maxConcurrentBuilds,
      sawRequest: mock.sawRequest,
      sawTodo: mock.sawTodo,
      todos: detail.todos.length,
      waitingEvents: detail.activity.filter((event) => event.type === 'waiting').length,
      messages: detail.messages.length,
      files: mock.writePaths
    }
    console.log(`PHASE10_SMOKE_RESULT ${JSON.stringify(result)}`)
    return 0
  } catch (error) {
    console.error(
      `PHASE10_SMOKE_FAILED ${error instanceof Error ? error.message : String(error)}`
    )
    return 1
  } finally {
    killAllManagedProcesses()
    if (providerId) {
      try {
        deleteProvider(providerId)
      } catch {
        // ignore cleanup failures
      }
    }
    if (mock) {
      await mock.close()
    }
    try {
      removeRecentProject(projectRoot)
      closeProject()
    } catch {
      // ignore cleanup failures
    }
    fs.rmSync(projectRoot, { recursive: true, force: true })
  }
}

