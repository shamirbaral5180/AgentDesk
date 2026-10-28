import { randomUUID } from 'node:crypto'
import type {
  AgentConfig,
  ChatUsage,
  MeetingBudget,
  MeetingDecision,
  MeetingDetail,
  MeetingFileClaim,
  MeetingIntakeCard,
  MeetingMessage,
  MeetingMessageMetadata,
  MeetingParticipant,
  MeetingPlan,
  MeetingPlanDecision,
  MeetingPlanFileClaim,
  MeetingPlanTask,
  MeetingFinalReport,
  MeetingReportApproval,
  MeetingStatus,
  MeetingStopReason,
  MeetingSummary,
  MeetingTask,
  MeetingTaskEvent,
  MeetingTaskStatus,
  MeetingUsage,
  TeamConfig
} from '@shared/types'
import { AppError } from '../errors'
import {
  getCurrentProjectDatabase,
  getCurrentTeamConfig
} from '../project/projectService'
import { matchesAnyGlob, normalizeRelativePath } from '../chat/pathPolicy'

type MeetingRow = {
  id: string
  session_id: string
  mode: 'plan' | 'build'
  goal: string
  status: MeetingStatus
  resume_state: string | null
  stop_reason: MeetingStopReason | null
  budget_json: string
  used_json: string
  coordinator_agent_id: string
  parent_meeting_id: string | null
  created_at: number
  updated_at: number
  started_at: number | null
  ended_at: number | null
  plan_json: string | null
  plan_approved_at: number | null
  final_report_json: string | null
  build_state_json: string | null
  error: string | null
  current_round: number
  title: string
  message_count: number
  task_count: number
  decision_count: number
  claim_count: number
}

type ParticipantRow = {
  agent_id: string
  role_snapshot_json: string
}

type MessageRow = {
  id: string
  meeting_id: string
  session_id: string
  seq: number
  sender_type: 'boss' | 'agent' | 'system'
  sender_agent_id: string | null
  sender_name: string | null
  target_agent_id: string | null
  kind: string
  content: string
  metadata_json: string | null
  created_at: number
  round: number
}

type TaskRow = {
  id: string
  meeting_id: string
  title: string
  description: string
  status: MeetingTaskStatus
  priority: number
  assignee_agent_id: string | null
  created_by: string
  acceptance_criteria: string | null
  file_globs_json: string | null
  depends_on_json: string | null
  review_cycles: number
  created_at: number
  updated_at: number
  completed_at: number | null
}

type TaskEventRow = {
  id: string
  task_id: string
  meeting_id: string
  agent_id: string | null
  type: string
  from_status: MeetingTaskStatus | null
  to_status: MeetingTaskStatus | null
  note: string | null
  created_at: number
}

type DecisionRow = {
  id: string
  meeting_id: string
  title: string
  context: string | null
  decision: string
  rationale: string | null
  status: string
  proposed_by_agent_id: string | null
  created_at: number
  updated_at: number
}

type ClaimRow = {
  id: string
  meeting_id: string
  task_id: string | null
  agent_id: string
  path_prefix: string
  scope: string
  status: string
  claimed_at: number
}

function database() {
  const projectDatabase = getCurrentProjectDatabase()
  if (!projectDatabase) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }
  return projectDatabase.db
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function defaultUsage(): MeetingUsage {
  return {
    rounds: 0,
    turns: 0,
    messages: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    elapsedMs: 0
  }
}

function teamBudget(team: TeamConfig): MeetingBudget {
  return {
    maxRounds: team.orchestration.maxRounds,
    maxTurns: team.orchestration.maxTurns,
    maxMessages: team.orchestration.maxMessages,
    maxMinutes: team.orchestration.maxMinutes,
    maxTokens: team.orchestration.maxTokens,
    maxCostUsd: team.orchestration.maxCostUsd,
    maxToolStepsPerTurn: team.orchestration.maxToolStepsPerTurn,
    maxReviewCycles: team.orchestration.maxReviewCycles
  }
}

function meetingRow(meetingId: string): MeetingRow {
  const row = database()
    .prepare(
      `SELECT m.*, s.title,
        (SELECT COUNT(*) FROM messages msg WHERE msg.meeting_id = m.id) AS message_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.meeting_id = m.id) AS task_count,
        (SELECT COUNT(*) FROM decisions d WHERE d.meeting_id = m.id) AS decision_count,
        (SELECT COUNT(*) FROM file_claims c WHERE c.meeting_id = m.id) AS claim_count
       FROM meetings m
       JOIN sessions s ON s.id = m.session_id
       WHERE m.id = ?`
    )
    .get(meetingId) as MeetingRow | undefined
  if (!row) {
    throw new AppError('MEETING_NOT_FOUND', 'The meeting no longer exists.')
  }
  return row
}

function participantRows(meetingId: string): ParticipantRow[] {
  return database()
    .prepare(
      'SELECT agent_id, role_snapshot_json FROM meeting_participants WHERE meeting_id = ? ORDER BY rowid ASC'
    )
    .all(meetingId) as ParticipantRow[]
}

