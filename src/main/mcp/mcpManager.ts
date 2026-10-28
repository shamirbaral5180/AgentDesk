import type {
  McpProjectConfig,
  McpServerConfig,
  McpServerStatus,
  McpServerView,
  McpToolInfo,
  McpToolPolicy
} from '@shared/types'
import { AppError } from '../errors'
import {
  appendMcpLog,
  getMcpServer,
  listMcpServers,
  recordMcpCall
} from './mcpStore'
import {
  callMcpTool,
  initializeMcp,
  listMcpTools,
  openMcpConnection,
  type McpConnection,
  type McpToolDescriptor
} from './mcpClient'

type RuntimeState = {
  status: McpServerStatus
  tools: McpToolDescriptor[]
  connection: McpConnection | null
}

const states = new Map<string, RuntimeState>()

function stateFor(serverId: string): RuntimeState {
  const existing = states.get(serverId)
  if (existing) {
    return existing
  }
  const state: RuntimeState = {
    status: {
      state: 'stopped',
      toolCount: 0,
      lastError: null
    },
    tools: [],
    connection: null
  }
  states.set(serverId, state)
  return state
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'tool'
}

function namespacedToolName(serverId: string, toolName: string): string {
  return `mcp__${sanitizeSegment(serverId).slice(0, 24)}__${sanitizeSegment(toolName).slice(0, 32)}`
}

function defaultPolicy(tool: McpToolDescriptor): McpToolPolicy {
  if (tool.annotations.readOnlyHint) {
    return 'allow'
  }
  return 'ask'
}

function policyFor(
  serverId: string,
  tool: McpToolDescriptor,
  project?: McpProjectConfig
): McpToolPolicy {
  const name = namespacedToolName(serverId, tool.name)
  return project?.toolPolicies[name] ?? defaultPolicy(tool)
}

function toolInfo(
  server: McpServerConfig,
  tool: McpToolDescriptor,
  project?: McpProjectConfig
): McpToolInfo {
  const policy = policyFor(server.id, tool, project)
  return {
    serverId: server.id,
    serverName: server.name,
    name: tool.name,
    namespacedName: namespacedToolName(server.id, tool.name),
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    policy,
    destructive: tool.annotations.destructiveHint === true,
    readOnly: tool.annotations.readOnlyHint === true
  }
}

function view(server: McpServerConfig, project?: McpProjectConfig): McpServerView {
  const state = stateFor(server.id)
  return {
    server,
    status: {
      ...state.status,
      toolCount: state.tools.length
    },
    tools: state.tools.map((tool) => toolInfo(server, tool, project)),
    envKeys: server.env.map((entry) => entry.key),
    headerNames: server.headers.map((entry) => entry.key)
  }
}

export function listServerViews(project?: McpProjectConfig): McpServerView[] {
  return listMcpServers().map((server) => view(server, project))
}

export function serverView(serverId: string, project?: McpProjectConfig): McpServerView {
  return view(getMcpServer(serverId), project)
}

export async function ensureServerReady(serverId: string): Promise<McpServerView> {
  const server = getMcpServer(serverId)
  const state = stateFor(serverId)
  if (state.connection && state.status.state === 'ready') {
    return view(server)
  }
  if (state.connection) {
    state.connection.close()
    state.connection = null
  }
  state.status = {
    state: 'starting',
    toolCount: 0,
    lastError: null,
    startedAt: Date.now()
  }
  appendMcpLog(server.id, 'connecting')
  try {
    const connection = openMcpConnection(server)
    state.connection = connection
    state.status.pid = connection.pid
    await initializeMcp(connection, server)
    const tools = await listMcpTools(connection)
    state.tools = tools
    state.status = {
      state: 'ready',
      toolCount: tools.length,
      lastError: null,
      pid: connection.pid,
      startedAt: state.status.startedAt,
      lastCheckedAt: Date.now()
    }
    appendMcpLog(server.id, `ready with ${tools.length} tools`)
    return view(server)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    state.status = {
      state: 'error',
      toolCount: 0,
      lastError: message,
      startedAt: state.status.startedAt,
      lastCheckedAt: Date.now()
    }
    if (state.connection) {
      state.connection.close()
      state.connection = null
    }
    appendMcpLog(server.id, `connection failed: ${message}`)
    throw new AppError('MCP_CONNECT_FAILED', `Could not connect to ${server.name}: ${message}`)
  }
}

export async function testServer(serverId: string): Promise<McpServerView> {
  return ensureServerReady(serverId)
}

export async function restartServer(serverId: string): Promise<McpServerView> {
  closeServer(serverId)
  return ensureServerReady(serverId)
}

