import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  McpCallAudit,
  McpServerConfig,
  McpServerDraft,
  McpServerPatch,
  McpTransport
} from '@shared/types'
import { getAppPaths } from '../config/appPaths'
import { createLogger } from '../config/logger'
import { deleteSecret, getSecret, setSecret } from '../config/secrets'
import { getCurrentProjectDatabase } from '../project/projectService'
import { readJsonFile, writeJsonAtomic } from '../utils/fs'
import { AppError } from '../errors'

const log = createLogger('mcp-store')

const secretRefSchema = z.object({
  key: z.string().min(1),
  secretKey: z.string().min(1)
})

const serverSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: z.enum(['stdio', 'http', 'sse']),
  enabled: z.boolean(),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  url: z.string(),
  env: z.array(secretRefSchema),
  headers: z.array(secretRefSchema),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative()
})

const catalogSchema = z.object({
  schemaVersion: z.number().int().positive(),
  servers: z.array(serverSchema)
})

type McpCatalog = z.infer<typeof catalogSchema>

let cache: McpCatalog | null = null

function catalogPath(): string {
  return getAppPaths().mcpServersPath
}

function load(): McpCatalog {
  if (cache) {
    return cache
  }
  const filePath = catalogPath()
  if (!fs.existsSync(filePath)) {
    cache = { schemaVersion: 1, servers: [] }
    writeJsonAtomic(filePath, cache)
    return cache
  }
  try {
    cache = catalogSchema.parse(readJsonFile<unknown>(filePath))
    return cache
  } catch (error) {
    const backup = `${filePath}.invalid-${Date.now()}`
    try {
      fs.copyFileSync(filePath, backup)
    } catch {
      log.warn('Could not back up invalid MCP catalog', { filePath })
    }
    cache = { schemaVersion: 1, servers: [] }
    writeJsonAtomic(filePath, cache)
    log.error('Invalid MCP catalog; reset to empty', { filePath, backup, error })
    return cache
  }
}

function persist(catalog: McpCatalog): void {
  writeJsonAtomic(catalogPath(), catalog)
  cache = catalog
}

function secretKeyPrefix(serverId: string, kind: 'env' | 'header'): string {
  return `mcp:${serverId}:${kind}:`
}

function secretKey(serverId: string, kind: 'env' | 'header', key: string): string {
  return `${secretKeyPrefix(serverId, kind)}${key}`
}

function validateTransport(transport: McpTransport): void {
  if (!['stdio', 'http', 'sse'].includes(transport)) {
    throw new AppError('MCP_TRANSPORT_INVALID', 'Unsupported MCP transport.')
  }
}

function normalizeDraft(draft: McpServerDraft): {
  name: string
  transport: McpTransport
  command: string
  args: string[]
  cwd: string
  url: string
  enabled: boolean
} {
  validateTransport(draft.transport)
  const name = draft.name.trim()
  if (!name) {
    throw new AppError('MCP_NAME_REQUIRED', 'Give this MCP server a name.')
  }
  if (draft.transport === 'stdio' && !draft.command?.trim()) {
    throw new AppError('MCP_COMMAND_REQUIRED', 'A stdio MCP server needs a command.')
  }
  if (draft.transport !== 'stdio' && !draft.url?.trim()) {
    throw new AppError('MCP_URL_REQUIRED', 'An HTTP or SSE MCP server needs a URL.')
  }
  return {
    name,
    transport: draft.transport,
    command: draft.transport === 'stdio' ? draft.command?.trim() || '' : '',
    args:
      draft.transport === 'stdio'
        ? (draft.args ?? []).map((arg) => arg.trim()).filter(Boolean)
        : [],
    cwd: draft.transport === 'stdio' ? draft.cwd?.trim() || '' : '',
    url: draft.transport === 'stdio' ? '' : draft.url?.trim() || '',
    enabled: draft.enabled ?? true
  }
}

function storeSecretSet(
  serverId: string,
  kind: 'env' | 'header',
  values: Record<string, string>,
  previous: Array<{ key: string; secretKey: string }>
): Array<{ key: string; secretKey: string }> {
  const next: Array<{ key: string; secretKey: string }> = []
  const seen = new Set<string>()
  for (const [rawKey, rawValue] of Object.entries(values)) {
    const key = rawKey.trim()
    if (!key) {
      continue
    }
    const existing = previous.find((entry) => entry.key === key)
    const refKey = existing?.secretKey ?? secretKey(serverId, kind, key)
    if (rawValue.length > 0) {
      setSecret(refKey, rawValue)
    } else if (!existing || !getSecret(refKey)) {
      throw new AppError(
        'MCP_SECRET_MISSING',
        `Provide a value for ${kind} "${key}" or remove it.`
      )
    }
    next.push({ key, secretKey: refKey })
    seen.add(key)
  }
  for (const previousRef of previous) {
    if (!seen.has(previousRef.key)) {
      deleteSecret(previousRef.secretKey)
    }
  }
  return next
}

export function listMcpServers(): McpServerConfig[] {
  return load().servers
}

export function getMcpServer(id: string): McpServerConfig {
  const server = load().servers.find((entry) => entry.id === id)
  if (!server) {
    throw new AppError('MCP_SERVER_NOT_FOUND', 'The MCP server no longer exists.')
  }
  return server
}

