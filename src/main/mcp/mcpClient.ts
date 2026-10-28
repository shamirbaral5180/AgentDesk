import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { McpServerConfig } from '@shared/types'
import { getAppPaths } from '../config/appPaths'
import { appendMcpLog, mcpServerSecrets } from './mcpStore'

export type McpToolDescriptor = {
  name: string
  description: string
  inputSchema: unknown
  annotations: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

export type McpConnection = {
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
  notify: (method: string, params?: unknown) => Promise<void>
  close: () => void
  pid?: number
}

const DEFAULT_PROTOCOL_VERSION = '2024-11-05'
const CLIENT_INFO = { name: 'AgentDesk', version: '0.8.0' }

type JsonRpcResponse = {
  jsonrpc?: string
  id?: number | string | null
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return typeof value === 'object' && value !== null && 'id' in value
}

function responseError(response: JsonRpcResponse): Error {
  const message = response.error?.message ?? 'MCP request failed.'
  return new Error(message)
}

function timeoutError(method: string): Error {
  return new Error(`MCP request timed out: ${method}`)
}

function killTree(child: ChildProcess): void {
  if (!child.pid) {
    return
  }
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.on('error', () => {
        try {
          child.kill()
        } catch {
          // already gone
        }
      })
    } catch {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // already gone
  }
}

function stdioCommand(server: McpServerConfig): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const secrets = mcpServerSecrets(server)
  const paths = getAppPaths()
  const rawCommand = server.command.trim()
  const useBundledNode = /^node(\.exe)?$/i.test(rawCommand)
  const npmMatch = /^(npm|npx)(\.cmd|\.exe)?$/i.exec(rawCommand)
  const bundledNpmCli = npmMatch
    ? path.join(
        paths.runtimeDir,
        'npm',
        'bin',
        npmMatch[1].toLowerCase() === 'npx' ? 'npx-cli.js' : 'npm-cli.js'
      )
    : null
  const useBundledNpm = Boolean(bundledNpmCli && fs.existsSync(bundledNpmCli))
  const command =
    useBundledNode || useBundledNpm ? process.execPath : rawCommand
  const args =
    useBundledNpm && bundledNpmCli ? [bundledNpmCli, ...server.args] : server.args
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(useBundledNode || useBundledNpm ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(useBundledNpm
      ? {
          npm_node_execpath: process.execPath,
          npm_execpath: bundledNpmCli ?? '',
          npm_config_cache: path.join(paths.mcpPackagesDir, 'npm-cache'),
          npm_config_prefix: path.join(paths.mcpPackagesDir, 'npm-prefix')
        }
      : {}),
    ...secrets.env,
    MCP_TRANSPORT: 'stdio',
    npm_config_cache: path.join(paths.mcpPackagesDir, 'npm-cache'),
    npm_config_prefix: path.join(paths.mcpPackagesDir, 'npm-prefix')
  }
  return { command, args, env }
}

class StdioMcpConnection implements McpConnection {
  private child: ChildProcess
  private buffer = ''
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private closed = false
  readonly pid?: number

  constructor(private server: McpServerConfig) {
    const { command, args, env } = stdioCommand(server)
    const cwd = server.cwd || getAppPaths().appRoot
    appendMcpLog(server.id, `start ${command} ${args.join(' ')} (cwd ${cwd})`)
    this.child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.pid = this.child.pid
    this.child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
    this.child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      appendMcpLog(server.id, `stderr: ${text}`)
    })
    this.child.on('error', (error) => {
      appendMcpLog(server.id, `process error: ${error.message}`)
      this.rejectAll(error)
    })
    this.child.on('exit', (code, signal) => {
      appendMcpLog(server.id, `exit=${code ?? 'null'} signal=${signal ?? 'none'}`)
      this.closed = true
      this.rejectAll(new Error(`MCP process exited (${code ?? 'null'}).`))
    })
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) {
        break
      }
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) {
        continue
      }
      try {
        this.onMessage(JSON.parse(line) as unknown)
      } catch (error) {
        appendMcpLog(this.server.id, `invalid JSON: ${line.slice(0, 500)}`)
      }
    }
  }

  private onMessage(message: unknown): void {
    if (!isJsonRpcResponse(message)) {
      return
    }
    if (typeof message.id !== 'number') {
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) {
      return
    }
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) {
      pending.reject(responseError(message))
    } else {
      pending.resolve(message.result)
    }
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed || !this.child.stdin?.writable) {
      return Promise.reject(new Error('MCP process is not running.'))
    }
    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method, params: params ?? {} }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(timeoutError(method))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin!.write(`${JSON.stringify(payload)}\n`, 'utf8', (error) => {
        if (error) {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(error)
        }
      })
    })
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed || !this.child.stdin?.writable) {
      return
    }
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} })}\n`,
      'utf8'
    )
  }

  close(): void {
    this.closed = true
    this.rejectAll(new Error('MCP connection closed.'))
    killTree(this.child)
    appendMcpLog(this.server.id, 'stopped')
  }
}

async function parseJsonRpcResponse(response: Response): Promise<JsonRpcResponse> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    const text = await response.text()
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n')
      if (!data) {
        continue
      }
      const parsed = JSON.parse(data) as unknown
      if (isJsonRpcResponse(parsed)) {
        return parsed
      }
    }
    throw new Error('MCP SSE response did not contain a JSON-RPC response.')
  }
  return (await response.json()) as JsonRpcResponse
}

class HttpMcpConnection implements McpConnection {
  private nextId = 1
  private sessionId: string | null = null
  private headers: Record<string, string>
  private protocolVersion = DEFAULT_PROTOCOL_VERSION

  constructor(private server: McpServerConfig) {
    this.headers = mcpServerSecrets(server).headers
  }

  async request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++
    const response = await fetch(this.server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': this.protocolVersion,
        ...this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {},
        ...this.headers
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const session = response.headers.get('mcp-session-id')
    if (session) {
      this.sessionId = session
    }
    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`)
    }
    const parsed = await parseJsonRpcResponse(response)
    if (parsed.error) {
      throw responseError(parsed)
    }
    return parsed.result
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const response = await fetch(this.server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': this.protocolVersion,
        ...this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {},
        ...this.headers
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} })
    })
    const session = response.headers.get('mcp-session-id')
    if (session) {
      this.sessionId = session
    }
  }

  close(): void {
    appendMcpLog(this.server.id, 'HTTP connection closed')
  }
}

