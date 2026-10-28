import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  ChangeRecord,
  ChangeType,
  RevertChangeResult
} from '@shared/types'
import { AppError } from '../errors'
import {
  getCurrentProjectDatabase,
  getCurrentProjectRoot
} from '../project/projectService'
import { ensureDir, isPathInside, safeJoin } from '../utils/fs'

type ChangeRow = {
  id: string
  session_id: string | null
  meeting_id: string | null
  turn_id: string | null
  task_id: string | null
  agent_id: string | null
  type: string
  path: string | null
  command: string | null
  exit_code: number | null
  before_hash: string | null
  after_hash: string | null
  snapshot_id: string | null
  metadata_json: string | null
  created_at: number
}

export type SnapshotResult = {
  id: string
  objectHash: string
  size: number
  existed: boolean
}

function database() {
  const projectDatabase = getCurrentProjectDatabase()
  if (!projectDatabase) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }
  return projectDatabase.db
}

function root(): string {
  const value = getCurrentProjectRoot()
  if (!value) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }
  return value
}

function normalizeRelative(relativePath: string): string {
  return relativePath.replaceAll('\\', '/').replace(/^\.\//, '')
}

function safeProjectPath(relativePath: string): {
  relative: string
  absolute: string
} {
  const relative = normalizeRelative(relativePath)
  if (!relative) {
    throw new AppError('INVALID_PATH', 'A file path is required.')
  }
  if (relative.startsWith('.agentdesk/') || relative === '.agentdesk') {
    throw new AppError('PROTECTED_PATH', 'AgentDesk workspace files cannot be modified.')
  }
  if (relative.startsWith('.git/') || relative === '.git') {
    throw new AppError('PROTECTED_PATH', 'Git metadata cannot be modified.')
  }
  const projectRoot = root()
  const absolute = safeJoin(projectRoot, relative)
  return { relative, absolute }
}

export function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function objectPath(hash: string): string {
  return path.join(root(), '.agentdesk', 'snapshots', 'objects', hash)
}

export function snapshotFile(
  sessionId: string,
  relativePath: string,
  label: string
): SnapshotResult {
  const { relative, absolute } = safeProjectPath(relativePath)
  const id = randomUUID()
  const now = Date.now()
  if (!fs.existsSync(absolute)) {
    database()
      .prepare(
        `INSERT INTO snapshots (id, path, object_hash, size, created_at, session_id, label)
         VALUES (?, ?, '', 0, ?, ?, ?)`
      )
      .run(id, relative, now, sessionId, label)
    return { id, objectHash: '', size: 0, existed: false }
  }

  const stat = fs.lstatSync(absolute)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AppError('NOT_A_FILE', `Only regular files can be changed: ${relative}`)
  }
  const buffer = fs.readFileSync(absolute)
  const hash = hashBuffer(buffer)
  const target = objectPath(hash)
  ensureDir(path.dirname(target))
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, buffer)
  }
  database()
    .prepare(
      `INSERT INTO snapshots (id, path, object_hash, size, created_at, session_id, label)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, relative, hash, buffer.length, now, sessionId, label)
  return { id, objectHash: hash, size: buffer.length, existed: true }
}

function parseMetadata(raw: string | null): unknown {
  if (!raw) {
    return undefined
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function toChange(row: ChangeRow): ChangeRecord {
  const fileChange =
    row.type === 'write' ||
    row.type === 'patch' ||
    row.type === 'delete' ||
    row.type === 'move' ||
    row.type === 'revert'
  return {
    id: row.id,
    sessionId: row.session_id ?? '',
    meetingId: row.meeting_id,
    taskId: row.task_id,
    turnId: row.turn_id,
    agentId: row.agent_id,
    type: row.type as ChangeType,
    path: row.path,
    command: row.command,
    exitCode: row.exit_code,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    snapshotId: row.snapshot_id,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
    canRevert: fileChange && Boolean(row.snapshot_id && row.path)
  }
}

export function recordChange(input: {
  sessionId: string
  meetingId?: string
  taskId?: string
  turnId?: string
  agentId: string
  type: ChangeType
  path?: string | null
  command?: string | null
  exitCode?: number | null
  beforeHash?: string | null
  afterHash?: string | null
  snapshotId?: string | null
  metadata?: unknown
}): ChangeRecord {
  const id = randomUUID()
  const now = Date.now()
  database()
    .prepare(
      `INSERT INTO change_events
        (id, meeting_id, turn_id, task_id, agent_id, type, path, command, exit_code,
         before_hash, after_hash, snapshot_id, metadata_json, created_at, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.meetingId ?? null,
      input.turnId ?? null,
      input.taskId ?? null,
      input.agentId,
      input.type,
      input.path ?? null,
      input.command ?? null,
      input.exitCode ?? null,
      input.beforeHash ?? null,
      input.afterHash ?? null,
      input.snapshotId ?? null,
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
      now,
      input.sessionId
    )
  const row = database()
    .prepare('SELECT * FROM change_events WHERE id = ?')
    .get(id) as ChangeRow
  return toChange(row)
}

