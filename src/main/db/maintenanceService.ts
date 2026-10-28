import fs from 'node:fs'
import path from 'node:path'
import type {
  DataStats,
  MaintenanceResult,
  RetentionSettings
} from '@shared/types'
import { loadSettings } from '../config/settings'
import { createLogger } from '../config/logger'
import { AppError } from '../errors'
import {
  getCurrentProjectDatabase,
  getCurrentProjectRoot,
  reopenCurrentProjectDatabase
} from '../project/projectService'
import { directorySize } from '../utils/fs'
import {
  backupDatabase,
  integrityCheck,
  listDatabaseBackups,
  listTableNames,
  quickCheck,
  restoreLatestBackup
} from './database'

const log = createLogger('maintenance')

function context() {
  const database = getCurrentProjectDatabase()
  const root = getCurrentProjectRoot()
  if (!database || !root) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }
  return { database, root }
}

function cutoff(days: number): number {
  return Date.now() - Math.max(days, 1) * 86_400_000
}

function tableCount(db: ReturnType<typeof context>['database']['db'], name: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as
      | { count?: number }
      | undefined
    return Number(row?.count ?? 0)
  } catch {
    return 0
  }
}

export function dataStats(): DataStats {
  const { database, root } = context()
  const db = database.db
  const retention = loadSettings().retention
  const dbBytes = fs.existsSync(database.path) ? fs.statSync(database.path).size : 0
  const walPath = `${database.path}-wal`
  const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0
  const backups = listDatabaseBackups(database.backupsDir)
  const check = quickCheck(db)
  const integrity = integrityCheck(db)
  return {
    dbBytes,
    walBytes,
    projectBytes: directorySize(path.join(root, '.agentdesk')),
    backups: backups.map((entry) => ({
      path: entry.path,
      bytes: entry.bytes,
      createdAt: entry.createdAt
    })),
    lastBackupAt: backups[0]?.createdAt ?? null,
    tables: listTableNames(db).map((name) => ({
      name,
      rows: tableCount(db, name)
    })),
    retention,
    integrity: check.ok && integrity.ok ? 'ok' : 'failed',
    quickCheck: check.result
  }
}

export function backupNow(label = 'manual'): MaintenanceResult {
  const { database } = context()
  const before = fs.existsSync(database.path) ? fs.statSync(database.path).size : 0
  const backupPath = backupDatabase({
    db: database.db,
    dbPath: database.path,
    backupsDir: database.backupsDir,
    version: 8,
    keep: loadSettings().retention.databaseBackups,
    label
  })
  return {
    pruned: {},
    vacuumed: false,
    bytesBefore: before,
    bytesAfter: before,
    backupPath,
    notes: ['Backup created with SQLite in WAL-consistent mode.']
  }
}

export function restoreBackup(): MaintenanceResult {
  const { database } = context()
  database.close()
  const restored = restoreLatestBackup({
    dbPath: database.path,
    backupsDir: database.backupsDir
  })
  if (!restored) {
    reopenCurrentProjectDatabase()
    throw new AppError(
      'DB_BACKUP_MISSING',
      'No database backup exists yet. Create a backup before restoring.'
    )
  }
  reopenCurrentProjectDatabase()
  return {
    pruned: {},
    vacuumed: false,
    bytesBefore: 0,
    bytesAfter: fs.existsSync(database.path) ? fs.statSync(database.path).size : 0,
    backupPath: restored,
    notes: ['Restored the newest backup. Reopen the project to use it.']
  }
}

function pruneCommandLogs(root: string, days: number): number {
  const dir = path.join(root, '.agentdesk', 'logs', 'commands')
  if (!fs.existsSync(dir)) {
    return 0
  }
  let removed = 0
  const cutoffAt = cutoff(days)
  for (const name of fs.readdirSync(dir)) {
    const target = path.join(dir, name)
    try {
      const stat = fs.statSync(target)
      if (stat.isFile() && stat.mtimeMs < cutoffAt) {
        fs.rmSync(target, { force: true })
        removed += 1
      }
    } catch {
      // Skip files that are being written.
    }
  }
  return removed
}

function pruneSnapshots(
  db: ReturnType<typeof context>['database']['db'],
  root: string,
  retention: RetentionSettings
): number {
  const snapshotCutoff = cutoff(retention.snapshotDays)
  const rows = db
    .prepare(
      `SELECT s.id, s.object_hash FROM snapshots s
       WHERE s.created_at < ?
         AND NOT EXISTS (SELECT 1 FROM change_events c WHERE c.snapshot_id = s.id)`
    )
    .all(snapshotCutoff) as Array<{ id: string; object_hash: string }>
  let removed = 0
  const remove = db.prepare('DELETE FROM snapshots WHERE id = ?')
  for (const row of rows) {
    remove.run(row.id)
    removed += 1
    if (row.object_hash) {
      const referenced = db
        .prepare('SELECT COUNT(*) AS count FROM snapshots WHERE object_hash = ?')
        .get(row.object_hash) as { count?: number } | undefined
      if (Number(referenced?.count ?? 0) === 0) {
        const objectPath = path.join(
          root,
          '.agentdesk',
          'snapshots',
          'objects',
          row.object_hash
        )
        try {
          fs.rmSync(objectPath, { force: true })
        } catch {
          // The object may be shared or already gone.
        }
      }
    }
  }
  return removed
}

