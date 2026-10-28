import { randomUUID } from 'node:crypto'
import type {
  ChatAttachment,
  ChatMessage,
  ChatMessageMetadata,
  ChatMode,
  ChatSessionDetail,
  ChatSessionSummary,
  ChatToolTrace,
  ChatUsage
} from '@shared/types'
import { AppError } from '../errors'
import {
  getCurrentProjectDatabase,
  getCurrentProjectRoot
} from '../project/projectService'
import { getAttachmentsForMessages } from './attachments'

type SessionRow = {
  id: string
  title: string
  status: string
  mode: ChatMode
  agent_id: string | null
  created_at: number
  updated_at: number
  last_opened_at: number
}

type SessionListRow = SessionRow & {
  message_count: number
  preview: string | null
}

type MessageRow = {
  id: string
  session_id: string
  seq: number
  sender_type: string
  sender_agent_id: string | null
  sender_name: string | null
  target_type: string
  target_agent_id: string | null
  kind: string
  content: string
  metadata_json: string | null
  created_at: number
}

type UsageInput = {
  sessionId: string
  agentId: string
  providerId: string
  modelId: string
  usage: ChatUsage
}

function database() {
  const projectDatabase = getCurrentProjectDatabase()
  if (!projectDatabase) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }
  return projectDatabase.db
}

function requireRoot(): string {
  const root = getCurrentProjectRoot()
  if (!root) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }
  return root
}

function parseMetadata(raw: string | null): ChatMessageMetadata | undefined {
  if (!raw) {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined
    }
    return parsed as ChatMessageMetadata
  } catch {
    return undefined
  }
}

function toSummary(row: SessionListRow | SessionRow): ChatSessionSummary {
  const listRow = row as SessionListRow
  return {
    id: row.id,
    agentId: row.agent_id ?? '',
    title: row.title,
    mode: row.mode,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
    messageCount: listRow.message_count ?? 0,
    preview: listRow.preview ?? null
  }
}

function toMessage(
  row: MessageRow,
  attachments: ChatAttachment[],
  includeMetadata: boolean
): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    role: row.sender_type === 'boss' ? 'user' : 'assistant',
    senderName: row.sender_name ?? (row.sender_type === 'boss' ? 'You' : 'Agent'),
    content: row.content,
    createdAt: row.created_at,
    attachments,
    metadata: includeMetadata ? parseMetadata(row.metadata_json) : undefined
  }
}

function sessionRow(id: string): SessionRow {
  const row = database()
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(id) as SessionRow | undefined
  if (!row) {
    throw new AppError('CHAT_SESSION_NOT_FOUND', 'The conversation no longer exists.')
  }
  return row
}

export function createChatSession(
  agentId: string,
  mode: ChatMode = 'plan',
  title = 'New conversation'
): ChatSessionDetail {
  const id = randomUUID()
  const now = Date.now()
  database()
    .prepare(
      `INSERT INTO sessions (id, title, status, mode, agent_id, created_at, updated_at, last_opened_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`
    )
    .run(id, title, mode, agentId, now, now, now)
  return {
    session: toSummary(sessionRow(id)),
    messages: []
  }
}

export function setChatSessionMode(
  sessionId: string,
  mode: ChatMode
): ChatSessionDetail {
  sessionRow(sessionId)
  database()
    .prepare('UPDATE sessions SET mode = ?, updated_at = ? WHERE id = ?')
    .run(mode, Date.now(), sessionId)
  return getChatSession(sessionId)
}

export function listChatSessions(agentId?: string): ChatSessionSummary[] {
  const base = `
    SELECT s.*,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
      (SELECT m.content FROM messages m WHERE m.session_id = s.id AND m.content != ''
        ORDER BY m.seq DESC LIMIT 1) AS preview
    FROM sessions s`
  const rows = agentId
    ? (database()
        .prepare(
          `${base} WHERE s.agent_id = ?
           AND NOT EXISTS (SELECT 1 FROM meetings mt WHERE mt.session_id = s.id)
           ORDER BY s.last_opened_at DESC`
        )
        .all(agentId) as SessionListRow[])
    : (database()
        .prepare(
          `${base} WHERE NOT EXISTS (SELECT 1 FROM meetings mt WHERE mt.session_id = s.id)
           ORDER BY s.last_opened_at DESC`
        )
        .all() as SessionListRow[])
  return rows.map((row) => toSummary(row))
}

export function getChatSession(sessionId: string, touch = true): ChatSessionDetail {
  const row = sessionRow(sessionId)
  if (touch) {
    const now = Date.now()
    database()
      .prepare('UPDATE sessions SET last_opened_at = ?, updated_at = updated_at WHERE id = ?')
      .run(now, sessionId)
    row.last_opened_at = now
  }
  const count = database()
    .prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?')
    .get(sessionId) as { count: number } | undefined
  const preview = database()
    .prepare(
      "SELECT content FROM messages WHERE session_id = ? AND content != '' ORDER BY seq DESC LIMIT 1"
    )
    .get(sessionId) as { content?: string } | undefined

  return {
    session: toSummary({
      ...row,
      message_count: count?.count ?? 0,
      preview: preview?.content ?? null
    }),
    messages: getChatMessages(sessionId, true).filter((message) => {
      if (message.role !== 'assistant' || message.content.trim()) {
        return true
      }
      return message.metadata?.status !== 'streaming'
    })
  }
}

export function getChatSessionSummary(sessionId: string): ChatSessionSummary {
  const row = sessionRow(sessionId)
  const count = database()
    .prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?')
    .get(sessionId) as { count: number } | undefined
  const preview = database()
    .prepare(
      "SELECT content FROM messages WHERE session_id = ? AND content != '' ORDER BY seq DESC LIMIT 1"
    )
    .get(sessionId) as { content?: string } | undefined
  return toSummary({
    ...row,
    message_count: count?.count ?? 0,
    preview: preview?.content ?? null
  })
}

