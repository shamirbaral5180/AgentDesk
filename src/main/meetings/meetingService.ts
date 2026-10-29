import type { WebContents } from 'electron'
import type {
  MeetingBuildCreateRequest,
  MeetingCreateRequest,
  MeetingDetail,
  MeetingDirectMessageRequest,
  MeetingInterruptRequest,
  MeetingSummary
} from '@shared/types'
import { loadSettings } from '../config/settings'
import { AppError } from '../errors'
import { getCurrentTeamConfig } from '../project/projectService'
import { assertMonthlyBudgetAvailable } from '../data/dataService'
import {
  approveMeetingPlanRecord,
  createBuildMeetingRecord,
  createMeetingRecord,
  deleteMeetingRecord,
  getMeetingDetail,
  listMeetingSummaries,
  meetingSummary,
  releaseAllActiveClaims,
  renameMeetingRecord,
  setMeetingStatus
} from './meetingStore'
import { cancelApprovalsForSession } from '../approvals/approvalService'
import { markMeetingLeaseStopped } from '../recovery/runLeaseService'
import {
  cancelAllMeetingRuns,
  isMeetingActive,
  sendDirectEngine,
  startMeetingEngine,
  stopMeetingEngine
} from './meetingEngine'
import {
  cancelAllBuildRuns,
  isBuildActive,
  queueBuildInterrupt,
  startBuildEngine,
  stopBuildEngine
} from './buildEngine'

function ensureModelsReady(agentIds: string[]): void {
  const team = getCurrentTeamConfig()
  if (!team) {
    throw new AppError('NO_TEAM', 'The project team configuration could not be loaded.')
  }
  const settings = loadSettings()
  const missing: string[] = []
  for (const agentId of agentIds) {
    const agent = team.agents.find((entry) => entry.id === agentId)
    if (!agent) {
      throw new AppError('AGENT_NOT_FOUND', `Agent ${agentId} does not exist.`)
    }
    if (!agent.enabled) {
      throw new AppError(
        'AGENT_DISABLED',
        `${agent.name} is disabled. Enable it in Settings, Team first.`
      )
    }
    if (!agent.model) {
      missing.push(agent.name)
      continue
    }
    const model = settings.models.find(
      (entry) =>
        entry.providerId === agent.model?.providerConfigId &&
        entry.modelId === agent.model?.modelId
    )
    if (!model) {
      missing.push(agent.name)
      continue
    }
    const provider = settings.providers.find((entry) => entry.id === model.providerId)
    if (!provider || !provider.enabled) {
      missing.push(agent.name)
    }
  }
  if (missing.length > 0) {
    throw new AppError(
      'AGENT_MODEL_MISSING',
      `Assign an enabled provider model to: ${missing.join(', ')}.`
    )
  }
}

export function listMeetings(): MeetingSummary[] {
  return listMeetingSummaries()
}

export function getMeeting(meetingId: string): MeetingDetail {
  return getMeetingDetail(meetingId)
}

export function renameMeeting(meetingId: string, title: string): MeetingSummary {
  return renameMeetingRecord(meetingId, title)
}

export function deleteMeeting(meetingId: string): void {
  if (isBuildActive(meetingId) || isMeetingActive(meetingId)) {
    throw new AppError('MEETING_ACTIVE', 'Stop this run before deleting its session.')
  }
  deleteMeetingRecord(meetingId)
}

export function createMeeting(request: MeetingCreateRequest): MeetingDetail {
  assertMonthlyBudgetAvailable()
  const team = getCurrentTeamConfig()
  if (!team) {
    throw new AppError('NO_TEAM', 'The project team configuration could not be loaded.')
  }
  const coordinator = team.agents.find(
    (agent) => agent.roleKey === 'coordinator' && agent.enabled
  )
  if (!coordinator) {
    throw new AppError(
      'COORDINATOR_MISSING',
      'Enable the Coordinator & Architect agent before starting a meeting.'
    )
  }
  const goal = request.goal.trim()
  if (goal.length < 3) {
    throw new AppError('INVALID_MEETING_GOAL', 'Describe what the team should plan.')
  }
  const agentIds = [...new Set([...request.agentIds, coordinator.id])]
  ensureModelsReady(agentIds)
  return createMeetingRecord({
    goal,
    agentIds,
    mode: request.mode ?? 'plan'
  })
}

