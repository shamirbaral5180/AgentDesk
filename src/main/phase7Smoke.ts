import fs from 'node:fs'
import path from 'node:path'
import type { WebContents } from 'electron'
import {
  IPC_CHANNELS,
  type ApprovalEvent,
  type MeetingEvent
} from '@shared/types'
import { getAppPaths } from './config/appPaths'
import { removeRecentProject } from './config/settings'
import { closeProject, openProject } from './project/projectService'
import { getTeam, setAgentModel } from './project/teamService'
import {
  addModel,
  createProvider,
  deleteProvider,
  updateProvider
} from './providers/providerService'
import {
  approveMeetingPlan,
  createBuildMeeting,
  createMeeting,
  getMeeting,
  pauseMeeting,
  queueMeetingInterrupt,
  startMeeting,
  stopMeeting
} from './meetings/meetingService'
import { activeMeetingClaims } from './meetings/meetingStore'
import { revertTaskChanges } from './changes/changeService'
import { decideApproval } from './approvals/approvalService'
import { killAllManagedProcesses } from './commands/commandRunner'
import { createPhase6MockServer, type Phase6MockServer, PHASE6_MOCK_KEY } from './phase6Mock'
import { createPhase7MockServer, type Phase7MockServer } from './phase7Mock'

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
  timeoutMs = 60_000
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
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'phase7-build-project',
        version: '1.0.0',
        private: true,
        scripts: { test: 'node -e "console.log(\\"phase7 tests ok\\")"' }
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