function toParticipant(row: ParticipantRow): MeetingParticipant {
  const agent = parseJson<AgentConfig | null>(row.role_snapshot_json, null)
  const modelLabel = agent?.model
    ? `${agent.model.providerType} / ${agent.model.modelId}`
    : null
  return {
    agentId: row.agent_id,
    name: agent?.name ?? row.agent_id,
    roleKey: agent?.roleKey ?? 'agent',
    tagline: agent?.tagline ?? '',
    color: agent?.color ?? '#8ab7ff',
    modelLabel
  }
}

function participants(meetingId: string): MeetingParticipant[] {
  return participantRows(meetingId).map(toParticipant)
}

function toMessage(row: MessageRow): MeetingMessage {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    seq: row.seq,
    senderType: row.sender_type,
    senderAgentId: row.sender_agent_id,
    senderName: row.sender_name ?? (row.sender_type === 'boss' ? 'Boss' : 'System'),
    targetAgentId: row.target_agent_id,
    kind: row.kind,
    content: row.content,
    metadata: parseJson<MeetingMessageMetadata | undefined>(row.metadata_json, undefined),
    createdAt: row.created_at
  }
}

function toTask(row: TaskRow): MeetingTask {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigneeAgentId: row.assignee_agent_id,
    createdBy: row.created_by,
    acceptanceCriteria: row.acceptance_criteria,
    fileGlobs: parseJson<string[]>(row.file_globs_json, []),
    dependsOn: parseJson<string[]>(row.depends_on_json, []),
    reviewCycles: row.review_cycles,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  }
}

function toTaskEvent(row: TaskEventRow): MeetingTaskEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    meetingId: row.meeting_id,
    agentId: row.agent_id,
    type: row.type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    note: row.note,
    createdAt: row.created_at
  }
}

function toDecision(row: DecisionRow): MeetingDecision {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    title: row.title,
    context: row.context,
    decision: row.decision,
    rationale: row.rationale,
    status: row.status,
    proposedByAgentId: row.proposed_by_agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toClaim(row: ClaimRow): MeetingFileClaim {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    pathPrefix: row.path_prefix,
    scope: row.scope,
    status: row.status,
    claimedAt: row.claimed_at
  }
}

function toSummary(row: MeetingRow): MeetingSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    mode: row.mode,
    goal: row.goal,
    status: row.status,
    stopReason: row.stop_reason,
    coordinatorAgentId: row.coordinator_agent_id,
    parentMeetingId: row.parent_meeting_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    budget: parseJson<MeetingBudget>(row.budget_json, {
      maxRounds: 3,
      maxTurns: 32,
      maxMessages: 50,
      maxMinutes: 15,
      maxTokens: 300_000,
      maxCostUsd: 2,
      maxToolStepsPerTurn: 8,
      maxReviewCycles: 2
    }),
    usage: parseJson<MeetingUsage>(row.used_json, defaultUsage()),
    participants: participants(row.id),
    messageCount: row.message_count,
    taskCount: row.task_count,
    decisionCount: row.decision_count,
    claimCount: row.claim_count,
    planApprovedAt: row.plan_approved_at,
    error: row.error
  }
}

export function meetingSummary(meetingId: string): MeetingSummary {
  return toSummary(meetingRow(meetingId))
}

export function listMeetingSummaries(): MeetingSummary[] {
  const rows = database()
    .prepare(
      `SELECT m.*, s.title,
        (SELECT COUNT(*) FROM messages msg WHERE msg.meeting_id = m.id) AS message_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.meeting_id = m.id) AS task_count,
        (SELECT COUNT(*) FROM decisions d WHERE d.meeting_id = m.id) AS decision_count,
        (SELECT COUNT(*) FROM file_claims c WHERE c.meeting_id = m.id) AS claim_count
       FROM meetings m
       JOIN sessions s ON s.id = m.session_id
       ORDER BY m.updated_at DESC`
    )
    .all() as MeetingRow[]
  return rows.map((row) => toSummary(row))
}

export function getMeetingDetail(meetingId: string): MeetingDetail {
  const row = meetingRow(meetingId)
  const messages = (
    database()
      .prepare('SELECT * FROM messages WHERE meeting_id = ? ORDER BY seq ASC')
      .all(meetingId) as MessageRow[]
  ).map(toMessage)
  const tasks = (
    database()
      .prepare('SELECT * FROM tasks WHERE meeting_id = ? ORDER BY created_at ASC')
      .all(meetingId) as TaskRow[]
  ).map(toTask)
  const decisions = (
    database()
      .prepare('SELECT * FROM decisions WHERE meeting_id = ? ORDER BY created_at ASC')
      .all(meetingId) as DecisionRow[]
  ).map(toDecision)
  const fileClaims = (
    database()
      .prepare('SELECT * FROM file_claims WHERE meeting_id = ? ORDER BY claimed_at ASC')
      .all(meetingId) as ClaimRow[]
  ).map(toClaim)
  const activity = (
    database()
      .prepare('SELECT * FROM task_events WHERE meeting_id = ? ORDER BY created_at ASC')
      .all(meetingId) as TaskEventRow[]
  ).map(toTaskEvent)

  return {
    meeting: toSummary(row),
    messages,
    tasks,
    decisions,
    fileClaims,
    activity,
    plan: parseJson<MeetingPlan | null>(row.plan_json, null),
    finalReport: parseJson<MeetingFinalReport | null>(row.final_report_json, null)
  }
}

