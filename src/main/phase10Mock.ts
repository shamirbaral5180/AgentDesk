import http from 'node:http'
import type { AddressInfo } from 'node:net'

export const PHASE10_MOCK_KEY = 'agentdesk-phase10-mock-key'

export type Phase10MockServer = {
  baseUrl: string
  sawBuildPrompt: boolean
  sawReviewPrompt: boolean
  sawReportPrompt: boolean
  sawRequest: boolean
  sawTodo: boolean
  sawHostRuntimes: boolean
  maxConcurrentBuilds: number
  writePaths: string[]
  close: () => Promise<void>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sendChunk(
  response: http.ServerResponse,
  delta: Record<string, unknown>,
  finish: string | null = null
): void {
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-agentdesk-phase10',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'phase10-chat',
      choices: [{ index: 0, delta, finish_reason: finish }]
    })}\n\n`
  )
}

function sendUsage(response: http.ServerResponse): void {
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-agentdesk-phase10',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'phase10-chat',
      choices: [],
      usage: {
        prompt_tokens: 900,
        completion_tokens: 120,
        total_tokens: 1020
      }
    })}\n\n`
  )
}

function streamTools(
  response: http.ServerResponse,
  toolCalls: Array<Record<string, unknown>>
): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  sendChunk(response, { role: 'assistant', content: '' })
  void (async () => {
    await delay(40)
    sendChunk(response, { tool_calls: toolCalls })
    await delay(40)
    sendChunk(response, {}, 'tool_calls')
    sendUsage(response)
    response.write('data: [DONE]\n\n')
    response.end()
  })()
}

function streamText(response: http.ServerResponse, answer: string): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  sendChunk(response, { role: 'assistant', content: '' })
  void (async () => {
    for (const part of answer.match(/\S+\s*/g) ?? [answer]) {
      sendChunk(response, { content: part })
      await delay(4)
    }
    sendChunk(response, {}, 'stop')
    sendUsage(response)
    response.write('data: [DONE]\n\n')
    response.end()
  })()
}

function systemPrompt(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const system = messages.find(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      (message as { role?: string }).role === 'system'
  ) as { content?: string } | undefined
  return system?.content ?? ''
}

function toolMessageCount(body: Record<string, unknown>): number {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages.filter(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      (message as { role?: string }).role === 'tool'
  ).length
}

function taskTitle(system: string): string {
  const match = /^Title:\s*(.+)$/m.exec(system)
  return match?.[1]?.trim() ?? 'Build task'
}