class SseMcpConnection implements McpConnection {
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private endpoint: string | null = null
  private endpointWaiters: Array<(endpoint: string) => void> = []
  private controller = new AbortController()
  private closed = false
  private headers: Record<string, string>

  constructor(private server: McpServerConfig) {
    this.headers = mcpServerSecrets(server).headers
    void this.connect()
  }

  private async connect(): Promise<void> {
    try {
      const response = await fetch(this.server.url, {
        headers: {
          accept: 'text/event-stream',
          'MCP-Protocol-Version': DEFAULT_PROTOCOL_VERSION,
          ...this.headers
        },
        signal: this.controller.signal
      })
      if (!response.ok || !response.body) {
        throw new Error(`MCP SSE ${response.status}`)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (!this.closed) {
        const read = await reader.read()
        if (read.done) {
          break
        }
        buffer += decoder.decode(read.value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          this.onBlock(block)
          boundary = buffer.indexOf('\n\n')
        }
      }
    } catch (error) {
      if (!this.closed) {
        appendMcpLog(
          this.server.id,
          `SSE error: ${error instanceof Error ? error.message : String(error)}`
        )
        this.rejectAll(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private onBlock(block: string): void {
    let event = 'message'
    const dataLines: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim())
      }
    }
    const data = dataLines.join('\n')
    if (!data) {
      return
    }
    if (event === 'endpoint') {
      this.endpoint = new URL(data, this.server.url).toString()
      for (const waiter of this.endpointWaiters) {
        waiter(this.endpoint)
      }
      this.endpointWaiters = []
      return
    }
    try {
      const parsed = JSON.parse(data) as unknown
      if (!isJsonRpcResponse(parsed) || typeof parsed.id !== 'number') {
        return
      }
      const pending = this.pending.get(parsed.id)
      if (!pending) {
        return
      }
      this.pending.delete(parsed.id)
      clearTimeout(pending.timer)
      if (parsed.error) {
        pending.reject(responseError(parsed))
      } else {
        pending.resolve(parsed.result)
      }
    } catch {
      // Ignore non-JSON SSE event data.
    }
  }

  private waitForEndpoint(timeoutMs: number): Promise<string> {
    if (this.endpoint) {
      return Promise.resolve(this.endpoint)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP SSE endpoint timed out.')), timeoutMs)
      this.endpointWaiters.push((endpoint) => {
        clearTimeout(timer)
        resolve(endpoint)
      })
    })
  }

  async request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const endpoint = await this.waitForEndpoint(timeoutMs)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(timeoutError(method))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      void fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })
      }).catch((error: unknown) => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const endpoint = await this.waitForEndpoint(30_000)
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} })
    })
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  close(): void {
    this.closed = true
    this.rejectAll(new Error('MCP SSE connection closed.'))
    this.controller.abort()
    appendMcpLog(this.server.id, 'SSE connection closed')
  }
}

export function openMcpConnection(server: McpServerConfig): McpConnection {
  if (server.transport === 'stdio') {
    return new StdioMcpConnection(server)
  }
  if (server.transport === 'http') {
    return new HttpMcpConnection(server)
  }
  return new SseMcpConnection(server)
}

export async function initializeMcp(
  connection: McpConnection,
  server: McpServerConfig
): Promise<void> {
  await connection.request('initialize', {
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO
  })
  await connection.notify('notifications/initialized', {})
  appendMcpLog(server.id, 'initialized')
}

export async function listMcpTools(connection: McpConnection): Promise<McpToolDescriptor[]> {
  const tools: McpToolDescriptor[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page += 1) {
    const result = (await connection.request('tools/list', cursor ? { cursor } : {})) as {
      tools?: Array<Record<string, unknown>>
      nextCursor?: string
    }
    for (const entry of result.tools ?? []) {
      const name = typeof entry.name === 'string' ? entry.name : ''
      if (!name) {
        continue
      }
      const annotations =
        typeof entry.annotations === 'object' && entry.annotations !== null
          ? (entry.annotations as Record<string, unknown>)
          : {}
      tools.push({
        name,
        description:
          typeof entry.description === 'string' ? entry.description : 'MCP tool',
        inputSchema:
          typeof entry.inputSchema === 'object' && entry.inputSchema !== null
            ? entry.inputSchema
            : { type: 'object', properties: {} },
        annotations: {
          readOnlyHint: annotations.readOnlyHint === true,
          destructiveHint: annotations.destructiveHint === true,
          idempotentHint: annotations.idempotentHint === true,
          openWorldHint: annotations.openWorldHint === true
        }
      })
    }
    if (typeof result.nextCursor !== 'string' || !result.nextCursor) {
      break
    }
    cursor = result.nextCursor
  }
  return tools
}

export async function callMcpTool(
  connection: McpConnection,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return connection.request('tools/call', { name: toolName, arguments: args }, 60_000)
}