export function createMeetingRecord(input: {
  goal: string
  agentIds: string[]
  mode: 'plan' | 'build'
}): MeetingDetail {
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

  const selectedIds = [...new Set([...input.agentIds, coordinator.id])]
  const selected = selectedIds.map((agentId) => {
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
    return agent
  })

  const meetingId = randomUUID()
  const sessionId = randomUUID()
  const now = Date.now()
  const title = `Plan: ${input.goal.replace(/\s+/g, ' ').trim().slice(0, 76)}`
  const budget = teamBudget(team)

  database().exec('BEGIN IMMEDIATE')
  try {
    database()
      .prepare(
        `INSERT INTO sessions
          (id, title, status, mode, agent_id, created_at, updated_at, last_opened_at)
         VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`
      )
      .run(sessionId, title, input.mode, coordinator.id, now, now, now)
    database()
      .prepare(
        `INSERT INTO meetings
          (id, session_id, mode, goal, status, resume_state, stop_reason, budget_json,
           used_json, coordinator_agent_id, parent_meeting_id, created_at, updated_at,
           started_at, ended_at, plan_json, plan_approved_at, error, current_round)
         VALUES (?, ?, ?, ?, 'draft', NULL, NULL, ?, ?, ?, NULL, ?, ?, NULL, NULL,
           NULL, NULL, NULL, 0)`
      )
      .run(
        meetingId,
        sessionId,
        input.mode,
        input.goal.trim(),
        JSON.stringify(budget),
        JSON.stringify(defaultUsage()),
        coordinator.id,
        now,
        now
      )
    const insertParticipant = database().prepare(
      `INSERT INTO meeting_participants (meeting_id, agent_id, role_snapshot_json)
       VALUES (?, ?, ?)`
    )
    for (const agent of selected) {
      insertParticipant.run(meetingId, agent.id, JSON.stringify(agent))
    }
    appendMeetingMessage({
      meetingId,
      sessionId,
      senderType: 'boss',
      senderAgentId: null,
      senderName: 'Boss',
      targetAgentId: null,
      kind: 'goal',
      content: input.goal.trim(),
      metadata: { phase: 'boss', round: 0, status: 'done' }
    })
    database().exec('COMMIT')
  } catch (error) {
    database().exec('ROLLBACK')
    throw error
  }

  return getMeetingDetail(meetingId)
}

