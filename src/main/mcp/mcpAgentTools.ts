import { jsonSchema, tool, type ToolSet } from 'ai'
import type { AgentConfig, McpToolInfo, TeamConfig } from '@shared/types'
import type { AgentToolBundle, AgentToolRuntime } from '../chat/projectTools'
import { callTool, toolsForProject } from './mcpManager'

export function buildMcpToolBundle(input: {
  team: TeamConfig
  agent: AgentConfig
  runtime: AgentToolRuntime
  mode: 'plan' | 'build'
}): AgentToolBundle {
  const { team, agent, runtime, mode } = input
  const warnings: string[] = []
  if (!agent.permissions.tools.includes('mcp')) {
    return { tools: {}, definitions: [], names: [], warnings }
  }
  const infos = toolsForProject({
    project: team.mcp,
    mode
  })
  if (infos.length === 0 && team.mcp.enabledServerIds.length > 0) {
    warnings.push(
      'MCP servers are enabled for this project, but no tools are connected. Test or discover them in Settings, MCP.'
    )
  }
  const tools: ToolSet = {}
  for (const info of infos) {
    if (info.policy === 'deny') {
      continue
    }
    tools[info.namespacedName] = tool({
      description: `[MCP ${info.serverName}] ${info.description}`,
      inputSchema: jsonSchema(
        (info.inputSchema as Record<string, unknown>) ?? {
          type: 'object',
          properties: {}
        }
      ),
      execute: async (args: Record<string, unknown>) => {
        if (info.policy === 'ask') {
          const approval = await runtime.requestApproval({
            actionType: 'mcp_call',
            actionKey: `mcp_call:${info.namespacedName}`,
            risk: info.destructive ? 'high' : 'medium',
            reason: `Call ${info.serverName} / ${info.name}`,
            payload: {
              operation: 'mcp_call',
              serverId: info.serverId,
              serverName: info.serverName,
              toolName: info.name,
              tool: info.namespacedName,
              arguments: args
            }
          })
          if (approval.decision !== 'approved') {
            throw new Error('The Boss denied this MCP tool call.')
          }
        }
        const result = await callTool({
          tool: info,
          args,
          agentId: agent.id,
          sessionId: runtime.sessionId,
          meetingId: runtime.meetingId
        })
        return {
          server: info.serverName,
          tool: info.name,
          text: result.text,
          structuredContent: result.structuredContent,
          isError: result.isError
        }
      }
    })
  }
  const definitions = infos
    .filter((info) => info.policy !== 'deny')
    .map((info: McpToolInfo) => ({
      name: info.namespacedName,
      description: `[MCP ${info.serverName}] ${info.description}`
    }))
  return {
    tools,
    definitions,
    names: Object.keys(tools),
    warnings
  }
}

export function mergeToolBundles(
  base: AgentToolBundle,
  extra: AgentToolBundle
): AgentToolBundle {
  return {
    tools: { ...base.tools, ...extra.tools },
    definitions: [...base.definitions, ...extra.definitions],
    names: [...new Set([...base.names, ...extra.names])],
    warnings: [...new Set([...base.warnings, ...extra.warnings])]
  }
}
