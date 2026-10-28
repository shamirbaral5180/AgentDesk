import fs from 'node:fs'
import path from 'node:path'
import type { AgentConfig, McpProjectConfig } from '@shared/types'
import { getAppPaths } from './config/appPaths'
import { removeRecentProject } from './config/settings'
import { closeProject, openProject } from './project/projectService'
import { getTeam } from './project/teamService'
import {
  addServer,
  callAudit,
  discoverServerTools,
  getServerLogs,
  removeServer,
  restartMcpServer,
  setProjectConfig
} from './mcp/mcpService'
import { buildMcpToolBundle } from './mcp/mcpAgentTools'
import type { AgentToolRuntime } from './chat/projectTools'
import { closeAllServers } from './mcp/mcpManager'
import { isNewerVersion } from './updates/updateService'
import {
  createPhase8HttpMockServer,
  createPhase8SseMockServer,
  PHASE8_SECRET_VALUE,
  writePhase8StdioServer
} from './phase8Mock'

function writeProject(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'phase8-mcp-project', version: '1.0.0', private: true }, null, 2),
    'utf8'
  )
  fs.writeFileSync(
    path.join(root, 'src', 'App.tsx'),
    'export function App() { return null }\n',
    'utf8'
  )
}

function fakeRuntime(agent: AgentConfig): {
  runtime: AgentToolRuntime
  approvals: Array<Record<string, unknown>>
} {
  const approvals: Array<Record<string, unknown>> = []
  return {
    approvals,
    runtime: {
      mode: 'build',
      sessionId: 'phase8-session',
      runId: 'phase8-run',
      agentId: agent.id,
      requestApproval: async (input) => {
        approvals.push(input as unknown as Record<string, unknown>)
        return { decision: 'approved' as const, scope: 'once' as const }
      },
      emitOutput: () => undefined
    }
  }
}

type ExecutableTool = {
  execute?: (
    input: Record<string, unknown>,
    options: {
      toolCallId: string
      messages: unknown[]
      abortSignal: AbortSignal
    }
  ) => Promise<unknown>
}

async function executeTool(
  tool: ExecutableTool,
  input: Record<string, unknown>,
  toolCallId: string
): Promise<{ text?: string }> {
  if (!tool.execute) {
    throw new Error(`MCP tool ${toolCallId} has no execute function`)
  }
  return (await tool.execute(input, {
    toolCallId,
    messages: [],
    abortSignal: new AbortController().signal
  })) as { text?: string }
}

function projectConfigWith(
  serverIds: string[],
  policies: Record<string, 'allow' | 'ask' | 'deny'>
): McpProjectConfig {
  return {
    enabledServerIds: serverIds,
    toolPolicies: policies
  }
}

