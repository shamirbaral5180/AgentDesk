import http from 'node:http'
import type { AddressInfo } from 'node:net'

export const MOCK_CHAT_KEY = 'agentdesk-phase3-mock-key'

export type MockChatServer = {
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
    owned_by: 'agentdesk-phase3-mock'
  }
}

function toolMessageTexts(messages: unknown): string[] {
  if (!Array.isArray(messages)) {
    return []
  }
  return messages
    .filter(
      (message): message is { role: string; content: unknown } =>
        typeof message === 'object' &&
        message !== null &&
        (message as { role?: string }).role === 'tool'
    )
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content)
    )
}

function packageName(toolTexts: string[]): string | null {
  for (const text of toolTexts) {
    let content = text
    try {
      const parsed = JSON.parse(text) as { content?: unknown; name?: unknown }
      if (typeof parsed.content === 'string') {
        content = parsed.content
      } else if (typeof parsed.name === 'string') {
        return parsed.name
      }
    } catch {
      // Fall back to the raw text below.
    }
    const match = /"name"\s*:\s*"([^"]+)"/.exec(content)
    if (match?.[1]) {
      return match[1]
    }
  }
  return null
}

function containsImage(messages: unknown): boolean {
  const serialized = JSON.stringify(messages)
  return serialized.includes('image_url') || serialized.includes('data:image/')
}

function finalAnswer(input: {
  prompt: string
  hasImage: boolean
  toolTexts: string[]
}): string {
  const name = packageName(input.toolTexts) ?? 'this project'
  const imageLine = input.hasImage
    ? '\n\nI also received the attached image and can use it as visual context.'
    : ''

  if (/architecture|tour|structure/i.test(input.prompt)) {
    return [
      'I inspected the repository with `list_files` and read `package.json`.',
      '',
      '### What this project is',
      `**${name}** is a local-first Electron desktop app with a React renderer and Vite build tooling.`,
      'The source tree is small and intentional: the renderer entry point lives under `src/`,',
      'and the project already has scripts for dev, build, test, and lint.',
      '',
      '### How the pieces fit',
      '- **Desktop shell:** Electron owns the window and local runtime.',
      '- **Renderer:** React renders the studio UI under `src/`.',
      '- **Tooling:** TypeScript, Vite, and Vitest are configured in `package.json`.',
      '',
      '### Good next moves',
      '1. Add a shared UI shell so new panels can be composed without duplicating layout.',
      '2. Keep project-level state outside components so it survives view changes.',
      '3. Add a small integration test around the first real workflow before expanding the surface.',
      '',
      'Plan mode is read-only, so I have not changed any files.' + imageLine
    ].join('\n')
  }

  if (/phase 3|smoke|package/i.test(input.prompt)) {
    return [
      `I read \`package.json\` and listed the repository. The project is **${name}**.`,
      '',
      'The package metadata is present, the renderer source is under `src/`, and the read-only',
      'tools returned the expected file list. I have not modified the project.' + imageLine
    ].join('\n')
  }

  return [
    `I inspected the project and found **${name}**.`,
    '',
    'The repository is available to the read-only tools, and the conversation is persisted in',
    'the project database. Ask me about a file, a module, or the next step you are considering.' +
      imageLine
  ].join('\n')
}

function streamTextResponse(
  response: http.ServerResponse,
  body: Record<string, unknown>
): void {
  const messages = body.messages
  const prompt = JSON.stringify(messages)
  const hasImage = containsImage(messages)
  const toolTexts = toolMessageTexts(messages)
  const answer = finalAnswer({ prompt, hasImage, toolTexts })
  const chunks = answer.match(/\S+\s*/g) ?? [answer]

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
      id: 'chatcmpl-agentdesk-phase3',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-chat',
      choices: [{ index: 0, delta, finish_reason: finish }]
    })
  }

  void (async () => {
    chunk({ role: 'assistant', content: '' })
    for (const part of chunks) {
      chunk({ content: part })
      await delay(18)
    }
    chunk({}, 'stop')
    send({
      id: 'chatcmpl-agentdesk-phase3',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-chat',
      choices: [],
      usage: {
        prompt_tokens: 360,
        completion_tokens: Math.max(24, Math.round(answer.length / 4)),
        total_tokens: 360 + Math.max(24, Math.round(answer.length / 4))
      }
    })
    response.write('data: [DONE]\n\n')
    response.end()
  })().catch(() => {
    response.end()
  })
}

function streamToolCallResponse(
  response: http.ServerResponse,
  body: Record<string, unknown>
): void {
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
      id: 'chatcmpl-agentdesk-phase3-tools',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-chat',
      choices: [{ index: 0, delta, finish_reason: finish }]
    })
  }

  void (async () => {
    chunk({ role: 'assistant', content: '' })
    await delay(20)
    const tools = Array.isArray(body.tools) ? body.tools : []
    const names = tools
      .map((entry) =>
        typeof entry === 'object' && entry !== null
          ? (entry as { function?: { name?: string } }).function?.name
          : undefined
      )
      .filter((name): name is string => Boolean(name))

    if (names.includes('read_file')) {
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_read_package',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'package.json' })
            }
          }
        ]
      })
      await delay(20)
    }
    if (names.includes('list_files')) {
      chunk({
        tool_calls: [
          {
            index: 1,
            id: 'call_list_root',
            type: 'function',
            function: {
              name: 'list_files',
              arguments: JSON.stringify({ path: '.', depth: 1 })
            }
          }
        ]
      })
      await delay(20)
    }
    chunk({}, 'tool_calls')
    send({
      id: 'chatcmpl-agentdesk-phase3-tools',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-chat',
      choices: [],
      usage: {
        prompt_tokens: 240,
        completion_tokens: 28,
        total_tokens: 268
      }
    })
    response.write('data: [DONE]\n\n')
    response.end()
  })().catch(() => {
    response.end()
  })
}

export function createMockChatServer(): Promise<MockChatServer> {
  return new Promise((resolve, reject) => {
    const requests: Array<Record<string, unknown>> = []
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            object: 'list',
            data: [modelEntry('mock-chat'), modelEntry('mock-vision')]
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
          const tools = Array.isArray(body.tools) ? body.tools : []
          const hasToolResult =
            Array.isArray(body.messages) &&
            body.messages.some(
              (message) =>
                typeof message === 'object' &&
                message !== null &&
                (message as { role?: string }).role === 'tool'
            )
          if (tools.length > 0 && !hasToolResult) {
            streamToolCallResponse(response, body)
          } else {
            streamTextResponse(response, body)
          }
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
