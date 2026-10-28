import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import {
  IPC_CHANNELS,
  type ApprovalActionType,
  type ApprovalDecisionInput,
  type ApprovalEvent,
  type ApprovalRequest,
  type ApprovalRisk,
  type ApprovalScope,
  type ApprovalStatus
} from '@shared/types'
import { createLogger } from '../config/logger'
import { AppError } from '../errors'
import { getCurrentProjectDatabase } from '../project/projectService'

const log = createLogger('approvals')
const processStartedAt = Date.now()

type ApprovalInput = {
  sessionId: string
  runId: string
  agentId: string
  actionType: ApprovalActionType
  actionKey: string
  risk: ApprovalRisk
  reason: string
  payload: Record<string, unknown>
}

type PendingApproval = {
  approval: ApprovalRequest
  sender: WebContents
  resolve: (result: ApprovalResult) => void
  reject: (error: unknown) => void
}

export type ApprovalResult = {
  approvalId: string
  decision: 'approved' | 'denied'
  scope?: ApprovalScope
}

type ApprovalRow = {
  id: string
  session_id: string | null
  run_id: string | null
  agent_id: string
  action_type: string
  action_key: string | null
  payload_json: string
  risk: string
  reason: string
  status: string
  scope: string | null
  decision_note: string | null
  created_at: number
  decided_at: number | null
}

const pending = new Map<string, PendingApproval>()

function database() {
  const projectDatabase = getCurrentProjectDatabase()
  if (!projectDatabase) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }
  return projectDatabase.db
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return {}
  }
  return {}
}

function toApproval(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    sessionId: row.session_id ?? '',
    runId: row.run_id ?? '',
    agentId: row.agent_id,
    actionType: row.action_type as ApprovalActionType,
    actionKey: row.action_key ?? '',
    risk: row.risk as ApprovalRisk,
    reason: row.reason,
    payload: parsePayload(row.payload_json),
    status: row.status as ApprovalStatus,
    scope: (row.scope as ApprovalScope | null) ?? undefined,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined
  }
}

function sendEvent(sender: WebContents, event: ApprovalEvent): void {
  if (!sender.isDestroyed()) {
    sender.send(IPC_CHANNELS.approvalEvent, event)
  }
}

export function expireStaleApprovals(): void {
  try {
    database()
      .prepare(
        "UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND created_at < ?"
      )
      .run(Date.now(), processStartedAt)
  } catch {
    // The project may be closed while an old approval list is being requested.
  }
}

export function listPendingApprovals(): ApprovalRequest[] {
  expireStaleApprovals()
  const rows = database()
    .prepare(
      "SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC"
    )
    .all() as ApprovalRow[]
  return rows.map(toApproval)
}

function findGrant(input: ApprovalInput): ApprovalRow | null {
  const row = database()
    .prepare(
      `SELECT * FROM approvals
       WHERE action_key = ? AND status = 'approved' AND scope IN ('session', 'project')
         AND (scope = 'project' OR session_id = ?)
       ORDER BY decided_at DESC LIMIT 1`
    )
    .get(input.actionKey, input.sessionId) as ApprovalRow | undefined
  return row ?? null
}

