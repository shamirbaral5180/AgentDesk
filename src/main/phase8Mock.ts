import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export const PHASE8_SECRET_VALUE = 'phase8-top-secret'

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo text back to the caller.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  },
  {
    name: 'delete_thing',
    description: 'Destructive mock deletion in the external system.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    },
    annotations: { destructiveHint: true }
  },
  {
    name: 'env_probe',
    description: 'Report the configured environment token.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true }
  }
]

function callResult(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'echo') {
    return {
      content: [{ type: 'text', text: `echo:${String(args.text ?? '')}` }]
    }
  }
  if (name === 'delete_thing') {
    return {
      content: [{ type: 'text', text: `deleted:${String(args.name ?? '')}` }]
    }
  }
  if (name === 'env_probe') {
    return {
      content: [
        {
          type: 'text',
          text: `token:${process.env.MOCK_TOKEN ?? 'missing'}`
        }
      ]
    }
  }
  return {
    isError: true,
    content: [{ type: 'text', text: `unknown tool: ${name}` }]
  }
}

function rpcResult(method: string, params: Record<string, unknown>): unknown {
  if (method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'Phase 8 Mock', version: '1.0.0' }
    }
  }
  if (method === 'tools/list') {
    return { tools: TOOLS }
  }
  if (method === 'tools/call') {
    return callResult(
      String(params.name ?? ''),
      (params.arguments as Record<string, unknown>) ?? {}
    )
  }
  return {}
}

export function phase8StdioScript(): string {
  return `
const readline = require('node:readline');
const TOOLS = ${JSON.stringify(TOOLS)};
function result(method, params) {
  if (method === 'initialize') {
    return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'Phase 8 Mock', version: '1.0.0' } };
  }
  if (method === 'tools/list') {
    return { tools: TOOLS };
  }
  if (method === 'tools/call') {
    const name = String(params.name || '');
    const args = params.arguments || {};
    if (name === 'echo') {
      return { content: [{ type: 'text', text: 'echo:' + String(args.text || '') }] };
    }
    if (name === 'delete_thing') {
      return { content: [{ type: 'text', text: 'deleted:' + String(args.name || '') }] };
    }
    if (name === 'env_probe') {
      return { content: [{ type: 'text', text: 'token:' + String(process.env.MOCK_TOKEN || 'missing') }] };
    }
    return { isError: true, content: [{ type: 'text', text: 'unknown tool: ' + name }] };
  }
  return {};
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message.method !== 'string' || message.id === undefined) {
    return;
  }
  const payload = {
    jsonrpc: '2.0',
    id: message.id,
    result: result(message.method, message.params || {})
  };
  process.stdout.write(JSON.stringify(payload) + '\\n');
});
`
}

export function writePhase8StdioServer(root: string): string {
  const target = path.join(root, 'mcp-phase8-server.cjs')
  fs.writeFileSync(target, phase8StdioScript(), 'utf8')
  return target
}

export type Phase8HttpMockServer = {
  baseUrl: string
  url: string
  requests: Array<Record<string, unknown>>
  close: () => Promise<void>
}

export function createPhase8HttpMockServer(): Promise<Phase8HttpMockServer> {
  return new Promise((resolve, reject) => {
    const requests: Array<Record<string, unknown>> = []
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'POST' && url.pathname === '/mcp') {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          let body: Record<string, unknown> = {}
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          } catch {
            response.writeHead(400, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify({ error: { message: 'Invalid JSON' } }))
            return
          }
          requests.push(body)
          if (body.id === undefined) {
            response.writeHead(202)
            response.end()
            return
          }
          const result = rpcResult(
            String(body.method ?? ''),
            (body.params as Record<string, unknown>) ?? {}
          )
          const headers: Record<string, string> = { 'Content-Type': 'application/json' }
          if (body.method === 'initialize') {
            headers['Mcp-Session-Id'] = 'phase8-http-session'
          }
          response.writeHead(200, headers)
          response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
        })
        return
      }
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Not found' } }))
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      const baseUrl = `http://127.0.0.1:${address.port}`
      resolve({
        baseUrl,
        url: `${baseUrl}/mcp`,
        requests,
        close: () =>
          new Promise<void>((closeResolve) => {
            server.closeAllConnections()
            server.close(() => closeResolve())
          })
      })
    })
  })
}

export type Phase8SseMockServer = {
  baseUrl: string
  url: string
  close: () => Promise<void>
}

export function createPhase8SseMockServer(): Promise<Phase8SseMockServer> {
  return new Promise((resolve, reject) => {
    const streams = new Set<http.ServerResponse>()
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/sse') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })
        streams.add(response)
        response.write('event: endpoint\ndata: /messages\n\n')
        request.on('close', () => streams.delete(response))
        return
      }
      if (request.method === 'POST' && url.pathname === '/messages') {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          let body: Record<string, unknown> = {}
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          } catch {
            response.writeHead(400)
            response.end()
            return
          }
          response.writeHead(202)
          response.end()
          if (body.id === undefined) {
            return
          }
          const result = rpcResult(
            String(body.method ?? ''),
            (body.params as Record<string, unknown>) ?? {}
          )
          const payload = JSON.stringify({ jsonrpc: '2.0', id: body.id, result })
          for (const stream of streams) {
            stream.write(`event: message\ndata: ${payload}\n\n`)
          }
        })
        return
      }
      response.writeHead(404)
      response.end()
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      const baseUrl = `http://127.0.0.1:${address.port}`
      resolve({
        baseUrl,
        url: `${baseUrl}/sse`,
        close: () =>
          new Promise<void>((closeResolve) => {
            for (const stream of streams) {
              stream.end()
            }
            server.closeAllConnections()
            server.close(() => closeResolve())
          })
      })
    })
  })
}
