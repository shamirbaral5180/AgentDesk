import type {
  McpCallAudit,
  McpProjectConfig,
  McpServerDraft,
  McpServerPatch,
  McpServerView,
  TeamMutationResult
} from '@shared/types'
import { AppError } from '../errors'
import {
  getCurrentProject,
  getCurrentTeamConfig,
  updateCurrentTeam
} from '../project/projectService'
import {
  addMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpCalls,
  listMcpServers,
  readMcpLog,
  updateMcpServer
} from './mcpStore'
import {
  closeServer,
  discoverTools,
  ensureServerReady,
  listServerViews,
  restartServer,
  serverView,
  serverWarmup
} from './mcpManager'

function currentProjectMcp(): McpProjectConfig | undefined {
  return getCurrentTeamConfig()?.mcp
}

export function listServers(): McpServerView[] {
  return listServerViews(currentProjectMcp())
}

export async function addServer(draft: McpServerDraft): Promise<McpServerView> {
  const server = addMcpServer(draft)
  try {
    return await ensureServerReady(server.id)
  } catch {
    return serverView(server.id, currentProjectMcp())
  }
}

export async function updateServer(patch: McpServerPatch): Promise<McpServerView> {
  closeServer(patch.id)
  const server = updateMcpServer(patch)
  try {
    return await ensureServerReady(server.id)
  } catch {
    return serverView(server.id, currentProjectMcp())
  }
}

export function removeServer(id: string): { servers: McpServerView[] } {
  getMcpServer(id)
  closeServer(id)
  deleteMcpServer(id)
  const team = getCurrentTeamConfig()
  if (team && team.mcp.enabledServerIds.includes(id)) {
    updateCurrentTeam((current) => ({
      ...current,
      mcp: {
        enabledServerIds: current.mcp.enabledServerIds.filter((entry) => entry !== id),
        toolPolicies: Object.fromEntries(
          Object.entries(current.mcp.toolPolicies).filter(
            ([key]) => !key.startsWith(`mcp__${id.slice(0, 24)}`)
          )
        )
      }
    }))
  }
  return { servers: listServers() }
}

export async function testServer(id: string): Promise<McpServerView> {
  const view = await ensureServerReady(id)
  return { ...view, tools: serverView(id, currentProjectMcp()).tools }
}

export async function discoverServerTools(id: string): Promise<McpServerView> {
  const view = await discoverTools(id)
  return { ...view, tools: serverView(id, currentProjectMcp()).tools }
}

export async function restartMcpServer(id: string): Promise<McpServerView> {
  const view = await restartServer(id)
  return { ...view, tools: serverView(id, currentProjectMcp()).tools }
}

export function getServerLogs(id: string): string {
  getMcpServer(id)
  return readMcpLog(id)
}

export function setProjectConfig(config: McpProjectConfig): TeamMutationResult {
  if (!getCurrentTeamConfig()) {
    throw new AppError('NO_PROJECT', 'Open a project before enabling MCP servers.')
  }
  const known = new Set(listMcpServers().map((server) => server.id))
  const enabledServerIds = [...new Set(config.enabledServerIds)].filter((id) => known.has(id))
  const next = updateCurrentTeam((team) => ({
    ...team,
    mcp: {
      enabledServerIds,
      toolPolicies: { ...config.toolPolicies }
    }
  }))
  serverWarmup(next.mcp)
  const project = getCurrentProject()
  if (!project) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }
  return { team: next, project }
}

export function callAudit(serverId?: string): McpCallAudit[] {
  return listMcpCalls(serverId)
}

export function warmProjectMcp(): void {
  serverWarmup(currentProjectMcp())
}