function claimPath(system: string): string {
  const section = /## Active file claims\n([\s\S]*?)\n\n##/.exec(system)
  const line = section ? /^-\s+([^\s(]+)/m.exec(section[1]) : null
  const claim = line?.[1]?.trim()
  if (!claim) {
    return 'generated/phase10-output.ts'
  }
  if (claim.endsWith('/**')) {
    return `${claim.slice(0, -3)}/generated.ts`
  }
  if (claim.includes('*')) {
    return claim.replace(/\*/g, 'generated')
  }
  return claim
}

export function createPhase10MockServer(): Promise<Phase10MockServer> {
  return new Promise((resolve, reject) => {
    const writePaths: string[] = []
    const state = {
      sawBuildPrompt: false,
      sawReviewPrompt: false,
      sawReportPrompt: false,
      sawRequest: false,
      sawTodo: false,
      sawHostRuntimes: false,
      requestSent: false,
      reviewCounts: new Map<string, number>(),
      activeBuilds: 0,
      maxConcurrentBuilds: 0
    }

    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            object: 'list',
            data: [
              {
                id: 'phase10-chat',
                object: 'model',
                created: 1700000000,
                owned_by: 'agentdesk-phase10-mock'
              }
            ]
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
          const system = systemPrompt(body)
          const toolMessages = toolMessageCount(body)
          const serialized = JSON.stringify(body)
          const isBuild = system.includes('You are executing one Build task')
          const isReview = system.includes('You are the QA reviewer for this task')
          const isReport = system.includes('You are the Coordinator writing the final Build report')
          state.sawBuildPrompt = state.sawBuildPrompt || isBuild
          state.sawReviewPrompt = state.sawReviewPrompt || isReview
          state.sawReportPrompt = state.sawReportPrompt || isReport
          state.sawTodo = state.sawTodo || serialized.includes('todo_write')
          state.sawHostRuntimes =
            state.sawHostRuntimes || system.includes('## Host runtimes')
          const title = taskTitle(system)
          const target = claimPath(system)

          if (isBuild) {
            state.activeBuilds += 1
            state.maxConcurrentBuilds = Math.max(
              state.maxConcurrentBuilds,
              state.activeBuilds
            )
            response.once('close', () => {
              state.activeBuilds = Math.max(0, state.activeBuilds - 1)
            })
          }

          if (isReport) {
            streamText(
              response,
              'Parallel build report. Agents worked together, waited on shared requests, and completed their own parts.'
            )
            return
          }

          if (isReview) {
            if (toolMessages === 0) {
              streamTools(response, [
                {
                  index: 0,
                  id: `call_phase10_qa_${Date.now()}`,
                  type: 'function',
                  function: {
                    name: 'run_command',
                    arguments: JSON.stringify({
                      command: 'node -e "console.log(\'phase10 review ok\')"',
                      cwd: '.'
                    })
                  }
                }
              ])
              return
            }
            const count = (state.reviewCounts.get(title) ?? 0) + 1
            state.reviewCounts.set(title, count)
            const needsChanges =
              title.toLowerCase().includes('docs') && count <= 3
            streamText(
              response,
              JSON.stringify(
                needsChanges
                  ? {
                      status: 'changes_requested',
                      summary: 'The docs task still needs the same final section.',
                      issues: ['Add the missing deployment checklist section.'],
                      testsRun: ['node -e phase10 review ok'],
                      testsPassed: true
                    }
                  : {
                      status: 'approved',
                      summary: 'The task produced its files and the verification passes.',
                      issues: [],
                      testsRun: ['node -e phase10 review ok'],
                      testsPassed: true
                    }
              )
            )
            return
          }

          if (isBuild) {
            if (title.toLowerCase().includes('backend') && !state.requestSent) {
              state.requestSent = true
              state.sawRequest = true
              streamTools(response, [
                {
                  index: 0,
                  id: `call_phase10_request_${Date.now()}`,
                  type: 'function',
                  function: {
                    name: 'request_from_agent',
                    arguments: JSON.stringify({
                      targetAgentId: 'database',
                      title: 'Shared API contract',
                      description:
                        'Create backend/contract.ts with the shared request and response contract.',
                      acceptanceCriteria: 'The contract file exists and is readable.',
                      fileGlobs: ['backend/contract.ts'],
                      priority: 1
                    })
                  }
                }
              ])
              return
            }

            if (toolMessages === 0) {
              writePaths.push(target)
              streamTools(response, [
                {
                  index: 0,
                  id: `call_phase10_todo_${Date.now()}`,
                  type: 'function',
                  function: {
                    name: 'todo_write',
                    arguments: JSON.stringify({
                      items: [
                        { content: 'Inspect the task and claims', status: 'done' },
                        { content: 'Write the task files', status: 'in_progress' },
                        { content: 'Run verification', status: 'pending' }
                      ]
                    })
                  }
                },
                {
                  index: 1,
                  id: `call_phase10_write_${Date.now()}`,
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({
                      path: target,
                      content: `// Phase 10 parallel output\nexport const task = '${title.replace(/'/g, '')}'\n`
                    })
                  }
                },
                {
                  index: 2,
                  id: `call_phase10_command_${Date.now()}`,
                  type: 'function',
                  function: {
                    name: 'run_command',
                    arguments: JSON.stringify({
                      command: 'node -e "console.log(\'phase10 build ok\')"',
                      cwd: '.'
                    })
                  }
                }
              ])
              return
            }
            streamText(
              response,
              `Completed "${title}" and notified the team.`
            )
            return
          }

          streamText(response, 'No Build phase matched this request.')
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
        get sawBuildPrompt() {
          return state.sawBuildPrompt
        },
        get sawReviewPrompt() {
          return state.sawReviewPrompt
        },
        get sawReportPrompt() {
          return state.sawReportPrompt
        },
        get sawRequest() {
          return state.sawRequest
        },
        get sawTodo() {
          return state.sawTodo
        },
        get sawHostRuntimes() {
          return state.sawHostRuntimes
        },
        get maxConcurrentBuilds() {
          return state.maxConcurrentBuilds
        },
        get writePaths() {
          return writePaths
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
