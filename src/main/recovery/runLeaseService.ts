import { randomUUID } from 'node:crypto'
import type {
  MeetingCheckpoint,
  RecoveryItem,
  RunKind,
  RunLeaseStatus
} from '@shared/types'
import { AppError } from '../errors'
import { getCurrentProjectDatabase } from '../project/projectService'

type LeaseRow = {
  id: string
  session_id: string | null
  meeting_id: string | null
  kind: RunKind
  pid: number
  status: RunLeaseStatus
  checkpoint_json: string | null
  started_at: number
  heartbeat_at: number
  ended_at: number | null
  meeting_mode: string | null
  meeting_goal: string | null
  meeting_status: string | null
  session_title: string | null
}

function database() {
  const projectDatabase = getCurrentProjectDatabase()
  if (!projectDatabase) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }
  return projectDatabase.db
}

function parseCheckpoint(raw: string | null): MeetingCheckpoint | null {
  if (!raw) {
    return null
  }
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null
    }
    return value as MeetingCheckpoint
  } catch {
    return null
  }
}

export function createRunLease(input: {
  kind: RunKind
  sessionId: string | null
  meetingId: string | null
  checkpoint?: MeetingCheckpoint | null
}): string {
  const id = randomUUID()
  const now = Date.now()
  database()
    .prepare(
      `INSERT INTO run_leases
        (id, session_id, meeting_id, kind, pid, status, checkpoint_json,
         started_at, heartbeat_at, ended_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, NULL)`
    )
    .run(
      id,
      input.sessionId,
      input.meetingId,
      input.kind,
      process.pid,
      input.checkpoint ? JSON.stringify(input.checkpoint) : null,
      now,
      now
    )
  return id
}

export function heartbeatRunLease(
  leaseId: string,
  checkpoint?: MeetingCheckpoint
): void {
  if (checkpoint) {
    database()
      .prepare(
        `UPDATE run_leases
         SET heartbeat_at = ?, checkpoint_json = ?, status = 'running'
         WHERE id = ?`
      )
      .run(Date.now(), JSON.stringify(checkpoint), leaseId)
    return
  }
  database()
    .prepare("UPDATE run_leases SET heartbeat_at = ? WHERE id = ? AND status = 'running'")
    .run(Date.now(), leaseId)
}

export function finishRunLease(
  leaseId: string,
  status: 'completed' | 'stopped' = 'completed'
): void {
  database()
    .prepare(
      `UPDATE run_leases
       SET status = ?, ended_at = ?, heartbeat_at = ?
       WHERE id = ?`
    )
    .run(status, Date.now(), Date.now(), leaseId)
}

const leaseSelect = `
  SELECT l.*, m.mode AS meeting_mode, m.goal AS meeting_goal,
         m.status AS meeting_status, s.title AS session_title
  FROM run_leases l
  LEFT JOIN meetings m ON m.id = l.meeting_id
  LEFT JOIN sessions s ON s.id = l.session_id
`

export function resumableLease(meetingId: string): {
  id: string
  checkpoint: MeetingCheckpoint | null
} | null {
  const row = database()
    .prepare(
      `${leaseSelect}
       WHERE l.meeting_id = ? AND l.status IN ('running', 'stale')
       ORDER BY l.heartbeat_at DESC LIMIT 1`
    )
    .get(meetingId) as LeaseRow | undefined
  if (!row) {
    return null
  }
  return { id: row.id, checkpoint: parseCheckpoint(row.checkpoint_json) }
}

export function meetingCheckpoint(meetingId: string): MeetingCheckpoint | null {
  const row = database()
    .prepare(
      `SELECT checkpoint_json FROM run_leases
       WHERE meeting_id = ? ORDER BY heartbeat_at DESC LIMIT 1`
    )
    .get(meetingId) as { checkpoint_json: string | null } | undefined
  return parseCheckpoint(row?.checkpoint_json ?? null)
}

export function markRunningLeasesStale(): RecoveryItem[] {
  const rows = database()
    .prepare(`${leaseSelect} WHERE l.status = 'running' ORDER BY l.heartbeat_at ASC`)
    .all() as LeaseRow[]
  if (rows.length === 0) {
    return []
  }
  const now = Date.now()
  const update = database().prepare(
    "UPDATE run_leases SET status = 'stale', heartbeat_at = ? WHERE id = ? AND status = 'running'"
  )
  for (const row of rows) {
    update.run(now, row.id)
  }
  return rows.map((row) => toRecoveryItem({ ...row, status: 'stale' }))
}

export function staleLeases(): RecoveryItem[] {
  const rows = database()
    .prepare(
      `${leaseSelect}
       WHERE l.status = 'stale'
       ORDER BY l.heartbeat_at DESC LIMIT 50`
    )
    .all() as LeaseRow[]
  return rows.map(toRecoveryItem)
}

export function markMeetingLeaseStopped(meetingId: string): void {
  database()
    .prepare(
      `UPDATE run_leases
       SET status = 'stopped', ended_at = ?, heartbeat_at = ?
       WHERE meeting_id = ? AND status IN ('running', 'stale')`
    )
    .run(Date.now(), Date.now(), meetingId)
}

function toRecoveryItem(row: LeaseRow): RecoveryItem {
  const checkpoint = parseCheckpoint(row.checkpoint_json)
  const title =
    row.meeting_goal?.trim() ||
    row.session_title?.trim() ||
    (row.kind === 'chat' ? 'Interrupted chat' : 'Interrupted run')
  return {
    leaseId: row.id,
    kind: row.kind,
    status: row.status,
    sessionId: row.session_id,
    meetingId: row.meeting_id,
    title: title.length > 120 ? `${title.slice(0, 117)}...` : title,
    phase: checkpoint?.phase ?? null,
    canResume: Boolean(
      row.meeting_id &&
        row.status === 'stale' &&
        row.kind !== 'chat' &&
        row.meeting_status !== 'completed'
    ),
    checkpoint,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at
  }
}