export async function discoverTools(serverId: string): Promise<McpServerView> {
  return ensureServerReady(serverId)
}

export function closeServer(serverId: string): void {
  const state = states.get(serverId)
  if (!state) {
    return
  }
  state.connection?.close()
  state.connection = null
  state.tools = []
  state.status = {
    state: 'stopped',
    toolCount: 0,
    lastError: null
  }
  appendMcpLog(serverId, 'closed')
}

export function closeAllServers(): void {
  for (const serverId of [...states.keys()]) {
    closeServer(serverId)
  }
}

export function serverWarmup(project: McpProjectConfig | undefined): void {
  if (!project) {
    return
  }
  for (const serverId of project.enabledServerIds) {
    const server = listMcpServers().find((entry) => entry.id === serverId)
    if (!server?.enabled) {
      continue
    }
    if (stateFor(serverId).status.state === 'ready') {
      continue
    }
    void ensureServerReady(serverId).catch(() => undefined)
  }
}

export function toolsForProject(input: {
  project: McpProjectConfig | undefined
  mode: 'plan' | 'build'
  includeDenied?: boolean
}): McpToolInfo[] {
  const { project, mode, includeDenied } = input
  if (!project) {
    return []
  }
  const result: McpToolInfo[] = []
  for (const serverId of project.enabledServerIds) {
    const server = listMcpServers().find((entry) => entry.id === serverId)
    if (!server?.enabled) {
      continue
    }
    const state = stateFor(serverId)
    if (state.status.state !== 'ready') {
      continue
    }
    for (const tool of state.tools) {
      const info = toolInfo(server, tool, project)
      if (info.policy === 'deny' && !includeDenied) {
        continue
      }
      if (mode === 'plan' && !info.readOnly) {
        continue
      }
      result.push(info)
    }
  }
  return result
}

export function serverForTool(tool: McpToolInfo): McpServerConfig {
  const server = listMcpServers().find((entry) => entry.id === tool.serverId)
  if (!server) {
    throw new AppError('MCP_SERVER_NOT_FOUND', 'The MCP server for this tool is missing.')
  }
  return server
}

export async function callTool(input: {
  tool: McpToolInfo
  args: Record<string, unknown>
  agentId?: string
  sessionId?: string
  meetingId?: string
}): Promise<{
  text: string
  content: unknown
  structuredContent?: unknown
  isError: boolean
}> {
  const server = serverForTool(input.tool)
  const state = stateFor(server.id)
  if (!state.connection || state.status.state !== 'ready') {
    await ensureServerReady(server.id)
  }
  const connection = stateFor(server.id).connection
  if (!connection) {
    throw new AppError('MCP_NOT_READY', `${server.name} is not connected.`)
  }
  const startedAt = Date.now()
  try {
    const result = (await callMcpTool(connection, input.tool.name, input.args)) as {
      content?: Array<Record<string, unknown>>
      structuredContent?: unknown
      isError?: boolean
    }
    const text = (result.content ?? [])
      .map((part) => {
        if (part.type === 'text' && typeof part.text === 'string') {
          return part.text
        }
        if (part.type === 'resource' && typeof part.text === 'string') {
          return part.text
        }
        return JSON.stringify(part)
      })
      .join('\n')
    const normalized = {
      text: text || JSON.stringify(result.structuredContent ?? result),
      content: result.content ?? result,
      structuredContent: result.structuredContent,
      isError: result.isError === true
    }
    recordMcpCall({
      serverId: server.id,
      serverName: server.name,
      toolName: input.tool.name,
      agentId: input.agentId,
      sessionId: input.sessionId,
      meetingId: input.meetingId,
      status: normalized.isError ? 'tool-error' : 'ok',
      durationMs: Date.now() - startedAt,
      args: input.args,
      summary: normalized.text.slice(0, 2_000)
    })
    appendMcpLog(
      server.id,
      `tool ${input.tool.name} ${normalized.isError ? 'returned an error' : 'completed'} in ${
        Date.now() - startedAt
      }ms`
    )
    return normalized
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    recordMcpCall({
      serverId: server.id,
      serverName: server.name,
      toolName: input.tool.name,
      agentId: input.agentId,
      sessionId: input.sessionId,
      meetingId: input.meetingId,
      status: 'error',
      durationMs: Date.now() - startedAt,
      args: input.args,
      error: message
    })
    appendMcpLog(server.id, `tool ${input.tool.name} failed: ${message}`)
    throw new AppError('MCP_TOOL_FAILED', message)
  }
}

export function mcpToolName(serverId: string, toolName: string): string {
  return namespacedToolName(serverId, toolName)
}
