import http from 'node:http'
import type { AddressInfo } from 'node:net'

export const PHASE4_MOCK_KEY = 'agentdesk-phase4-mock-key'
export const PHASE4_FEATURE_PATH = 'src/feature.ts'
export const PHASE4_OUTSIDE_FILE = '../phase4-outside.txt'

export type Phase4MockServer = {
  baseUrl: string
  requests: Array<Record<string, unknown>>
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
    owned_by: 'agentdesk-phase4-mock'
  }
}

function sendChunk(
  response: http.ServerResponse,
  model: string,
  delta: Record<string, unknown>,
  finish: string | null = null
): void {
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-agentdesk-phase4',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }]
    })}\n\n`
  )
}

function sendUsage(
  response: http.ServerResponse,
  model: string,
  promptTokens: number,
  completionTokens: number
): void {
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-agentdesk-phase4',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      }
    })}\n\n`
  )
}

function streamToolCalls(
  response: http.ServerResponse,
  toolCalls: Array<Record<string, unknown>>
): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  sendChunk(response, 'phase4-chat', { role: 'assistant', content: '' })
  void (async () => {
    await delay(25)
    sendChunk(response, 'phase4-chat', { tool_calls: toolCalls })
    await delay(25)
    sendChunk(response, 'phase4-chat', {}, 'tool_calls')
    sendUsage(response, 'phase4-chat', 320, 45)
    response.write('data: [DONE]\n\n')
    response.end()
  })()
}

function streamFinalText(response: http.ServerResponse): void {
  const answer = [
    'Build run complete.',
    '',
    '- Created `src/feature.ts` with the Phase 4 smoke flag.',
    '- Patched the feature flag to the patched value.',
    '- Ran the approved command outside the repository boundary.',
    '- Decision: keep the Phase 4 feature flag enabled.',
    '- Next steps: add a regression test for the feature.',
    '',
    'All file changes were snapshotted and recorded in the project change log.'
  ].join('\n')
  const chunks = answer.match(/\S+\s*/g) ?? [answer]

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  sendChunk(response, 'phase4-chat', { role: 'assistant', content: '' })
  void (async () => {
    for (const part of chunks) {
      sendChunk(response, 'phase4-chat', { content: part })
      await delay(16)
    }
    sendChunk(response, 'phase4-chat', {}, 'stop')
    sendUsage(response, 'phase4-chat', 420, 70)
    response.write('data: [DONE]\n\n')
    response.end()
  })()
}

export function createPhase4MockServer(): Promise<Phase4MockServer> {
  return new Promise((resolve, reject) => {
    const requests: Array<Record<string, unknown>> = []
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            object: 'list',
            data: [modelEntry('phase4-chat')]
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
          const messages = Array.isArray(body.messages) ? body.messages : []
          const toolMessages = messages.filter(
            (message) =>
              typeof message === 'object' &&
              message !== null &&
              (message as { role?: string }).role === 'tool'
          ).length

          if (toolMessages === 0) {
            streamToolCalls(response, [
              {
                index: 0,
                id: 'call_phase4_write',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({
                    path: PHASE4_FEATURE_PATH,
                    content: 'export const phase4Feature = true\n'
                  })
                }
              },
              {
                index: 1,
                id: 'call_phase4_command',
                type: 'function',
                function: {
                  name: 'run_command',
                  arguments: JSON.stringify({
                    command: `node -e "console.log('phase4-command-output'); require('fs').writeFileSync('${PHASE4_OUTSIDE_FILE}','outside-approved')"`,
                    cwd: '.'
                  })
                }
              }
            ])
            return
          }

          if (toolMessages === 2) {
            streamToolCalls(response, [
              {
                index: 0,
                id: 'call_phase4_patch',
                type: 'function',
                function: {
                  name: 'patch_file',
                  arguments: JSON.stringify({
                    path: PHASE4_FEATURE_PATH,
                    oldText: 'phase4Feature = true',
                    newText: "phase4Feature = 'patched'"
                  })
                }
              }
            ])
            return
          }

          streamFinalText(response)
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
        close: () =>
          new Promise<void>((closeResolve) => {
            server.closeAllConnections()
            server.close(() => closeResolve())
          })
      })
    })
  })
}

