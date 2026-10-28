import { randomUUID } from 'node:crypto'
import type {
  ChatToolTrace,
  ChangeRecord,
  MemoryBundle,
  MemoryEntry,
  MemoryKind,
  MemoryPromptContext,
  MemoryPromptEntry,
  MemoryPromptSummary,
  MemoryScope,
  MemorySummary
} from '@shared/types'
import { AppError } from '../errors'
import {
  getCurrentProjectDatabase
} from '../project/projectService'
import { listChanges } from '../changes/changeService'

type MemoryRow = {
  id: string
  agent_id: string | null
  scope: string
  kind: string
  session_id: string | null
  title: string
  content: string
  tags_json: string | null
  importance: number
  pinned: number
  status: string
  created_at: number
  updated_at: number
  last_accessed_at: number | null
}

type SummaryRow = {
  id: string
  agent_id: string | null
  scope: string
  level: string
  session_id: string | null
  content: string
  version: number
  updated_at: number
}

type TurnReport = {
  summary: string
  commitments: string[]
  filesChanged: Array<{ path: string; type: string }>
  blockers: string[]
  nextSteps: string[]
  decisions: string[]
}

function database() {
  const projectDatabase = getCurrentProjectDatabase()
  if (!projectDatabase) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }
  return projectDatabase.db
}

function parseJson(raw: string | null): unknown {
  if (!raw) {
    return undefined
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function toMemoryEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    agentId: row.agent_id,
    scope: row.scope as MemoryScope,
    kind: row.kind as MemoryKind,
    sessionId: row.session_id,
    title: row.title,
    content: row.content,
    tags: parseJson(row.tags_json),
    importance: row.importance,
    pinned: row.pinned === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    lastAccessedAt: row.last_accessed_at ?? undefined
  }
}

function toMemorySummary(row: SummaryRow): MemorySummary {
  return {
    id: row.id,
    agentId: row.agent_id,
    scope: row.scope,
    level: row.level,
    sessionId: row.session_id,
    content: row.content,
    version: row.version,
    updatedAt: row.updated_at
  }
}

function cleanText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, '[code block]')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function uniqueLines(lines: string[], limit: number): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const line of lines) {
    const normalized = cleanText(line.replace(/^[-*\d.)\s]+/, ''))
    if (!normalized || normalized.length < 4) {
      continue
    }
    const key = normalized.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(normalized.length > 300 ? `${normalized.slice(0, 300)}...` : normalized)
    if (result.length >= limit) {
      break
    }
  }
  return result
}

function extractMatchingLines(text: string, pattern: RegExp, limit: number): string[] {
  return uniqueLines(
    text
      .split(/\r?\n/)
      .filter((line) => pattern.test(line))
      .filter((line) => !/^#{1,4}\s/.test(line.trim())),
    limit
  )
}

function extractNextSteps(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const collected: string[] = []
  let inSection = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^#{1,4}\s*(next steps?|next moves?|todo|follow-ups?)\b/i.test(trimmed)) {
      inSection = true
      continue
    }
    if (inSection && /^#{1,4}\s/.test(trimmed)) {
      break
    }
    if (inSection) {
      if (!trimmed) {
        if (collected.length > 0) {
          break
        }
        continue
      }
      if (/^([-*]|\d+\.)\s+/.test(trimmed)) {
        collected.push(trimmed)
      }
    }
  }
  return uniqueLines(
    collected.length > 0
      ? collected
      : text
          .split(/\r?\n/)
          .filter((line) => /\b(next|need to|should|will)\b/i.test(line)),
    5
  )
}