export async function runPhase8Smoke(): Promise<number> {
  const paths = getAppPaths()
  const projectRoot = path.join(paths.tmpDir, `phase8-smoke-${Date.now()}`)
  const serverIds: string[] = []
  let httpMock: Awaited<ReturnType<typeof createPhase8HttpMockServer>> | null = null
  let sseMock: Awaited<ReturnType<typeof createPhase8SseMockServer>> | null = null

  try {
    writeProject(projectRoot)
    openProject(projectRoot)
    const scriptPath = writePhase8StdioServer(projectRoot)

    const stdio = await addServer({
      name: 'Phase 8 Stdio',
      transport: 'stdio',
      command: 'node',
      args: [scriptPath],
      env: { MOCK_TOKEN: PHASE8_SECRET_VALUE }
    })
    serverIds.push(stdio.server.id)
    if (stdio.status.state !== 'ready') {
      throw new Error(`stdio MCP failed: ${stdio.status.lastError ?? 'unknown error'}`)
    }
    if (!stdio.tools.some((tool) => tool.name === 'echo')) {
      throw new Error('stdio MCP did not discover the echo tool')
    }
    if (!stdio.tools.every((tool) => tool.namespacedName.startsWith('mcp__'))) {
      throw new Error('MCP tools were not namespaced')
    }

    const catalogText = fs.readFileSync(paths.mcpServersPath, 'utf8')
    if (catalogText.includes(PHASE8_SECRET_VALUE)) {
      throw new Error('MCP catalog leaked a secret value')
    }

    const discovered = await discoverServerTools(stdio.server.id)
    if (discovered.tools.length !== 3) {
      throw new Error(`Expected three MCP tools, got ${discovered.tools.length}`)
    }
    const restarted = await restartMcpServer(stdio.server.id)
    if (restarted.status.state !== 'ready') {
      throw new Error('MCP restart did not return ready')
    }
    const logs = getServerLogs(stdio.server.id)
    if (!logs.includes('initialized')) {
      throw new Error('MCP logs did not record initialization')
    }

    const echo = discovered.tools.find((tool) => tool.name === 'echo')
    const remove = discovered.tools.find((tool) => tool.name === 'delete_thing')
    const envProbe = discovered.tools.find((tool) => tool.name === 'env_probe')
    if (!echo || !remove || !envProbe) {
      throw new Error('MCP mock tools were not discovered')
    }

    const configured = setProjectConfig(
      projectConfigWith([stdio.server.id], {
        [echo.namespacedName]: 'allow',
        [remove.namespacedName]: 'ask',
        [envProbe.namespacedName]: 'ask'
      })
    )
    if (!configured.team.mcp.enabledServerIds.includes(stdio.server.id)) {
      throw new Error('Project MCP enablement did not persist')
    }
    const teamText = fs.readFileSync(configured.project.teamPath, 'utf8')
    if (teamText.includes(PHASE8_SECRET_VALUE)) {
      throw new Error('Project team.json leaked an MCP secret')
    }

    const team = getTeam()
    if (!team) {
      throw new Error('Team configuration is missing')
    }
    const agent = team.agents.find((entry) => entry.permissions.tools.includes('mcp'))
    if (!agent) {
      throw new Error('No agent has the mcp tool permission')
    }
    const { runtime, approvals } = fakeRuntime(agent)
    const bundle = buildMcpToolBundle({
      team: configured.team,
      agent,
      runtime,
      mode: 'build'
    })
    const echoTool = bundle.tools[echo.namespacedName] as unknown as ExecutableTool
    if (!echoTool?.execute) {
      throw new Error('MCP echo tool was not exposed to the agent')
    }
    const echoResult = await executeTool(echoTool, { text: 'hello' }, 'phase8-echo')
    if (!String(echoResult.text ?? '').includes('echo:hello')) {
      throw new Error('MCP echo tool call did not return the expected text')
    }
    if (approvals.length !== 0) {
      throw new Error('Allow policy unexpectedly requested approval')
    }

    const removeTool = bundle.tools[remove.namespacedName] as unknown as ExecutableTool
    const removeResult = await executeTool(removeTool, { name: 'phase8' }, 'phase8-delete')
    if (!String(removeResult.text ?? '').includes('deleted:phase8')) {
      throw new Error('Destructive MCP tool did not execute after approval')
    }
    const approval = approvals[0]
    if (!approval) {
      throw new Error('Destructive MCP tool did not require approval')
    }
    const payload = approval.payload as Record<string, unknown>
    if (payload.serverId !== stdio.server.id || payload.toolName !== 'delete_thing') {
      throw new Error('MCP approval payload did not identify the server and tool')
    }

    const envTool = bundle.tools[envProbe.namespacedName] as unknown as ExecutableTool
    const envResult = await executeTool(envTool, {}, 'phase8-env')
    if (!String(envResult.text ?? '').includes(PHASE8_SECRET_VALUE)) {
      throw new Error('MCP stdio secret was not injected into the server environment')
    }

    const deniedTeam = setProjectConfig(
      projectConfigWith([stdio.server.id], {
        [echo.namespacedName]: 'allow',
        [remove.namespacedName]: 'deny',
        [envProbe.namespacedName]: 'allow'
      })
    ).team
    const deniedBundle = buildMcpToolBundle({
      team: deniedTeam,
      agent,
      runtime,
      mode: 'build'
    })
    if (deniedBundle.tools[remove.namespacedName]) {
      throw new Error('Deny policy did not remove the MCP tool')
    }

    httpMock = await createPhase8HttpMockServer()
    const http = await addServer({
      name: 'Phase 8 HTTP',
      transport: 'http',
      url: httpMock.url
    })
    serverIds.push(http.server.id)
    if (http.status.state !== 'ready' || http.tools.length !== 3) {
      throw new Error(`HTTP MCP failed: ${http.status.lastError ?? 'unknown error'}`)
    }
    const httpEcho = http.tools.find((tool) => tool.name === 'echo')
    if (!httpEcho) {
      throw new Error('HTTP MCP echo tool missing')
    }
    const httpTeam = setProjectConfig(
      projectConfigWith([stdio.server.id, http.server.id], {
        [echo.namespacedName]: 'allow',
        [remove.namespacedName]: 'deny',
        [envProbe.namespacedName]: 'allow',
        [httpEcho.namespacedName]: 'allow'
      })
    ).team
    const httpBundle = buildMcpToolBundle({
      team: httpTeam,
      agent,
      runtime,
      mode: 'build'
    })
    const httpTool = httpBundle.tools[httpEcho.namespacedName] as unknown as ExecutableTool
    const httpResult = await executeTool(httpTool, { text: 'over-http' }, 'phase8-http')
    if (!String(httpResult.text ?? '').includes('echo:over-http')) {
      throw new Error('HTTP MCP tool call failed')
    }

    sseMock = await createPhase8SseMockServer()
    const sse = await addServer({
      name: 'Phase 8 SSE',
      transport: 'sse',
      url: sseMock.url
    })
    serverIds.push(sse.server.id)
    if (sse.status.state !== 'ready' || sse.tools.length !== 3) {
      throw new Error(`SSE MCP failed: ${sse.status.lastError ?? 'unknown error'}`)
    }

    const bad = await addServer({
      name: 'Phase 8 Broken',
      transport: 'stdio',
      command: 'definitely-not-a-real-mcp-command-xyz',
      args: []
    })
    serverIds.push(bad.server.id)
    if (bad.status.state !== 'error' || !bad.status.lastError) {
      throw new Error('Broken MCP server did not expose an error state')
    }
    removeServer(bad.server.id)
    serverIds.splice(serverIds.indexOf(bad.server.id), 1)

    const audits = callAudit(stdio.server.id)
    if (audits.length < 3) {
      throw new Error('MCP calls were not audited')
    }
    if (!isNewerVersion('0.9.0', '0.8.0') || isNewerVersion('0.8.0', '0.8.0')) {
      throw new Error('GitHub update version comparison failed')
    }

    console.log(
      `PHASE8_SMOKE_RESULT ${JSON.stringify({
        ok: true,
        stdioServerId: stdio.server.id,
        httpServerId: http.server.id,
        sseServerId: sse.server.id,
        tools: discovered.tools.map((tool) => tool.namespacedName),
        stdioReady: stdio.status.state,
        httpReady: http.status.state,
        sseReady: sse.status.state,
        restartReady: restarted.status.state,
        logsRecorded: logs.length > 0,
        approvals: approvals.length,
        approvalPayload: {
          serverId: payload.serverId,
          toolName: payload.toolName
        },
        secretInCatalog: false,
        secretInTeam: false,
        envSecretRoundTrip: String(envResult.text ?? '').includes(PHASE8_SECRET_VALUE),
        denyPolicyRemovedTool: !deniedBundle.tools[remove.namespacedName],
        httpToolCall: String(httpResult.text ?? ''),
        audits: audits.length,
        brokenServerState: bad.status.state
      })}`
    )
    return 0
  } catch (error) {
    console.error('PHASE8_SMOKE_FAILED', error)
    return 1
  } finally {
    closeAllServers()
    for (const serverId of serverIds) {
      try {
        removeServer(serverId)
      } catch {
        console.error('PHASE8_SMOKE_CLEANUP_SERVER_FAILED', serverId)
      }
    }
    closeProject()
    removeRecentProject(projectRoot)
    if (httpMock) {
      await httpMock.close()
    }
    if (sseMock) {
      await sseMock.close()
    }
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (cleanupError) {
      console.error('PHASE8_SMOKE_CLEANUP_FAILED', cleanupError)
    }
  }
}