export function getChatMessages(
  sessionId: string,
  includeAttachmentData: boolean,
  includeMetadata = true
): ChatMessage[] {
  const rows = database()
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC')
    .all(sessionId) as MessageRow[]
  const attachments = getAttachmentsForMessages(
    rows.map((row) => row.id),
    includeAttachmentData
  )
  return rows.map((row) =>
    toMessage(row, attachments.get(row.id) ?? [], includeMetadata)
  )
}

export function getChatMessage(messageId: string, includeAttachmentData = true): ChatMessage {
  const row = database()
    .prepare('SELECT * FROM messages WHERE id = ?')
    .get(messageId) as MessageRow | undefined
  if (!row) {
    throw new AppError('CHAT_MESSAGE_NOT_FOUND', 'The message no longer exists.')
  }
  const attachments = getAttachmentsForMessages([row.id], includeAttachmentData)
  return toMessage(row, attachments.get(row.id) ?? [], true)
}

export function appendChatMessage(input: {
  sessionId: string
  agentId: string
  role: 'user' | 'assistant'
  senderName: string
  content: string
  metadata?: ChatMessageMetadata
}): ChatMessage {
  const seqRow = database()
    .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE session_id = ?')
    .get(input.sessionId) as { seq: number } | undefined
  const id = randomUUID()
  const now = Date.now()
  database()
    .prepare(
      `INSERT INTO messages
        (id, session_id, meeting_id, seq, sender_type, sender_agent_id, sender_name,
         target_type, target_agent_id, kind, content, metadata_json, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'chat', ?, ?, ?)`
    )
    .run(
      id,
      input.sessionId,
      seqRow?.seq ?? 1,
      input.role === 'user' ? 'boss' : 'agent',
      input.role === 'assistant' ? input.agentId : null,
      input.senderName,
      input.role === 'user' ? 'agent' : 'boss',
      input.role === 'assistant' ? input.agentId : null,
      input.content,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now
    )
  database()
    .prepare(
      'UPDATE sessions SET updated_at = ?, last_opened_at = ?, status = ? WHERE id = ?'
    )
    .run(now, now, 'active', input.sessionId)
  return {
    id,
    sessionId: input.sessionId,
    seq: seqRow?.seq ?? 1,
    role: input.role,
    senderName: input.senderName,
    content: input.content,
    createdAt: now,
    attachments: [],
    metadata: input.metadata
  }
}

export function updateChatMessage(input: {
  messageId: string
  content?: string
  metadata?: ChatMessageMetadata
}): void {
  const current = database()
    .prepare('SELECT content, metadata_json FROM messages WHERE id = ?')
    .get(input.messageId) as { content: string; metadata_json: string | null } | undefined
  if (!current) {
    throw new AppError('CHAT_MESSAGE_NOT_FOUND', 'The message no longer exists.')
  }
  const content = input.content ?? current.content
  const metadataJson =
    input.metadata === undefined
      ? current.metadata_json
      : JSON.stringify(input.metadata)
  database()
    .prepare('UPDATE messages SET content = ?, metadata_json = ? WHERE id = ?')
    .run(content, metadataJson, input.messageId)
}

export function deleteChatMessage(messageId: string): void {
  database().prepare('DELETE FROM messages WHERE id = ?').run(messageId)
}

export function setChatSessionTitle(sessionId: string, title: string): void {
  const trimmed = title.trim().slice(0, 90)
  if (!trimmed) {
    return
  }
  database()
    .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
    .run(trimmed, Date.now(), sessionId)
}

export function touchChatSession(sessionId: string): void {
  database()
    .prepare(
      "UPDATE sessions SET status = 'active', updated_at = ?, last_opened_at = ? WHERE id = ?"
    )
    .run(Date.now(), Date.now(), sessionId)
}

export function recordUsage(input: UsageInput): void {
  const usage = input.usage
  database()
    .prepare(
      `INSERT INTO usage_records
        (id, meeting_id, turn_id, agent_id, provider_id, model_id,
         input_tokens, output_tokens, cached_tokens, cost_usd, created_at)
       VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      randomUUID(),
      input.agentId,
      input.providerId,
      input.modelId,
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0,
      usage.cachedTokens ?? 0,
      usage.costUsd ?? 0,
      Date.now()
    )
}

export function recordToolCall(input: {
  id: string
  sessionId: string
  agentId: string
  tool: ChatToolTrace
}): void {
  database()
    .prepare(
      `INSERT INTO tool_calls
        (id, meeting_id, turn_id, agent_id, tool_name, args_json, status,
         approval_id, duration_ms, result_summary, created_at, session_id)
       VALUES (?, NULL, NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
    )
    .run(
      input.id,
      input.agentId,
      input.tool.toolName,
      JSON.stringify(input.tool.input),
      input.tool.status,
      Date.now(),
      input.sessionId
    )
}

export function finishToolCall(input: {
  id: string
  tool: ChatToolTrace
}): void {
  database()
    .prepare(
      'UPDATE tool_calls SET status = ?, duration_ms = ?, result_summary = ? WHERE id = ?'
    )
    .run(
      input.tool.status,
      input.tool.durationMs ?? null,
      input.tool.error ?? summarizeToolOutput(input.tool.output),
      input.id
    )
}

function summarizeToolOutput(output: unknown): string | null {
  if (output === undefined) {
    return null
  }
  try {
    const text = typeof output === 'string' ? output : JSON.stringify(output)
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text
  } catch {
    return null
  }
}

export function getChatRoot(): string {
  return requireRoot()
}