export function createBuildMeetingRecord(input: {
  plan: MeetingDetail
}): MeetingDetail {
  const plan = input.plan
  if (!plan.plan || !plan.meeting.planApprovedAt) {
    throw new AppError(
      'PLAN_NOT_APPROVED',
      'Approve the Plan meeting before starting a Build meeting.'
    )
  }
  if (plan.meeting.status !== 'completed') {
    throw new AppError('PLAN_NOT_COMPLETE', 'The Plan meeting must finish before Build.')
  }
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
      'Enable the Coordinator & Architect agent before starting a Build meeting.'
    )
  }
  const selected = plan.meeting.participants.map((participant) => {
    const agent = team.agents.find((entry) => entry.id === participant.agentId)
    if (!agent) {
      throw new AppError(
        'AGENT_NOT_FOUND',
        `${participant.name} no longer exists in the team. Update the roster and plan again.`
      )
    }
    if (!agent.enabled) {
      throw new AppError(
        'AGENT_DISABLED',
        `${agent.name} is disabled. Enable it before starting Build.`
      )
    }
    return agent
  })
  if (!selected.some((agent) => agent.id === coordinator.id)) {
    selected.unshift(coordinator)
  }

  const meetingId = randomUUID()
  const sessionId = randomUUID()
  const now = Date.now()
  const title = `Build: ${plan.meeting.goal.replace(/\s+/g, ' ').trim().slice(0, 76)}`
  const budget = teamBudget(team)

  database().exec('BEGIN IMMEDIATE')
  try {
    database()
      .prepare(
        `INSERT INTO sessions
          (id, title, status, mode, agent_id, created_at, updated_at, last_opened_at)
         VALUES (?, ?, 'active', 'build', ?, ?, ?, ?)`
      )
      .run(sessionId, title, coordinator.id, now, now, now)
    database()
      .prepare(
        `INSERT INTO meetings
          (id, session_id, mode, goal, status, resume_state, stop_reason, budget_json,
           used_json, coordinator_agent_id, parent_meeting_id, created_at, updated_at,
           started_at, ended_at, plan_json, plan_approved_at, error, current_round,
           final_report_json, build_state_json)
         VALUES (?, ?, 'build', ?, 'draft', NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL,
           ?, ?, NULL, 0, NULL, NULL)`
      )
      .run(
        meetingId,
        sessionId,
        plan.meeting.goal,
        JSON.stringify(budget),
        JSON.stringify(defaultUsage()),
        coordinator.id,
        plan.meeting.id,
        now,
        now,
        JSON.stringify(plan.plan),
        now
      )
    const insertParticipant = database().prepare(
      `INSERT INTO meeting_participants (meeting_id, agent_id, role_snapshot_json)
       VALUES (?, ?, ?)`
    )
    for (const agent of selected) {
      insertParticipant.run(meetingId, agent.id, JSON.stringify(agent))
    }

    const insertTask = database().prepare(
      `INSERT INTO tasks
        (id, session_id, meeting_id, title, description, status, priority,
         assignee_agent_id, created_by, acceptance_criteria, file_globs_json,
         depends_on_json, review_cycles, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`
    )
    const insertTaskEvent = database().prepare(
      `INSERT INTO task_events
        (id, task_id, meeting_id, agent_id, type, from_status, to_status, note, created_at)
       VALUES (?, ?, ?, ?, 'queued', 'proposed', 'queued', ?, ?)`
    )
    plan.tasks.forEach((task, index) => {
      const createdAt = now + index
      const newTaskId = randomUUID()
      insertTask.run(
        newTaskId,
        sessionId,
        meetingId,
        task.title,
        task.description,
        task.priority,
        task.assigneeAgentId,
        coordinator.id,
        task.acceptanceCriteria,
        JSON.stringify(task.fileGlobs),
        JSON.stringify(task.dependsOn),
        createdAt,
        createdAt
      )
      insertTaskEvent.run(
        randomUUID(),
        newTaskId,
        meetingId,
        task.assigneeAgentId,
        'Coordinator decomposed the approved plan into a queued Build task.',
        createdAt
      )
    })

    const insertDecision = database().prepare(
      `INSERT INTO decisions
        (id, session_id, meeting_id, title, context, options_json, decision, rationale,
         status, proposed_by_agent_id, accepted_by, supersedes_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'accepted', ?, 'Boss', NULL, ?, ?)`
    )
    for (const decision of plan.decisions) {
      insertDecision.run(
        randomUUID(),
        sessionId,
        meetingId,
        decision.title,
        decision.context,
        decision.decision,
        decision.rationale,
        decision.proposedByAgentId ?? coordinator.id,
        now,
        now
      )
    }

    const insertClaim = database().prepare(
      `INSERT INTO file_claims
        (id, meeting_id, task_id, agent_id, path_prefix, scope, status, claimed_at, released_at)
       VALUES (?, ?, NULL, ?, ?, ?, 'proposed', ?, NULL)`
    )
    for (const claim of plan.fileClaims) {
      insertClaim.run(
        randomUUID(),
        meetingId,
        claim.agentId,
        claim.pathPrefix,
        claim.scope,
        now
      )
    }

    appendMeetingMessage({
      meetingId,
      sessionId,
      senderType: 'boss',
      senderAgentId: null,
      senderName: 'Boss',
      targetAgentId: null,
      kind: 'build_goal',
      content: `Build the approved plan: ${plan.meeting.goal}`,
      metadata: { phase: 'boss', round: 0, status: 'done' }
    })
    database().exec('COMMIT')
  } catch (error) {
    database().exec('ROLLBACK')
    throw error
  }

  return getMeetingDetail(meetingId)
}

export function meetingSessionId(meetingId: string): string {
  return meetingRow(meetingId).session_id
}

export function meetingGoal(meetingId: string): string {
  return meetingRow(meetingId).goal
}

export function meetingStatus(meetingId: string): MeetingStatus {
  return meetingRow(meetingId).status
}

export function setMeetingStatus(input: {
  meetingId: string
  status: MeetingStatus
  stopReason?: MeetingStopReason | null
  error?: string | null
  started?: boolean
  ended?: boolean
}): MeetingSummary {
  const now = Date.now()
  const row = meetingRow(input.meetingId)
  database()
    .prepare(
      `UPDATE meetings
       SET status = ?, stop_reason = ?, error = ?, updated_at = ?,
           started_at = CASE WHEN ? THEN COALESCE(started_at, ?) ELSE started_at END,
           ended_at = CASE WHEN ? THEN ? ELSE ended_at END
       WHERE id = ?`
    )
    .run(
      input.status,
      input.stopReason === undefined ? row.stop_reason : input.stopReason,
      input.error === undefined ? row.error : input.error,
      now,
      input.started ? 1 : 0,
      now,
      input.ended ? 1 : 0,
      now,
      input.meetingId
    )
  database()
    .prepare(
      "UPDATE sessions SET status = ?, updated_at = ?, last_opened_at = ? WHERE id = ?"
    )
    .run(
      input.status === 'completed' ? 'completed' : input.status === 'failed' ? 'error' : 'active',
      now,
      now,
      row.session_id
    )
  return meetingSummary(input.meetingId)
}

export function setMeetingRound(meetingId: string, round: number): void {
  database()
    .prepare('UPDATE meetings SET current_round = ?, updated_at = ? WHERE id = ?')
    .run(round, Date.now(), meetingId)
}