function insertApproval(
  input: ApprovalInput,
  status: ApprovalStatus,
  scope: ApprovalScope | null,
  note: string | null
): ApprovalRequest {
  const id = randomUUID()
  const now = Date.now()
  database()
    .prepare(
      `INSERT INTO approvals
        (id, meeting_id, turn_id, agent_id, action_type, payload_json, risk, reason,
         status, scope, decision_note, created_at, decided_at, session_id, run_id, action_key)
       VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.agentId,
      input.actionType,
      JSON.stringify(input.payload),
      input.risk,
      input.reason,
      status,
      scope,
      note,
      now,
      status === 'pending' ? null : now,
      input.sessionId,
      input.runId,
      input.actionKey
    )
  return {
    id,
    sessionId: input.sessionId,
    runId: input.runId,
    agentId: input.agentId,
    actionType: input.actionType,
    actionKey: input.actionKey,
    risk: input.risk,
    reason: input.reason,
    payload: input.payload,
    status,
    scope: scope ?? undefined,
    createdAt: now,
    decidedAt: status === 'pending' ? undefined : now
  }
}

export function requestApproval(
  sender: WebContents,
  input: ApprovalInput
): Promise<ApprovalResult> {
  const grant = findGrant(input)
  if (grant) {
    const auto = insertApproval(
      input,
      'approved',
      grant.scope as ApprovalScope,
      `Auto-approved by ${grant.scope ?? 'project'} grant`
    )
    return Promise.resolve({
      approvalId: auto.id,
      decision: 'approved',
      scope: grant.scope as ApprovalScope
    })
  }

  const approval = insertApproval(input, 'pending', null, null)
  return new Promise<ApprovalResult>((resolve, reject) => {
    pending.set(approval.id, {
      approval,
      sender,
      resolve,
      reject
    })
    sendEvent(sender, { type: 'request', approval })
    log.info('Approval requested', {
      approvalId: approval.id,
      actionType: approval.actionType,
      actionKey: approval.actionKey,
      risk: approval.risk,
      sessionId: approval.sessionId,
      runId: approval.runId
    })
  })
}

export function decideApproval(input: ApprovalDecisionInput): ApprovalRequest {
  const entry = pending.get(input.approvalId)
  if (!entry) {
    throw new AppError(
      'APPROVAL_NOT_PENDING',
      'This approval has already been decided or is no longer active.'
    )
  }

  const status: ApprovalStatus = input.decision === 'deny' ? 'denied' : 'approved'
  const scope: ApprovalScope | null = input.decision === 'deny' ? null : input.decision
  const now = Date.now()
  database()
    .prepare(
      `UPDATE approvals
       SET status = ?, scope = ?, decision_note = ?, decided_at = ?
       WHERE id = ? AND status = 'pending'`
    )
    .run(status, scope, input.note ?? null, now, input.approvalId)

  pending.delete(input.approvalId)
  const updated = toApproval(
    database()
      .prepare('SELECT * FROM approvals WHERE id = ?')
      .get(input.approvalId) as ApprovalRow
  )
  if (status === 'approved') {
    entry.resolve({
      approvalId: input.approvalId,
      decision: 'approved',
      scope: scope ?? 'once'
    })
  } else {
    entry.resolve({
      approvalId: input.approvalId,
      decision: 'denied'
    })
  }
  sendEvent(entry.sender, {
    type: 'resolved',
    approvalId: input.approvalId,
    status,
    scope: scope ?? undefined
  })
  log.info('Approval decided', {
    approvalId: input.approvalId,
    status,
    scope
  })
  return updated
}

function cancelApprovalEntry(
  approvalId: string,
  reason: string,
  rejectPromise: boolean
): void {
  const entry = pending.get(approvalId)
  if (!entry) {
    return
  }
  pending.delete(approvalId)
  try {
    database()
      .prepare(
        "UPDATE approvals SET status = 'cancelled', decision_note = ?, decided_at = ? WHERE id = ? AND status = 'pending'"
      )
      .run(reason, Date.now(), approvalId)
  } catch {
    // The project database may already be closed during shutdown.
  }
  if (rejectPromise) {
    entry.reject(new AppError('APPROVAL_CANCELLED', reason))
  } else {
    entry.resolve({ approvalId, decision: 'denied' })
  }
  sendEvent(entry.sender, {
    type: 'resolved',
    approvalId,
    status: 'cancelled'
  })
}

export function cancelApprovalsForRun(runId: string): void {
  for (const entry of [...pending.values()]) {
    if (entry.approval.runId === runId) {
      cancelApprovalEntry(entry.approval.id, 'The chat run was stopped.', true)
    }
  }
}

export function cancelApprovalsForSession(sessionId: string): void {
  for (const entry of [...pending.values()]) {
    if (entry.approval.sessionId === sessionId) {
      cancelApprovalEntry(entry.approval.id, 'The meeting was stopped.', true)
    }
  }
}

export function cancelAllApprovals(reason = 'The project was closed.'): void {
  for (const entry of [...pending.values()]) {
    cancelApprovalEntry(entry.approval.id, reason, true)
  }
}