export function addMcpServer(draft: McpServerDraft): McpServerConfig {
  const normalized = normalizeDraft(draft)
  const id = `mcp-${randomUUID().slice(0, 8)}`
  const now = Date.now()
  const env = draft.env
    ? storeSecretSet(id, 'env', draft.env, [])
    : []
  const headers = draft.headers
    ? storeSecretSet(id, 'header', draft.headers, [])
    : []
  const server: McpServerConfig = {
    id,
    ...normalized,
    env,
    headers,
    createdAt: now,
    updatedAt: now
  }
  persist({
    schemaVersion: 1,
    servers: [...load().servers, server]
  })
  log.info('Added MCP server', {
    id,
    transport: server.transport,
    envKeys: env.map((entry) => entry.key),
    headerNames: headers.map((entry) => entry.key)
  })
  return server
}

export function updateMcpServer(patch: McpServerPatch): McpServerConfig {
  const current = getMcpServer(patch.id)
  const normalized = normalizeDraft({
    ...patch,
    command: patch.command ?? current.command,
    args: patch.args ?? current.args,
    cwd: patch.cwd ?? current.cwd,
    url: patch.url ?? current.url
  })
  const env = patch.env
    ? storeSecretSet(patch.id, 'env', patch.env, current.env)
    : current.env
  const headers = patch.headers
    ? storeSecretSet(patch.id, 'header', patch.headers, current.headers)
    : current.headers
  const server: McpServerConfig = {
    ...current,
    ...normalized,
    env,
    headers,
    updatedAt: Date.now()
  }
  persist({
    schemaVersion: 1,
    servers: load().servers.map((entry) => (entry.id === patch.id ? server : entry))
  })
  log.info('Updated MCP server', { id: server.id, transport: server.transport })
  return server
}

export function deleteMcpServer(id: string): McpServerConfig {
  const server = getMcpServer(id)
  for (const ref of [...server.env, ...server.headers]) {
    deleteSecret(ref.secretKey)
  }
  persist({
    schemaVersion: 1,
    servers: load().servers.filter((entry) => entry.id !== id)
  })
  log.info('Deleted MCP server', { id })
  return server
}

export function mcpServerSecrets(server: McpServerConfig): {
  env: Record<string, string>
  headers: Record<string, string>
} {
  const env: Record<string, string> = {}
  const headers: Record<string, string> = {}
  for (const ref of server.env) {
    const value = getSecret(ref.secretKey)
    if (value !== null) {
      env[ref.key] = value
    }
  }
  for (const ref of server.headers) {
    const value = getSecret(ref.secretKey)
    if (value !== null) {
      headers[ref.key] = value
    }
  }
  return { env, headers }
}

function logPath(serverId: string): string {
  return path.join(getAppPaths().mcpLogsDir, `${serverId}.log`)
}

export function appendMcpLog(serverId: string, text: string): void {
  try {
    const target = logPath(serverId)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.appendFileSync(
      target,
      `[${new Date().toISOString()}] ${text.replace(/\s+$/, '')}\n`,
      'utf8'
    )
  } catch (error) {
    log.warn('Could not append MCP log', { serverId, error })
  }
}

export function readMcpLog(serverId: string, maxLines = 300): string {
  try {
    const target = logPath(serverId)
    if (!fs.existsSync(target)) {
      return ''
    }
    const content = fs.readFileSync(target, 'utf8')
    const lines = content.split(/\r?\n/)
    return lines.slice(Math.max(0, lines.length - maxLines)).join('\n')
  } catch (error) {
    log.warn('Could not read MCP log', { serverId, error })
    return ''
  }
}

export function recordMcpCall(input: {
  serverId: string
  serverName: string
  toolName: string
  agentId?: string | null
  sessionId?: string | null
  meetingId?: string | null
  status: string
  durationMs?: number | null
  args?: unknown
  summary?: string | null
  error?: string | null
}): void {
  const projectDatabase = getCurrentProjectDatabase()
  if (!projectDatabase) {
    return
  }
  try {
    projectDatabase.db
      .prepare(
        `INSERT INTO mcp_calls
          (id, server_id, server_name, tool_name, agent_id, session_id, meeting_id,
           status, duration_ms, args_json, result_summary, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.serverId,
        input.serverName,
        input.toolName,
        input.agentId ?? null,
        input.sessionId ?? null,
        input.meetingId ?? null,
        input.status,
        input.durationMs ?? null,
        input.args === undefined ? null : JSON.stringify(input.args),
        input.summary ?? null,
        input.error ?? null,
        Date.now()
      )
  } catch (error) {
    log.warn('Could not record MCP audit row', { serverId: input.serverId, error })
  }
}

export function listMcpCalls(serverId?: string): McpCallAudit[] {
  const projectDatabase = getCurrentProjectDatabase()
  if (!projectDatabase) {
    return []
  }
  const rows = serverId
    ? (projectDatabase.db
        .prepare(
          'SELECT * FROM mcp_calls WHERE server_id = ? ORDER BY created_at DESC LIMIT 100'
        )
        .all(serverId) as Array<Record<string, unknown>>)
    : (projectDatabase.db
        .prepare('SELECT * FROM mcp_calls ORDER BY created_at DESC LIMIT 100')
        .all() as Array<Record<string, unknown>>)
  return rows.map((row) => ({
    id: String(row.id),
    serverId: String(row.server_id),
    serverName: String(row.server_name),
    toolName: String(row.tool_name),
    agentId: row.agent_id === null ? null : String(row.agent_id),
    sessionId: row.session_id === null ? null : String(row.session_id),
    meetingId: row.meeting_id === null ? null : String(row.meeting_id),
    status: String(row.status),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    summary: row.result_summary === null ? null : String(row.result_summary),
    error: row.error === null ? null : String(row.error),
    createdAt: Number(row.created_at)
  }))
}