function buildTurnReport(input: {
  assistantText: string
  changes: ChangeRecord[]
  toolTraces: ChatToolTrace[]
}): TurnReport {
  const summary =
    cleanText(input.assistantText).slice(0, 700) ||
    `Completed a run with ${input.toolTraces.length} tool calls.`
  const filesChanged = [
    ...new Map(
      input.changes
        .filter((change) => change.path && change.type !== 'command')
        .map((change) => [
          `${change.type}:${change.path}`,
          { path: change.path ?? '', type: change.type }
        ])
    ).values()
  ]
  const commitments = extractMatchingLines(
    input.assistantText,
    /\b(will|i'll|we'll|need to|should|todo|next)\b/i,
    5
  )
  const blockers = extractMatchingLines(
    input.assistantText,
    /\b(blocked|cannot|can't|failed|error|missing|unable|requires approval)\b/i,
    4
  )
  const decisions = extractMatchingLines(
    input.assistantText,
    /\b(decided|decision|chose|we'll use|will use|instead)\b/i,
    4
  )
  const nextSteps = extractNextSteps(input.assistantText)
  return {
    summary,
    commitments,
    filesChanged,
    blockers,
    decisions,
    nextSteps:
      nextSteps.length > 0
        ? nextSteps
        : commitments.slice(0, 3)
  }
}

function listLines(label: string, items: string[]): string {
  if (items.length === 0) {
    return `${label}: none`
  }
  return `${label}:\n${items.map((item) => `- ${item}`).join('\n')}`
}

function formatTurnReport(report: TurnReport): string {
  return [
    `Summary: ${report.summary}`,
    listLines(
      'Files changed',
      report.filesChanged.map((file) => `${file.type}: ${file.path}`)
    ),
    listLines('Commitments', report.commitments),
    listLines('Blockers', report.blockers),
    listLines('Decisions', report.decisions),
    listLines('Next steps', report.nextSteps)
  ].join('\n\n')
}

function formatSharedUpdate(report: TurnReport, mode: string): string {
  return [
    `Build summary (${mode}): ${report.summary}`,
    listLines(
      'Repository changes',
      report.filesChanged.map((file) => `${file.type}: ${file.path}`)
    ),
    listLines('Decisions', report.decisions),
    listLines('Next steps', report.nextSteps)
  ].join('\n\n')
}

function insertMemory(input: {
  agentId: string | null
  scope: MemoryScope
  kind: MemoryKind
  sessionId: string | null
  title: string
  content: string
  tags: unknown
  importance: number
  sourceMessageIds?: string[]
}): MemoryEntry {
  const id = randomUUID()
  const now = Date.now()
  database()
    .prepare(
      `INSERT INTO memory_entries
        (id, agent_id, scope, kind, meeting_id, turn_id, task_id, title, content,
         tags_json, importance, source_message_ids_json, status, created_at,
         last_accessed_at, session_id, pinned, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, 0, ?)`
    )
    .run(
      id,
      input.agentId,
      input.scope,
      input.kind,
      input.title,
      input.content,
      JSON.stringify(input.tags),
      input.importance,
      input.sourceMessageIds ? JSON.stringify(input.sourceMessageIds) : null,
      now,
      input.sessionId,
      now
    )
  return toMemoryEntry(
    database()
      .prepare('SELECT * FROM memory_entries WHERE id = ?')
      .get(id) as MemoryRow
  )
}

function upsertSummary(input: {
  agentId: string | null
  scope: string
  level: string
  sessionId: string | null
  content: string
}): MemorySummary {
  const existing = database()
    .prepare(
      `SELECT * FROM memory_summaries
       WHERE scope = ? AND level = ?
         AND IFNULL(agent_id, '') = IFNULL(?, '')
         AND IFNULL(session_id, '') = IFNULL(?, '')
       LIMIT 1`
    )
    .get(
      input.scope,
      input.level,
      input.agentId,
      input.sessionId
    ) as SummaryRow | undefined
  const now = Date.now()
  const content = input.content.slice(0, 8000)
  if (existing) {
    database()
      .prepare(
        'UPDATE memory_summaries SET content = ?, version = version + 1, updated_at = ? WHERE id = ?'
      )
      .run(content, now, existing.id)
    return toMemorySummary({
      ...existing,
      content,
      version: existing.version + 1,
      updated_at: now
    })
  }
  const id = randomUUID()
  database()
    .prepare(
      `INSERT INTO memory_summaries
        (id, agent_id, scope, level, content, version, updated_at, session_id)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(
      id,
      input.agentId,
      input.scope,
      input.level,
      content,
      now,
      input.sessionId
    )
  return toMemorySummary({
    id,
    agent_id: input.agentId,
    scope: input.scope,
    level: input.level,
    session_id: input.sessionId,
    content,
    version: 1,
    updated_at: now
  })
}

function rebuildRollingSummary(input: {
  agentId: string | null
  scope: string
  kinds: string[]
}): MemorySummary {
  const placeholders = input.kinds.map(() => '?').join(',')
  const rows = database()
    .prepare(
      `SELECT * FROM memory_entries
       WHERE status = 'active' AND scope = ? AND IFNULL(agent_id, '') = IFNULL(?, '')
         AND kind IN (${placeholders})
       ORDER BY created_at DESC LIMIT 8`
    )
    .all(input.scope, input.agentId, ...input.kinds) as MemoryRow[]
  const content = rows
    .reverse()
    .map((row) => {
      const firstLine = row.content.split(/\r?\n/).slice(0, 4).join(' ')
      return `- ${row.title}: ${firstLine.slice(0, 500)}`
    })
    .join('\n')
  return upsertSummary({
    agentId: input.agentId,
    scope: input.scope,
    level: 'rolling',
    sessionId: null,
    content: content || 'No rolling memory yet.'
  })
}

export function recordTurnMemories(input: {
  sessionId: string
  sessionTitle: string
  agentId: string
  agentName: string
  mode: string
  userText: string
  assistantText: string
  assistantMessageId: string
  startedAt: number
  toolTraces: ChatToolTrace[]
}): MemoryBundle {
  const changes = listChanges(input.sessionId).filter(
    (change) => change.createdAt >= input.startedAt - 500
  )
  const report = buildTurnReport({
    assistantText: input.assistantText,
    changes,
    toolTraces: input.toolTraces
  })
  const importance = Math.min(
    0.9,
    0.55 +
      report.filesChanged.length * 0.05 +
      report.decisions.length * 0.04 +
      report.blockers.length * 0.04
  )
  const created: MemoryEntry[] = []
  created.push(
    insertMemory({
      agentId: input.agentId,
      scope: 'personal',
      kind: 'turn_report',
      sessionId: input.sessionId,
      title: `${input.agentName} - ${input.sessionTitle}`,
      content: formatTurnReport(report),
      tags: {
        report,
        mode: input.mode,
        sessionTitle: input.sessionTitle,
        userText: input.userText.slice(0, 1000)
      },
      importance,
      sourceMessageIds: [input.assistantMessageId]
    })
  )
  created.push(
    insertMemory({
      agentId: null,
      scope: 'shared',
      kind: 'project_update',
      sessionId: input.sessionId,
      title: `Project update - ${input.sessionTitle}`,
      content: formatSharedUpdate(report, input.mode),
      tags: {
        summary: report.summary,
        filesChanged: report.filesChanged,
        nextSteps: report.nextSteps,
        agentId: input.agentId
      },
      importance: Math.min(0.8, importance),
      sourceMessageIds: [input.assistantMessageId]
    })
  )

  for (const decision of report.decisions.slice(0, 3)) {
    created.push(
      insertMemory({
        agentId: null,
        scope: 'shared',
        kind: 'decision',
        sessionId: input.sessionId,
        title: 'Decision',
        content: decision,
        tags: { sessionTitle: input.sessionTitle, agentId: input.agentId },
        importance: 0.7,
        sourceMessageIds: [input.assistantMessageId]
      })
    )
  }
  for (const commitment of report.commitments.slice(0, 3)) {
    created.push(
      insertMemory({
        agentId: input.agentId,
        scope: 'personal',
        kind: 'commitment',
        sessionId: input.sessionId,
        title: 'Commitment',
        content: commitment,
        tags: { sessionTitle: input.sessionTitle },
        importance: 0.65,
        sourceMessageIds: [input.assistantMessageId]
      })
    )
  }
  for (const blocker of report.blockers.slice(0, 2)) {
    created.push(
      insertMemory({
        agentId: input.agentId,
        scope: 'personal',
        kind: 'blocker',
        sessionId: input.sessionId,
        title: 'Blocker',
        content: blocker,
        tags: { sessionTitle: input.sessionTitle },
        importance: 0.7,
        sourceMessageIds: [input.assistantMessageId]
      })
    )
  }

  const priorSession = database()
    .prepare(
      `SELECT content FROM memory_summaries
       WHERE scope = 'session' AND level = 'session' AND session_id = ? AND agent_id = ?
       LIMIT 1`
    )
    .get(input.sessionId, input.agentId) as { content?: string } | undefined
  const sessionSummary = [
    priorSession?.content ?? '',
    `- ${report.summary}`
  ]
    .filter(Boolean)
    .join('\n')
    .slice(-7000)
  const sessionSummaryRecord = upsertSummary({
    agentId: input.agentId,
    scope: 'session',
    level: 'session',
    sessionId: input.sessionId,
    content: sessionSummary
  })
  const personalRolling = rebuildRollingSummary({
    agentId: input.agentId,
    scope: 'personal',
    kinds: ['turn_report', 'commitment', 'blocker']
  })
  const sharedRolling = rebuildRollingSummary({
    agentId: null,
    scope: 'shared',
    kinds: ['project_update', 'decision']
  })

  return {
    entries: created,
    summaries: [sessionSummaryRecord, personalRolling, sharedRolling]
  }
}

function tokenize(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/)
        .filter((token) => token.length >= 3)
    )
  ].slice(0, 24)
}

function scoreEntry(
  row: MemoryRow,
  tokens: string[],
  agentId: string,
  now: number
): number {
  const haystack = `${row.title}\n${row.content}\n${row.tags_json ?? ''}`.toLowerCase()
  const keywordScore = tokens.reduce(
    (total, token) => total + (haystack.includes(token) ? 1 : 0),
    0
  )
  const ageDays = Math.max(0, (now - row.created_at) / 86_400_000)
  const recencyScore = Math.max(0, 3 - ageDays / 7)
  const agentBonus = row.scope === 'personal' && row.agent_id === agentId ? 0.6 : 0.2
  return (
    keywordScore * 2.4 +
    row.importance * 2 +
    (row.pinned === 1 ? 6 : 0) +
    recencyScore +
    agentBonus
  )
}

function allowedMemoryRows(agentId: string): MemoryRow[] {
  return database()
    .prepare(
      `SELECT * FROM memory_entries
       WHERE status = 'active'
         AND (scope = 'shared' OR (scope = 'personal' AND agent_id = ?))
       ORDER BY pinned DESC, updated_at DESC
       LIMIT 500`
    )
    .all(agentId) as MemoryRow[]
}

export function searchMemory(input: {
  agentId: string
  query: string
  limit?: number
}): MemoryPromptEntry[] {
  const tokens = tokenize(input.query)
  const now = Date.now()
  const rows = allowedMemoryRows(input.agentId)
  const scored = rows
    .map((row) => ({
      row,
      score: scoreEntry(row, tokens, input.agentId, now)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(Math.max(input.limit ?? 6, 1), 12))

  if (scored.length > 0) {
    const statement = database().prepare(
      'UPDATE memory_entries SET last_accessed_at = ? WHERE id = ?'
    )
    for (const entry of scored) {
      statement.run(now, entry.row.id)
    }
  }

  return scored.map(({ row, score }) => ({
    id: row.id,
    scope: row.scope as MemoryScope,
    kind: row.kind as MemoryKind,
    title: row.title,
    content:
      row.content.length > 1400 ? `${row.content.slice(0, 1400)}...` : row.content,
    pinned: row.pinned === 1,
    score: Number(score.toFixed(3))
  }))
}

function getSummary(
  scope: string,
  level: string,
  agentId: string | null,
  sessionId: string | null
): MemorySummary | null {
  const row = database()
    .prepare(
      `SELECT * FROM memory_summaries
       WHERE scope = ? AND level = ?
         AND IFNULL(agent_id, '') = IFNULL(?, '')
         AND IFNULL(session_id, '') = IFNULL(?, '')
       LIMIT 1`
    )
    .get(scope, level, agentId, sessionId) as SummaryRow | undefined
  return row ? toMemorySummary(row) : null
}

export function retrieveMemoryContext(input: {
  agentId: string
  sessionId: string
  query: string
  limit?: number
}): MemoryPromptContext {
  const entries = searchMemory({
    agentId: input.agentId,
    query: input.query,
    limit: input.limit ?? 5
  })
  const summaries: MemoryPromptSummary[] = []
  const sessionSummary = getSummary(
    'session',
    'session',
    input.agentId,
    input.sessionId
  )
  if (sessionSummary) {
    summaries.push({
      scope: 'session',
      level: 'session',
      content: sessionSummary.content.slice(0, 3000)
    })
  }
  const personal = getSummary('personal', 'rolling', input.agentId, null)
  if (personal) {
    summaries.push({
      scope: 'personal',
      level: 'rolling',
      content: personal.content.slice(0, 3000)
    })
  }
  const shared = getSummary('shared', 'rolling', null, null)
  if (shared) {
    summaries.push({
      scope: 'shared',
      level: 'rolling',
      content: shared.content.slice(0, 3000)
    })
  }
  return { entries, summaries }
}

export function listMemory(): MemoryBundle {
  const entries = database()
    .prepare(
      `SELECT * FROM memory_entries
       WHERE status = 'active'
       ORDER BY pinned DESC, updated_at DESC
       LIMIT 250`
    )
    .all() as MemoryRow[]
  const summaries = database()
    .prepare(
      'SELECT * FROM memory_summaries ORDER BY updated_at DESC LIMIT 24'
    )
    .all() as SummaryRow[]
  return {
    entries: entries.map(toMemoryEntry),
    summaries: summaries.map(toMemorySummary)
  }
}

export function toggleMemoryPin(id: string, pinned: boolean): MemoryEntry {
  const existing = database()
    .prepare('SELECT * FROM memory_entries WHERE id = ?')
    .get(id) as MemoryRow | undefined
  if (!existing) {
    throw new AppError('MEMORY_NOT_FOUND', 'The memory entry no longer exists.')
  }
  const now = Date.now()
  database()
    .prepare(
      "UPDATE memory_entries SET pinned = ?, updated_at = ? WHERE id = ? AND status = 'active'"
    )
    .run(pinned ? 1 : 0, now, id)
  return toMemoryEntry(
    database()
      .prepare('SELECT * FROM memory_entries WHERE id = ?')
      .get(id) as MemoryRow
  )
}

function rebuildSessionSummary(sessionId: string, agentId: string): void {
  const rows = database()
    .prepare(
      `SELECT * FROM memory_entries
       WHERE status = 'active' AND scope = 'personal' AND kind = 'turn_report'
         AND agent_id = ? AND session_id = ?
       ORDER BY created_at ASC LIMIT 40`
    )
    .all(agentId, sessionId) as MemoryRow[]
  const content = rows
    .map((row) => `- ${row.content.split(/\r?\n/)[0]?.replace(/^Summary:\s*/i, '') ?? row.title}`)
    .join('\n')
  upsertSummary({
    agentId,
    scope: 'session',
    level: 'session',
    sessionId,
    content: content || 'No session memory yet.'
  })
}

export function deleteMemory(id: string): void {
  const result = database()
    .prepare(
      "UPDATE memory_entries SET status = 'deleted', updated_at = ? WHERE id = ? AND status = 'active'"
    )
    .run(Date.now(), id)
  if (result.changes !== 1) {
    throw new AppError('MEMORY_NOT_FOUND', 'The memory entry no longer exists.')
  }
  const row = database()
    .prepare('SELECT * FROM memory_entries WHERE id = ?')
    .get(id) as MemoryRow | undefined
  if (!row) {
    return
  }
  if (row.scope === 'shared') {
    rebuildRollingSummary({
      agentId: null,
      scope: 'shared',
      kinds: ['project_update', 'decision']
    })
  } else if (row.agent_id) {
    rebuildRollingSummary({
      agentId: row.agent_id,
      scope: 'personal',
      kinds: ['turn_report', 'commitment', 'blocker']
    })
  }
  if (row.session_id && row.agent_id) {
    rebuildSessionSummary(row.session_id, row.agent_id)
  }
}

export function memorySummaryForTool(input: {
  agentId: string
  query: string
  limit?: number
}): {
  entries: MemoryPromptEntry[]
  summaries: MemoryPromptSummary[]
} {
  const entries = searchMemory(input)
  const summaries: MemoryPromptSummary[] = []
  const personal = getSummary('personal', 'rolling', input.agentId, null)
  if (personal) {
    summaries.push({
      scope: 'personal',
      level: 'rolling',
      content: personal.content.slice(0, 2000)
    })
  }
  const shared = getSummary('shared', 'rolling', null, null)
  if (shared) {
    summaries.push({
      scope: 'shared',
      level: 'rolling',
      content: shared.content.slice(0, 2000)
    })
  }
  return { entries, summaries }
}