export function pruneData(options: { vacuum?: boolean } = {}): MaintenanceResult {
  const { database, root } = context()
  const db = database.db
  const retention = loadSettings().retention
  const bytesBefore = fs.existsSync(database.path) ? fs.statSync(database.path).size : 0
  const pruned: Record<string, number> = {}
  const notes: string[] = []

  db.exec('BEGIN IMMEDIATE')
  try {
    const sessionCutoff = cutoff(retention.sessionDays)
    const sessionResult = db
      .prepare(
        `DELETE FROM sessions
         WHERE created_at < ?
           AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.session_id = sessions.id)
           AND NOT EXISTS (
             SELECT 1 FROM run_leases l WHERE l.session_id = sessions.id AND l.status = 'running'
           )`
      )
      .run(sessionCutoff)
    pruned.sessions = Number(sessionResult.changes ?? 0)

    const completed = db
      .prepare(
        `SELECT id, session_id FROM meetings
         WHERE updated_at < ? AND status IN ('completed', 'stopped', 'failed')
           AND NOT EXISTS (
             SELECT 1 FROM run_leases l WHERE l.meeting_id = meetings.id AND l.status = 'running'
           )`
      )
      .all(cutoff(retention.meetingDays)) as Array<{ id: string; session_id: string }>
    let meetings = 0
    for (const meeting of completed) {
      for (const table of [
        'message_deliveries',
        'messages',
        'task_events',
        'tasks',
        'decisions',
        'file_claims',
        'turns',
        'meeting_summaries',
        'meeting_participants'
      ]) {
        if (table === 'message_deliveries') {
          db.prepare(
            `DELETE FROM message_deliveries WHERE message_id IN
             (SELECT id FROM messages WHERE meeting_id = ?)`
          ).run(meeting.id)
        } else {
          db.prepare(`DELETE FROM ${table} WHERE meeting_id = ?`).run(meeting.id)
        }
      }
      db.prepare('DELETE FROM meetings WHERE id = ?').run(meeting.id)
      db.prepare(
        `DELETE FROM sessions WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM meetings WHERE session_id = ?)
           AND NOT EXISTS (SELECT 1 FROM messages WHERE session_id = ? AND content != '')`
      ).run(meeting.session_id, meeting.session_id, meeting.session_id)
      meetings += 1
    }
    pruned.meetings = meetings

    const usage = db
      .prepare('DELETE FROM usage_records WHERE created_at < ?')
      .run(cutoff(retention.usageDays))
    pruned.usage = Number(usage.changes ?? 0)

    const mcp = db
      .prepare('DELETE FROM mcp_calls WHERE created_at < ?')
      .run(cutoff(retention.mcpAuditDays))
    pruned.mcpCalls = Number(mcp.changes ?? 0)

    const tools = db
      .prepare('DELETE FROM tool_calls WHERE created_at < ?')
      .run(cutoff(retention.toolCallDays))
    pruned.toolCalls = Number(tools.changes ?? 0)

    const approvals = db
      .prepare(
        "UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND created_at < ?"
      )
      .run(Date.now(), cutoff(1))
    pruned.staleApprovals = Number(approvals.changes ?? 0)

    const claims = db
      .prepare(
        `UPDATE file_claims SET status = 'released', released_at = ?
         WHERE status = 'active' AND meeting_id NOT IN
           (SELECT id FROM meetings WHERE status IN ('intake','discussion','planning','building','reviewing','reporting'))`
      )
      .run(Date.now())
    pruned.staleClaims = Number(claims.changes ?? 0)

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  pruned.snapshots = pruneSnapshots(db, root, retention)
  pruned.commandLogs = pruneCommandLogs(root, retention.commandLogDays)
  pruned.orphanLeases = Number(
    db
      .prepare(
        "DELETE FROM run_leases WHERE status IN ('completed', 'stopped') AND ended_at < ?"
      )
      .run(cutoff(30)).changes ?? 0
  )

  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  let vacuumed = false
  if (options.vacuum) {
    db.exec('VACUUM')
    vacuumed = true
    notes.push('Database was vacuumed.')
  }
  const bytesAfter = fs.existsSync(database.path) ? fs.statSync(database.path).size : 0
  log.info('Pruned project data', { pruned, bytesBefore, bytesAfter, vacuumed })
  return { pruned, vacuumed, bytesBefore, bytesAfter, backupPath: null, notes }
}

export function vacuumDatabase(): MaintenanceResult {
  const { database } = context()
  const before = fs.existsSync(database.path) ? fs.statSync(database.path).size : 0
  database.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  database.db.exec('VACUUM')
  const after = fs.existsSync(database.path) ? fs.statSync(database.path).size : 0
  return {
    pruned: {},
    vacuumed: true,
    bytesBefore: before,
    bytesAfter: after,
    backupPath: null,
    notes: ['VACUUM completed.']
  }
}
