import http from 'node:http'
import type { AddressInfo } from 'node:net'

export const PHASE5_MOCK_KEY = 'agentdesk-phase5-mock-key'

export type Phase5MockServer = {
  baseUrl: string
  requests: Array<Record<string, unknown>>
  lastHadMemory: boolean
  lastHadFeature: boolean
  close: () => Promise<void>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function modelEntry(id: string): Record<string, unknown> {
  return {
    id,
    object: 'model',
    created: 1700000000,
    owned_by: 'agentdesk-phase5-mock'
  }
}

export function createPhase5MockServer(): Promise<Phase5MockServer> {
  return new Promise((resolve, reject) => {
    const requests: Array<Record<string, unknown>> = []
    const serverState = {
      lastHadMemory: false,
      lastHadFeature: false
    }

    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            object: 'list',
            data: [modelEntry('phase5-chat')]
          })
        )
        return
      }

      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
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
          const serialized = JSON.stringify(body)
          const hasMemory = serialized.includes('## Memory')
          const hasFeature =
            serialized.includes('src/feature.ts') ||
            serialized.includes('phase4Feature')
          serverState.lastHadMemory = hasMemory
          serverState.lastHadFeature = hasFeature
          const answer = hasFeature
            ? 'I remember the previous build. You created and patched `src/feature.ts`, ran the approved outside-repo command, and recorded the changes in the project change log.'
            : hasMemory
              ? 'I found stored project memory, but it does not mention the earlier feature.'
              : 'I do not have stored memory from that earlier session.'

          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          })
          const send = (payload: unknown): void => {
            response.write(`data: ${JSON.stringify(payload)}\n\n`)
          }
          const chunk = (delta: Record<string, unknown>, finish: string | null = null): void => {
            send({
              id: 'chatcmpl-agentdesk-phase5',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: 'phase5-chat',
              choices: [{ index: 0, delta, finish_reason: finish }]
            })
          }
          void (async () => {
            chunk({ role: 'assistant', content: '' })
            for (const part of answer.match(/\S+\s*/g) ?? [answer]) {
              chunk({ content: part })
              await delay(14)
            }
            chunk({}, 'stop')
            send({
              id: 'chatcmpl-agentdesk-phase5',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: 'phase5-chat',
              choices: [],
              usage: {
                prompt_tokens: 780,
                completion_tokens: 80,
                total_tokens: 860
              }
            })
            response.write('data: [DONE]\n\n')
            response.end()
          })()
        })
        return
      }

      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Not found' } }))
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        requests,
        get lastHadMemory() {
          return serverState.lastHadMemory
        },
        get lastHadFeature() {
          return serverState.lastHadFeature
        },
        close: () =>
          new Promise<void>((closeResolve) => {
            server.closeAllConnections()
            server.close(() => closeResolve())
          })
      })
    })
  })
}