export async function runPhase7Smoke(): Promise<number> {
  const paths = getAppPaths()
  const projectRoot = path.join(paths.tmpDir, `phase7-smoke-${Date.now()}`)
  let planMock: Phase6MockServer | null = null
  let buildMock: Phase7MockServer | null = null
  let providerId: string | null = null

  try {
    writeProject(projectRoot)
    openProject(projectRoot)
    planMock = await createPhase6MockServer()
    const provider = createProvider({
      type: 'custom',
      name: 'Build Lab',
      baseUrl: planMock.baseUrl,
      apiKey: PHASE6_MOCK_KEY
    })
    providerId = provider.provider.id
    const model = addModel({
      providerId,
      modelId: 'phase6-chat',
      displayName: 'Build Lab Model',
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

    const plan = createMeeting({
      goal: 'Build a focused onboarding slice with a QA gate.',
      agentIds: ['frontend', 'backend', 'database', 'qa', 'devops'],
      mode: 'plan'
    })
    const planEvents: MeetingEvent[] = []
    const planApprovals: ApprovalEvent[] = []
    startMeeting(fakeSender(planEvents, planApprovals), plan.meeting.id)
    const planTerminal = await waitForMeetingTerminal(planEvents, plan.meeting.id)
    if (planTerminal.type !== 'done') {
      throw new Error(
        planTerminal.type === 'error'
          ? planTerminal.message
          : 'The Phase 7 plan seed was cancelled'
      )
    }
    const approved = approveMeetingPlan(plan.meeting.id)
    if (!approved.meeting.planApprovedAt) {
      throw new Error('The Build seed plan was not approved')
    }

    buildMock = await createPhase7MockServer()
    updateProvider({
      id: providerId,
      baseUrl: buildMock.baseUrl
    })

    const build = createBuildMeeting({ planMeetingId: plan.meeting.id })
    if (build.meeting.mode !== 'build') {
      throw new Error('createBuildMeeting did not create a Build meeting')
    }
    if (build.meeting.parentMeetingId !== plan.meeting.id) {
      throw new Error('The Build meeting was not linked to its parent Plan meeting')
    }
    if (build.tasks.length < 3) {
      throw new Error('The Build meeting did not inherit the planned tasks')
    }

    const buildEvents: MeetingEvent[] = []
    const buildApprovals: ApprovalEvent[] = []
    startMeeting(fakeSender(buildEvents, buildApprovals), build.meeting.id)
    const buildTerminal = await waitForMeetingTerminal(buildEvents, build.meeting.id)
    if (buildTerminal.type !== 'done') {
      throw new Error(
        buildTerminal.type === 'error'
          ? buildTerminal.message
          : 'The Phase 7 Build meeting was cancelled'
      )
    }

    const completed = getMeeting(build.meeting.id)
    if (completed.meeting.status !== 'completed') {
      throw new Error(`Expected completed Build, got ${completed.meeting.status}`)
    }
    if (!completed.finalReport) {
      throw new Error('The Build meeting did not persist a final report')
    }
    if (completed.finalReport.partial) {
      throw new Error('The completed Build report was marked partial')
    }
    if (completed.finalReport.filesChanged.length === 0) {
      throw new Error('The final report has no changed files')
    }
    if (completed.finalReport.commands.length === 0) {
      throw new Error('The final report has no commands')
    }
    if (completed.finalReport.approvals.length === 0) {
      throw new Error('The final report has no approval records')
    }
    if (completed.finalReport.tests.length === 0) {
      throw new Error('The final report has no QA test records')
    }
    if (completed.tasks.some((task) => task.status !== 'done')) {
      throw new Error('Not every Build task reached done')
    }
    if (completed.activity.every((event) => event.type !== 'changes-requested')) {
      throw new Error('The QA changes-requested cycle was not recorded')
    }
    if (completed.activity.every((event) => event.type !== 'approved')) {
      throw new Error('The QA approval was not recorded')
    }
    if (completed.meeting.usage.turns < 8) {
      throw new Error('Build usage did not record every turn')
    }
    if (activeMeetingClaims(build.meeting.id).length !== 0) {
      throw new Error('Build left active file claims behind')
    }
    if (!buildMock.sawBuildPrompt || !buildMock.sawReviewPrompt || !buildMock.sawReportPrompt) {
      throw new Error('The Build phases did not reach the model')
    }
    if (!buildMock.sawActiveClaim) {
      throw new Error('The Build prompt did not include an active file claim')
    }
    if (buildMock.reviewRequests < 4) {
      throw new Error('The QA review loop did not run all cycles')
    }
    if (buildApprovals.length === 0) {
      throw new Error('Build did not route a risky command through approval')
    }
    for (const writePath of buildMock.writePaths) {
      if (!completed.finalReport.filesChanged.some((file) => file.path === writePath)) {
        throw new Error(`Expected changed file missing from report: ${writePath}`)
      }
    }

    const firstTask = completed.tasks[0]
    const reverted = revertTaskChanges(completed.meeting.sessionId, firstTask.id)
    if (reverted.reverted === 0) {
      throw new Error('Task-level revert did not revert any change')
    }

    closeProject()
    openProject(projectRoot)
    const persisted = getMeeting(build.meeting.id)
    if (
      !persisted.finalReport ||
      persisted.tasks.length !== completed.tasks.length ||
      persisted.meeting.status !== 'completed'
    ) {
      throw new Error('The Build meeting did not survive a project reopen')
    }

    const stopBuild = createBuildMeeting({ planMeetingId: plan.meeting.id })
    const stopEvents: MeetingEvent[] = []
    const stopApprovals: ApprovalEvent[] = []
    startMeeting(fakeSender(stopEvents, stopApprovals), stopBuild.meeting.id)
    await delay(120)
    queueMeetingInterrupt(fakeSender(stopEvents, stopApprovals), {
      meetingId: stopBuild.meeting.id,
      text: 'Boss update: keep the change narrow and report the partial result.',
      mode: 'queue'
    })
    stopMeeting(stopBuild.meeting.id)
    const stopTerminal = await waitForMeetingTerminal(stopEvents, stopBuild.meeting.id)
    if (stopTerminal.type !== 'done') {
      throw new Error(
        stopTerminal.type === 'error'
          ? stopTerminal.message
          : 'The interrupted Build did not produce a final report'
      )
    }
    const stopped = getMeeting(stopBuild.meeting.id)
    if (
      stopped.meeting.status !== 'stopped' ||
      stopped.meeting.stopReason !== 'user' ||
      !stopped.finalReport ||
      !stopped.finalReport.partial
    ) {
      throw new Error('The stopped Build did not record a partial final report')
    }
    if (!stopped.messages.some((message) => message.kind === 'interrupt')) {
      throw new Error('The Boss interrupt was not persisted')
    }

    const immediateBuild = createBuildMeeting({ planMeetingId: plan.meeting.id })
    const immediateEvents: MeetingEvent[] = []
    const immediateApprovals: ApprovalEvent[] = []
    startMeeting(fakeSender(immediateEvents, immediateApprovals), immediateBuild.meeting.id)
    await delay(120)
    queueMeetingInterrupt(fakeSender(immediateEvents, immediateApprovals), {
      meetingId: immediateBuild.meeting.id,
      text: 'Stop at the next boundary and report.',
      mode: 'immediate'
    })
    const immediateTerminal = await waitForMeetingTerminal(
      immediateEvents,
      immediateBuild.meeting.id
    )
    if (immediateTerminal.type !== 'done') {
      throw new Error(
        immediateTerminal.type === 'error'
          ? immediateTerminal.message
          : 'The immediate Build interrupt did not finalize'
      )
    }
    const immediate = getMeeting(immediateBuild.meeting.id)
    if (
      immediate.meeting.status !== 'stopped' ||
      immediate.meeting.stopReason !== 'paused' ||
      !immediate.finalReport?.partial
    ) {
      throw new Error('The immediate Build interrupt did not produce a partial report')
    }

    const pauseBuildRecord = createBuildMeeting({ planMeetingId: plan.meeting.id })
    const pauseEvents: MeetingEvent[] = []
    const pauseApprovals: ApprovalEvent[] = []
    startMeeting(fakeSender(pauseEvents, pauseApprovals), pauseBuildRecord.meeting.id)
    await delay(140)
    pauseMeeting(pauseBuildRecord.meeting.id)
    const pauseTerminal = await waitForMeetingTerminal(pauseEvents, pauseBuildRecord.meeting.id)
    if (pauseTerminal.type !== 'done') {
      throw new Error(
        pauseTerminal.type === 'error'
          ? pauseTerminal.message
          : 'The paused Build did not produce a final report'
      )
    }
    const paused = getMeeting(pauseBuildRecord.meeting.id)
    if (
      paused.meeting.status !== 'stopped' ||
      paused.meeting.stopReason !== 'paused' ||
      !paused.finalReport?.partial
    ) {
      throw new Error('The paused Build did not record a partial report')
    }
    const resumeEvents: MeetingEvent[] = []
    const resumeApprovals: ApprovalEvent[] = []
    startMeeting(fakeSender(resumeEvents, resumeApprovals), pauseBuildRecord.meeting.id)
    const resumeTerminal = await waitForMeetingTerminal(resumeEvents, pauseBuildRecord.meeting.id)
    if (resumeTerminal.type !== 'done') {
      throw new Error(
        resumeTerminal.type === 'error'
          ? resumeTerminal.message
          : 'The resumed Build did not finalize'
      )
    }
    const resumed = getMeeting(pauseBuildRecord.meeting.id)
    if (resumed.meeting.status !== 'completed' || !resumed.finalReport) {
      throw new Error('The resumed Build did not complete')
    }


    console.log(
      `PHASE7_SMOKE_RESULT ${JSON.stringify({
        ok: true,
        providerId,
        planMeetingId: plan.meeting.id,
        buildMeetingId: build.meeting.id,
        tasks: completed.tasks.length,
        tasksDone: completed.tasks.filter((task) => task.status === 'done').length,
        turns: completed.meeting.usage.turns,
        filesChanged: completed.finalReport.filesChanged.length,
        commands: completed.finalReport.commands.length,
        approvals: completed.finalReport.approvals.length,
        tests: completed.finalReport.tests.length,
        reviewRequests: buildMock.reviewRequests,
        reviewsRecorded: completed.activity.filter(
          (event) => event.type === 'approved' || event.type === 'changes-requested'
        ).length,
        activeClaimsAfterFinish: activeMeetingClaims(build.meeting.id).length,
        revertedChanges: reverted.reverted,
        persistedAfterReopen: true,
        stoppedReason: stopped.meeting.stopReason,
        stoppedPartial: stopped.finalReport?.partial,
        immediateReason: immediate.meeting.stopReason,
        immediatePartial: immediate.finalReport?.partial,
        pausedReason: paused.meeting.stopReason,
        pausedPartial: paused.finalReport?.partial,
        resumedStatus: resumed.meeting.status,
        resumedFiles: resumed.finalReport.filesChanged.length,
        resumedCommands: resumed.finalReport.commands.length,
        writePaths: buildMock.writePaths
      })}`
    )
    return 0
  } catch (error) {
    console.error('PHASE7_SMOKE_FAILED', error)
    return 1
  } finally {
    if (providerId) {
      try {
        deleteProvider(providerId)
      } catch {
        console.error('PHASE7_SMOKE_CLEANUP_PROVIDER_FAILED')
      }
    }
    killAllManagedProcesses()
    closeProject()
    removeRecentProject(projectRoot)
    if (planMock) {
      await planMock.close()
    }
    if (buildMock) {
      await buildMock.close()
    }
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (cleanupError) {
      console.error('PHASE7_SMOKE_CLEANUP_FAILED', cleanupError)
    }
  }
}