export function listChanges(sessionId: string, limit = 100): ChangeRecord[] {
  const rows = database()
    .prepare(
      'SELECT * FROM change_events WHERE session_id = ? ORDER BY created_at DESC LIMIT ?'
    )
    .all(sessionId, limit) as ChangeRow[]
  return rows.map(toChange)
}

function currentHash(absolutePath: string): string {
  if (!fs.existsSync(absolutePath)) {
    return ''
  }
  return hashBuffer(fs.readFileSync(absolutePath))
}

export function revertChange(changeId: string, taskId?: string): RevertChangeResult {
  const row = database()
    .prepare('SELECT * FROM change_events WHERE id = ?')
    .get(changeId) as ChangeRow | undefined
  if (!row) {
    throw new AppError('CHANGE_NOT_FOUND', 'The change no longer exists.')
  }
  const fileChange =
    row.type === 'write' ||
    row.type === 'patch' ||
    row.type === 'delete' ||
    row.type === 'move' ||
    row.type === 'revert'
  if (!fileChange || !row.path || !row.snapshot_id || !row.session_id) {
    throw new AppError(
      'CHANGE_NOT_REVERTIBLE',
      'This entry cannot be reverted. Only file changes with snapshots can be restored.'
    )
  }

  const { relative, absolute } = safeProjectPath(row.path)
  const current = snapshotFile(row.session_id, relative, `before revert ${row.type}`)
  const beforeHash = row.before_hash ?? ''

  if (!beforeHash) {
    if (fs.existsSync(absolute)) {
      fs.rmSync(absolute, { force: true })
    }
  } else {
    const source = objectPath(beforeHash)
    if (!fs.existsSync(source)) {
      throw new AppError(
        'SNAPSHOT_MISSING',
        'The original snapshot object is missing from the project workspace.'
      )
    }
    ensureDir(path.dirname(absolute))
    fs.copyFileSync(source, absolute)
  }

  const afterHash = currentHash(absolute)
  const change = recordChange({
    sessionId: row.session_id,
    meetingId: row.meeting_id ?? undefined,
    taskId: taskId ?? row.task_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    agentId: row.agent_id ?? 'unknown',
    type: 'revert',
    path: relative,
    beforeHash: current.objectHash,
    afterHash,
    snapshotId: current.id,
    metadata: {
      originalChangeId: row.id,
      originalType: row.type
    }
  })
  return {
    change,
    changes: listChanges(row.session_id)
  }
}

export function verifySnapshotObject(hash: string): boolean {
  if (!hash) {
    return true
  }
  return fs.existsSync(objectPath(hash)) && isPathInside(root(), objectPath(hash))
}

export function revertTaskChanges(
  sessionId: string,
  taskId: string
): { reverted: number; changes: ChangeRecord[] } {
  const rows = database()
    .prepare(
      `SELECT * FROM change_events
       WHERE session_id = ? AND task_id = ? AND type IN ('write', 'patch', 'delete', 'move')
       ORDER BY created_at DESC`
    )
    .all(sessionId, taskId) as ChangeRow[]
  let reverted = 0
  for (const row of rows) {
    if (!row.path || !row.snapshot_id) {
      continue
    }
    try {
      revertChange(row.id, taskId)
      reverted += 1
    } catch (error) {
      if (error instanceof AppError && error.code === 'CHANGE_NOT_REVERTIBLE') {
        continue
      }
      throw error
    }
  }
  return {
    reverted,
    changes: listChanges(sessionId)
  }
}
