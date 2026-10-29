import type { RecoveryItem, RecoveryReport } from '@shared/types'
import { getSettingsRecoveryNotice, loadSettings } from '../config/settings'
import { getSecretsRecoveryNotice } from '../config/secrets'
import { createLogger } from '../config/logger'
import { getCurrentProjectDatabase } from '../project/projectService'
import { reconcileManagedProcesses } from '../commands/commandRunner'
import { reconcileMcpProcesses } from '../mcp/mcpManager'
import {
  markMeetingLeaseStopped,
  markRunningLeasesStale,
  staleLeases
} from './runLeaseService'

const log = createLogger('recovery')

const processStartedAt = Date.now()

let lastReport: RecoveryReport | null = null

function database() {
  return getCurrentProjectDatabase()?.db ?? null
}

function markInterruptedChatMessages(): number {
  const db = database()
  if (!db) {
    return 0
  }
  const rows = db
    .prepare(
      `SELECT id, content, metadata_json FROM messages
       WHERE meeting_id IS NULL AND sender_type = 'agent'
         AND metadata_json LIKE '%"status":"streaming"%'`
    )
    .all() as Array<{ id: string; content: string; metadata_json: string | null }>
  let changed = 0
  for (const row of rows) {
    let metadata: Record<string, unknown> = {}
    try {
      metadata = JSON.parse(row.metadata_json ?? '{}') as Record<string, unknown>
    } catch {
      metadata = {}
    }
    metadata.status = 'interrupted'
    metadata.interrupted = true
    metadata.retryable = true
    metadata.error =
      'AgentDesk stopped before this response finished. Retry the message manually.'
    db.prepare('UPDATE messages SET content = ?, metadata_json = ? WHERE id = ?').run(
      row.content.trim()
        ? row.content
        : 'Interrupted before the response completed. Retry manually.',
      JSON.stringify(metadata),
      row.id
    )
    changed += 1
  }
  return changed
}

function releaseClaimsForStaleMeetings(items: RecoveryItem[]): number {
  const db = database()
  if (!db) {
    return 0
  }
  let released = 0
  const update = db.prepare(
    `UPDATE file_claims
     SET status = 'released', released_at = ?
     WHERE meeting_id = ? AND status = 'active'`
  )
  for (const item of items) {
    if (!item.meetingId) {
      continue
    }
    const result = update.run(Date.now(), item.meetingId)
    released += Number(result.changes ?? 0)
  }
  return released
}

function cancelStaleApprovals(items: RecoveryItem[]): number {
  const db = database()
  if (!db) {
    return 0
  }
  const meetings = new Set(items.map((item) => item.meetingId).filter(Boolean))
  const sessions = new Set(items.map((item) => item.sessionId).filter(Boolean))
  let cancelled = 0
  const pending = db
    .prepare(
      "SELECT id, meeting_id, session_id, created_at FROM approvals WHERE status = 'pending'"
    )
    .all() as Array<{
    id: string
    meeting_id: string | null
    session_id: string | null
    created_at: number
  }>
  const cancel = db.prepare(
    "UPDATE approvals SET status = 'cancelled', decision_note = ?, decided_at = ? WHERE id = ? AND status = 'pending'"
  )
  for (const approval of pending) {
    if (approval.created_at >= processStartedAt) {
      continue
    }
    const stale =
      (approval.meeting_id && meetings.has(approval.meeting_id)) ||
      (approval.session_id && sessions.has(approval.session_id)) ||
      items.length > 0
    if (!stale && items.length === 0) {
      const result = cancel.run(
        'Interrupted by an app restart.',
        Date.now(),
        approval.id
      )
      cancelled += Number(result.changes ?? 0)
    } else if (stale) {
      const result = cancel.run(
        'Interrupted by an app restart. Ask the agent to try again.',
        Date.now(),
        approval.id
      )
      cancelled += Number(result.changes ?? 0)
    }
  }
  return cancelled
}

export function recoverProjectOnOpen(): RecoveryReport {
  const items = markRunningLeasesStale()
  const interruptedMessages = markInterruptedChatMessages()
  const releasedClaims = releaseClaimsForStaleMeetings(items)
  const cancelledApprovals = cancelStaleApprovals(items)
  const staleProcesses =
    reconcileManagedProcesses() + reconcileMcpProcesses()
  const settings = loadSettings()
  const report: RecoveryReport = {
    scannedAt: Date.now(),
    items,
    releasedClaims,
    cancelledApprovals,
    interruptedMessages,
    staleProcesses,
    recoveredSettings: getSettingsRecoveryNotice(),
    recoveredSecrets: getSecretsRecoveryNotice()
  }
  lastReport = report
  if (
    items.length > 0 ||
    interruptedMessages > 0 ||
    releasedClaims > 0 ||
    cancelledApprovals > 0 ||
    staleProcesses > 0
  ) {
    log.warn('Recovered after an interrupted session', {
      runs: items.length,
      interruptedMessages,
      releasedClaims,
      cancelledApprovals,
      staleProcesses,
      retentionDays: settings.retention.sessionDays
    })
  }
  return report
}

export function currentRecoveryReport(): RecoveryReport {
  if (lastReport) {
    return {
      ...lastReport,
      items: staleLeases().filter((item) => item.status === 'stale'),
      scannedAt: Date.now()
    }
  }
  return recoverProjectOnOpen()
}

export function markRecoveredMeetingStopped(meetingId: string): RecoveryReport {
  markMeetingLeaseStopped(meetingId)
  if (lastReport) {
    lastReport = {
      ...lastReport,
      items: lastReport.items.filter((item) => item.meetingId !== meetingId)
    }
  }
  return currentRecoveryReport()
}

export function clearRecoveryReport(): void {
  lastReport = null
}