export function createBuildMeeting(request: MeetingBuildCreateRequest): MeetingDetail {
  const plan = getMeetingDetail(request.planMeetingId)
  return createBuildMeetingRecord({ plan })
}

export function startMeeting(sender: WebContents, meetingId: string): MeetingSummary {
  assertMonthlyBudgetAvailable()
  const detail = getMeetingDetail(meetingId)
  if (detail.meeting.mode === 'build') {
    return startBuildEngine(sender, meetingId)
  }
  if (
    detail.meeting.status !== 'draft' &&
    detail.meeting.status !== 'stopped' &&
    detail.meeting.status !== 'failed'
  ) {
    throw new AppError('MEETING_NOT_READY', 'This meeting has already run.')
  }
  return startMeetingEngine(sender, meetingId)
}

export function resumeMeeting(sender: WebContents, meetingId: string): MeetingSummary {
  assertMonthlyBudgetAvailable()
  const detail = getMeetingDetail(meetingId)
  if (detail.meeting.mode === 'build') {
    return startBuildEngine(sender, meetingId, { resume: true })
  }
  return startMeetingEngine(sender, meetingId, { resume: true })
}

export function markMeetingStopped(meetingId: string): MeetingSummary {
  const detail = getMeetingDetail(meetingId)
  releaseAllActiveClaims(meetingId)
  cancelApprovalsForSession(detail.meeting.sessionId)
  markMeetingLeaseStopped(meetingId)
  return setMeetingStatus({
    meetingId,
    status: 'stopped',
    stopReason: 'user',
    error: 'Marked stopped by the Boss during recovery.',
    ended: true
  })
}

export function stopMeeting(meetingId: string): MeetingSummary {
  const detail = getMeetingDetail(meetingId)
  if (
    detail.meeting.status === 'draft' ||
    detail.meeting.status === 'completed' ||
    detail.meeting.status === 'failed'
  ) {
    return detail.meeting
  }
  if (detail.meeting.mode === 'build') {
    return stopBuildEngine(meetingId, 'user')
  }
  return stopMeetingEngine(meetingId, 'user')
}

export function pauseMeeting(meetingId: string): MeetingSummary {
  const detail = getMeetingDetail(meetingId)
  if (detail.meeting.mode !== 'build') {
    return stopMeetingEngine(meetingId, 'paused')
  }
  return stopBuildEngine(meetingId, 'paused')
}

export function queueMeetingInterrupt(
  sender: WebContents,
  request: MeetingInterruptRequest
): Promise<MeetingSummary> {
  if (!request.text.trim()) {
    throw new AppError('EMPTY_MESSAGE', 'Write the interrupt first.')
  }
  return queueBuildInterrupt({
    sender,
    meetingId: request.meetingId,
    text: request.text.trim(),
    mode: request.mode
  })
}

export function sendDirectMeetingMessage(
  sender: WebContents,
  request: MeetingDirectMessageRequest
): MeetingSummary {
  if (!request.text.trim()) {
    throw new AppError('EMPTY_MESSAGE', 'Write a direct message first.')
  }
  return sendDirectEngine(sender, {
    meetingId: request.meetingId,
    agentId: request.agentId,
    text: request.text.trim()
  })
}

export function approveMeetingPlan(meetingId: string): MeetingDetail {
  const detail = getMeetingDetail(meetingId)
  if (!detail.plan) {
    throw new AppError('MEETING_PLAN_MISSING', 'The meeting has no plan to approve.')
  }
  if (detail.meeting.status !== 'completed') {
    throw new AppError('MEETING_NOT_COMPLETE', 'Wait for the plan meeting to finish first.')
  }
  return approveMeetingPlanRecord(meetingId)
}

export function cancelAllMeetings(): void {
  cancelAllMeetingRuns()
  cancelAllBuildRuns()
}

export function currentMeetingSummary(meetingId: string): MeetingSummary {
  return meetingSummary(meetingId)
}