export function updateMeetingUsage(meetingId: string, usage: MeetingUsage): MeetingSummary {
  database()
    .prepare('UPDATE meetings SET used_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(usage), Date.now(), meetingId)
  return meetingSummary(meetingId)
}

export function setMeetingPlan(meetingId: string, plan: MeetingPlan): MeetingSummary {
  database()
    .prepare('UPDATE meetings SET plan_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(plan), Date.now(), meetingId)
  return meetingSummary(meetingId)
}

export function approveMeetingPlanRecord(meetingId: string): MeetingDetail {
  const detail = getMeetingDetail(meetingId)
  if (!detail.plan) {
    throw new AppError('MEETING_PLAN_MISSING', 'The meeting has no plan to approve.')
  }
  const now = Date.now()
  database()
    .prepare(
      "UPDATE meetings SET plan_approved_at = ?, stop_reason = 'approved', updated_at = ? WHERE id = ?"
    )
    .run(now, now, meetingId)
  return getMeetingDetail(meetingId)
}

export function nextMessageSeq(meetingId: string, sessionId: string): number {
  const row = database()
    .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE session_id = ?')
    .get(sessionId) as { seq: number } | undefined
  const meetingRow = database()
    .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE meeting_id = ?')
    .get(meetingId) as { seq: number } | undefined
  return Math.max(row?.seq ?? 1, (meetingRow?.seq ?? 0) + 1)
}

export function appendMeetingMessage(input: {
  meetingId: string
  sessionId?: string
  senderType: 'boss' | 'agent' | 'system'
  senderAgentId: string | null
  senderName: string
  targetAgentId: string | null
  kind: string
  content: string
  metadata?: MeetingMessageMetadata
  round?: number
}): MeetingMessage {
  const sessionId = input.sessionId ?? meetingSessionId(input.meetingId)
  const seq = nextMessageSeq(input.meetingId, sessionId)
  const id = randomUUID()
  const now = Date.now()
  database()
    .prepare(
      `INSERT INTO messages
        (id, session_id, meeting_id, seq, sender_type, sender_agent_id, sender_name,
         target_type, target_agent_id, kind, content, metadata_json, created_at, round)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      sessionId,
      input.meetingId,
      seq,
      input.senderType,
      input.senderAgentId,
      input.senderName,
      input.senderAgentId ? 'agent' : 'meeting',
      input.targetAgentId,
      input.kind,
      input.content,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      input.round ?? input.metadata?.round ?? 0
    )
  const recipients = database()
    .prepare('SELECT agent_id FROM meeting_participants WHERE meeting_id = ?')
    .all(input.meetingId) as Array<{ agent_id: string }>
  const targetIds = input.targetAgentId
    ? [input.targetAgentId]
    : recipients.map((row) => row.agent_id)
  const insertDelivery = database().prepare(
    `INSERT OR IGNORE INTO message_deliveries
      (message_id, agent_id, state, created_at, processed_at)
     VALUES (?, ?, 'pending', ?, NULL)`
  )
  for (const agentId of targetIds) {
    if (agentId !== input.senderAgentId) {
      insertDelivery.run(id, agentId, now)
    }
  }
  database()
    .prepare('UPDATE meetings SET updated_at = ? WHERE id = ?')
    .run(now, input.meetingId)
  return meetingMessage(id)
}

export function markMeetingDeliveriesProcessed(
  meetingId: string,
  agentId: string
): void {
  database()
    .prepare(
      `UPDATE message_deliveries
       SET state = 'processed', processed_at = ?
       WHERE message_id IN (SELECT id FROM messages WHERE meeting_id = ?)
         AND agent_id = ?
         AND state = 'pending'`
    )
    .run(Date.now(), meetingId, agentId)
}

export function beginMeetingMessage(input: {
  meetingId: string
  senderType: 'agent'
  senderAgentId: string
  senderName: string
  targetAgentId: string | null
  kind: string
  metadata: MeetingMessageMetadata
}): MeetingMessage {
  return appendMeetingMessage({
    ...input,
    content: '',
    round: input.metadata.round
  })
}

export function updateMeetingMessage(input: {
  messageId: string
  content: string
  metadata?: MeetingMessageMetadata
}): MeetingMessage {
  const current = database()
    .prepare('SELECT content, metadata_json FROM messages WHERE id = ?')
    .get(input.messageId) as { content: string; metadata_json: string | null } | undefined
  if (!current) {
    throw new AppError('MEETING_MESSAGE_NOT_FOUND', 'The meeting message no longer exists.')
  }
  database()
    .prepare('UPDATE messages SET content = ?, metadata_json = ? WHERE id = ?')
    .run(
      input.content,
      input.metadata === undefined ? current.metadata_json : JSON.stringify(input.metadata),
      input.messageId
    )
  return meetingMessage(input.messageId)
}

export function meetingMessage(messageId: string): MeetingMessage {
  const row = database()
    .prepare('SELECT * FROM messages WHERE id = ?')
    .get(messageId) as MessageRow | undefined
  if (!row) {
    throw new AppError('MEETING_MESSAGE_NOT_FOUND', 'The meeting message no longer exists.')
  }
  return toMessage(row)
}

export function recordMeetingUsage(input: {
  meetingId: string
  turnId: string
  agentId: string
  providerId: string
  modelId: string
  usage: ChatUsage
}): void {
  database()
    .prepare(
      `INSERT INTO usage_records
        (id, meeting_id, turn_id, agent_id, provider_id, model_id,
         input_tokens, output_tokens, cached_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      randomUUID(),
      input.meetingId,
      input.turnId,
      input.agentId,
      input.providerId,
      input.modelId,
      input.usage.inputTokens ?? 0,
      input.usage.outputTokens ?? 0,
      input.usage.cachedTokens ?? 0,
      input.usage.costUsd ?? 0,
      Date.now()
    )
}

export function recordMeetingTurn(input: {
  meetingId: string
  turnId: string
  agentId: string
  reason: string
  status: string
  stepCount: number
  usage: ChatUsage
  error?: string
  startedAt: number
}): void {
  database()
    .prepare(
      `INSERT INTO turns
        (id, meeting_id, agent_id, task_id, reason, status, step_count,
         input_tokens, output_tokens, cost_usd, error, started_at, ended_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.turnId,
      input.meetingId,
      input.agentId,
      input.reason,
      input.status,
      input.stepCount,
      input.usage.inputTokens ?? 0,
      input.usage.outputTokens ?? 0,
      input.usage.costUsd ?? 0,
      input.error ?? null,
      input.startedAt,
      Date.now()
    )
}

export function persistPlan(input: {
  meetingId: string
  plan: MeetingPlan
  taskIdsByTitle: Map<string, string>
}): void {
  const meeting = meetingRow(input.meetingId)
  const now = Date.now()
  database().exec('BEGIN IMMEDIATE')
  try {
    database().prepare('DELETE FROM tasks WHERE meeting_id = ?').run(input.meetingId)
    database().prepare('DELETE FROM task_events WHERE meeting_id = ?').run(input.meetingId)
    database().prepare('DELETE FROM decisions WHERE meeting_id = ?').run(input.meetingId)
    database().prepare('DELETE FROM file_claims WHERE meeting_id = ?').run(input.meetingId)

    const insertTask = database().prepare(
      `INSERT INTO tasks
        (id, session_id, meeting_id, title, description, status, priority,
         assignee_agent_id, created_by, acceptance_criteria, file_globs_json,
         depends_on_json, review_cycles, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`
    )
    const insertTaskEvent = database().prepare(
      `INSERT INTO task_events
        (id, task_id, meeting_id, agent_id, type, from_status, to_status, note, created_at)
       VALUES (?, ?, ?, ?, 'proposed', NULL, 'proposed', ?, ?)`
    )
    const taskIdByTitle = new Map<string, string>()
    for (const task of input.plan.tasks) {
      const id = randomUUID()
      taskIdByTitle.set(task.title, id)
      insertTask.run(
        id,
        meeting.session_id,
        input.meetingId,
        task.title,
        task.description,
        task.priority,
        task.assigneeAgentId,
        meeting.coordinator_agent_id,
        task.acceptanceCriteria,
        JSON.stringify(task.fileGlobs),
        JSON.stringify(task.dependsOn),
        now,
        now
      )
      insertTaskEvent.run(
        randomUUID(),
        id,
        input.meetingId,
        task.assigneeAgentId,
        'Plan-mode task proposal',
        now
      )
    }
    input.taskIdsByTitle.clear()
    for (const [title, id] of taskIdByTitle.entries()) {
      input.taskIdsByTitle.set(title, id)
    }

    const insertDecision = database().prepare(
      `INSERT INTO decisions
        (id, session_id, meeting_id, title, context, options_json, decision, rationale,
         status, proposed_by_agent_id, accepted_by, supersedes_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'proposed', ?, ?, NULL, ?, ?)`
    )
    for (const decision of input.plan.decisions) {
      insertDecision.run(
        randomUUID(),
        meeting.session_id,
        input.meetingId,
        decision.title,
        decision.context,
        decision.decision,
        decision.rationale,
        meeting.coordinator_agent_id,
        'Boss',
        now,
        now
      )
    }

    const insertClaim = database().prepare(
      `INSERT INTO file_claims
        (id, meeting_id, task_id, agent_id, path_prefix, scope, status, claimed_at, released_at)
       VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, NULL)`
    )
    for (const claim of input.plan.fileClaims) {
      const taskId =
        input.plan.tasks.find(
          (task) =>
            task.assigneeAgentId === claim.agentId &&
            task.fileGlobs.some((glob) => claim.pathPrefix.startsWith(glob.replace(/\*.*$/, '')))
        )?.title ?? input.plan.tasks.find((task) => task.assigneeAgentId === claim.agentId)?.title
      insertClaim.run(
        randomUUID(),
        input.meetingId,
        taskId ? taskIdByTitle.get(taskId) ?? null : null,
        claim.agentId,
        claim.pathPrefix,
        claim.scope,
        now
      )
    }

    database()
      .prepare(
        `INSERT INTO meeting_summaries
          (meeting_id, summary, decisions_json, tasks_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(meeting_id) DO UPDATE SET
           summary = excluded.summary,
           decisions_json = excluded.decisions_json,
           tasks_json = excluded.tasks_json,
           created_at = excluded.created_at`
      )
      .run(
        input.meetingId,
        input.plan.summary,
        JSON.stringify(input.plan.decisions),
        JSON.stringify(input.plan.tasks),
        now
      )

    database()
      .prepare('UPDATE meetings SET plan_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(input.plan), now, input.meetingId)
    database().exec('COMMIT')
  } catch (error) {
    database().exec('ROLLBACK')
    throw error
  }
}

export function meetingParticipants(meetingId: string): AgentConfig[] {
  return participantRows(meetingId).map((row) => {
    const agent = parseJson<AgentConfig | null>(row.role_snapshot_json, null)
    if (!agent) {
      throw new AppError('MEETING_PARTICIPANT_INVALID', 'A meeting participant snapshot is invalid.')
    }
    return agent
  })
}

export function coordinatorAgent(meetingId: string): AgentConfig {
  const row = meetingRow(meetingId)
  const agent = meetingParticipants(meetingId).find(
    (entry) => entry.id === row.coordinator_agent_id
  )
  if (!agent) {
    throw new AppError('COORDINATOR_MISSING', 'The meeting coordinator is missing.')
  }
  return agent
}

export function meetingPlan(meetingId: string): MeetingPlan | null {
  return parseJson<MeetingPlan | null>(meetingRow(meetingId).plan_json, null)
}

export function replacePlanTaskIds(
  plan: MeetingPlan,
  taskIdsByTitle: Map<string, string>
): MeetingPlan {
  return {
    ...plan,
    tasks: plan.tasks.map((task) => ({
      ...task,
      dependsOn: task.dependsOn.map((title) => taskIdsByTitle.get(title) ?? title)
    }))
  }
}

export function toPlanTask(input: {
  task: MeetingPlanTask
  fallbackAssignee: string
}): MeetingPlanTask {
  return {
    ...input.task,
    assigneeAgentId: input.task.assigneeAgentId || input.fallbackAssignee,
    priority: Math.min(Math.max(input.task.priority || 2, 1), 3),
    acceptanceCriteria: input.task.acceptanceCriteria || 'The Boss can review the outcome.',
    fileGlobs: [...new Set(input.task.fileGlobs.filter(Boolean))],
    dependsOn: [...new Set(input.task.dependsOn.filter(Boolean))]
  }
}

export function toPlanDecision(input: MeetingPlanDecision): MeetingPlanDecision {
  return {
    title: input.title.trim(),
    context: input.context.trim(),
    decision: input.decision.trim(),
    rationale: input.rationale.trim()
  }
}

export function toPlanClaim(input: MeetingPlanFileClaim): MeetingPlanFileClaim {
  return {
    agentId: input.agentId,
    pathPrefix: input.pathPrefix.trim(),
    scope: input.scope.trim() || 'proposed'
  }
}

export function meetingTitle(meetingId: string): string {
  return meetingRow(meetingId).title
}

export function meetingIntakeCard(
  metadata: MeetingMessageMetadata | undefined
): MeetingIntakeCard | null {
  return metadata?.card ?? null
}

export function listMeetingTasks(meetingId: string): MeetingTask[] {
  const rows = database()
    .prepare('SELECT * FROM tasks WHERE meeting_id = ? ORDER BY created_at ASC')
    .all(meetingId) as TaskRow[]
  return rows.map(toTask)
}

export function meetingTask(taskId: string): MeetingTask {
  const row = database()
    .prepare('SELECT * FROM tasks WHERE id = ?')
    .get(taskId) as TaskRow | undefined
  if (!row) {
    throw new AppError('MEETING_TASK_NOT_FOUND', 'The Build task no longer exists.')
  }
  return toTask(row)
}

export function recordTaskEvent(input: {
  taskId: string
  meetingId: string
  agentId?: string | null
  type: string
  fromStatus?: MeetingTaskStatus | null
  toStatus?: MeetingTaskStatus | null
  note?: string | null
}): MeetingTaskEvent {
  const id = randomUUID()
  const now = Date.now()
  database()
    .prepare(
      `INSERT INTO task_events
        (id, task_id, meeting_id, agent_id, type, from_status, to_status, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.taskId,
      input.meetingId,
      input.agentId ?? null,
      input.type,
      input.fromStatus ?? null,
      input.toStatus ?? null,
      input.note ?? null,
      now
    )
  database()
    .prepare('UPDATE meetings SET updated_at = ? WHERE id = ?')
    .run(now, input.meetingId)
  return toTaskEvent({
    id,
    task_id: input.taskId,
    meeting_id: input.meetingId,
    agent_id: input.agentId ?? null,
    type: input.type,
    from_status: input.fromStatus ?? null,
    to_status: input.toStatus ?? null,
    note: input.note ?? null,
    created_at: now
  })
}

export function transitionMeetingTask(input: {
  taskId: string
  status: MeetingTaskStatus
  agentId?: string | null
  note?: string | null
  type?: string
  incrementReview?: boolean
}): MeetingTask {
  const current = meetingTask(input.taskId)
  const now = Date.now()
  database()
    .prepare(
      `UPDATE tasks
       SET status = ?, review_cycles = review_cycles + ?, updated_at = ?,
           completed_at = CASE WHEN ? = 'done' THEN COALESCE(completed_at, ?) ELSE completed_at END
       WHERE id = ?`
    )
    .run(
      input.status,
      input.incrementReview ? 1 : 0,
      now,
      input.status,
      now,
      input.taskId
    )
  recordTaskEvent({
    taskId: input.taskId,
    meetingId: current.meetingId,
    agentId: input.agentId ?? current.assigneeAgentId,
    type: input.type ?? 'status',
    fromStatus: current.status,
    toStatus: input.status,
    note: input.note ?? null
  })
  return meetingTask(input.taskId)
}

export function setMeetingFinalReport(
  meetingId: string,
  report: MeetingFinalReport
): MeetingSummary {
  database()
    .prepare('UPDATE meetings SET final_report_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(report), Date.now(), meetingId)
  return meetingSummary(meetingId)
}

export function meetingFinalReport(meetingId: string): MeetingFinalReport | null {
  return parseJson<MeetingFinalReport | null>(meetingRow(meetingId).final_report_json, null)
}

export function setMeetingBuildState(meetingId: string, state: unknown): void {
  database()
    .prepare('UPDATE meetings SET build_state_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(state), Date.now(), meetingId)
}

export function createTaskClaims(input: {
  meetingId: string
  task: MeetingTask
  agent: AgentConfig
  globs?: string[]
}): MeetingFileClaim[] {
  releaseTaskClaims(input.meetingId, input.task.id)
  const globs =
    input.globs && input.globs.length > 0
      ? input.globs
      : input.task.fileGlobs.length > 0
        ? input.task.fileGlobs
        : input.agent.permissions.writeGlobs
  const now = Date.now()
  const created: MeetingFileClaim[] = []
  const insert = database().prepare(
    `INSERT INTO file_claims
      (id, meeting_id, task_id, agent_id, path_prefix, scope, status, claimed_at, released_at)
     VALUES (?, ?, ?, ?, ?, 'task', 'active', ?, NULL)`
  )
  for (const glob of [...new Set(globs.map((entry) => normalizeRelativePath(entry)).filter(Boolean))]) {
    const id = randomUUID()
    insert.run(id, input.meetingId, input.task.id, input.agent.id, glob, now)
    created.push({
      id,
      meetingId: input.meetingId,
      taskId: input.task.id,
      agentId: input.agent.id,
      pathPrefix: glob,
      scope: 'task',
      status: 'active',
      claimedAt: now
    })
  }
  return created
}

export function releaseTaskClaims(meetingId: string, taskId: string): void {
  database()
    .prepare(
      `UPDATE file_claims
       SET status = 'released', released_at = ?
       WHERE meeting_id = ? AND task_id = ? AND status = 'active'`
    )
    .run(Date.now(), meetingId, taskId)
}

export function releaseAllActiveClaims(meetingId: string): void {
  database()
    .prepare(
      `UPDATE file_claims
       SET status = 'released', released_at = ?
       WHERE meeting_id = ? AND status = 'active'`
    )
    .run(Date.now(), meetingId)
}

export function assertTaskWriteAllowed(input: {
  meetingId: string
  agentId: string
  relativePath: string
}): void {
  const relative = normalizeRelativePath(input.relativePath)
  const rows = database()
    .prepare(
      `SELECT * FROM file_claims
       WHERE meeting_id = ? AND agent_id = ? AND status = 'active'`
    )
    .all(input.meetingId, input.agentId) as ClaimRow[]
  if (rows.length === 0) {
    throw new AppError(
      'FILE_CLAIM_MISSING',
      `No active file claim allows ${relative}. Wait for the task claim to be assigned.`
    )
  }
  if (!matchesAnyGlob(relative, rows.map((row) => row.path_prefix))) {
    throw new AppError(
      'FILE_CLAIM_DENIED',
      `${relative} is outside the active task claim. Claimed paths: ${rows
        .map((row) => row.path_prefix)
        .join(', ')}.`
    )
  }
}

export function activeMeetingClaims(meetingId: string): MeetingFileClaim[] {
  const rows = database()
    .prepare(
      `SELECT * FROM file_claims
       WHERE meeting_id = ? AND status = 'active'
       ORDER BY claimed_at ASC`
    )
    .all(meetingId) as ClaimRow[]
  return rows.map(toClaim)
}

export function approvalSummaryForSession(sessionId: string): MeetingReportApproval[] {
  const rows = database()
    .prepare(
      `SELECT id, agent_id, action_type, status, risk, reason, scope, created_at
       FROM approvals WHERE session_id = ? ORDER BY created_at ASC`
    )
    .all(sessionId) as Array<{
    id: string
    agent_id: string
    action_type: string
    status: string
    risk: string
    reason: string
    scope: string | null
    created_at: number
  }>
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    actionType: row.action_type,
    status: row.status,
    risk: row.risk,
    reason: row.reason,
    scope: row.scope,
    createdAt: row.created_at
  }))
}

export function clearMeetingFinalReport(meetingId: string): void {
  database()
    .prepare('UPDATE meetings SET final_report_json = NULL, updated_at = ? WHERE id = ?')
    .run(Date.now(), meetingId)
}
