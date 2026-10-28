import http from 'node:http'
import type { AddressInfo } from 'node:net'

export const PHASE7_MOCK_KEY = 'agentdesk-phase7-mock-key'

export type Phase7MockServer = {
  baseUrl: string
  requests: Array<Record<string, unknown>>
  sawBuildPrompt: boolean
  sawReviewPrompt: boolean
  sawReportPrompt: boolean
  sawActiveClaim: boolean
  reviewRequests: number
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
      id: 'chatcmpl-agentdesk-phase7',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'phase7-chat',
      choices: [{ index: 0, delta, finish_reason: finish }]
    })}\n\n`
  )
}

function sendUsage(
  response: http.ServerResponse,
  promptTokens: number,
  completionTokens: number
): void {
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-agentdesk-phase7',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'phase7-chat',
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      }
    })}\n\n`
  )
}

function streamTools(
  response: http.ServerResponse,
  toolCalls: Array<Record<string, unknown>>,
  toolDelayMs = 25
): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  sendChunk(response, { role: 'assistant', content: '' })
  void (async () => {
    await delay(toolDelayMs)
    sendChunk(response, { tool_calls: toolCalls })
    await delay(toolDelayMs)
    sendChunk(response, {}, 'tool_calls')
    sendUsage(response, 900, 120)
    response.write('data: [DONE]\n\n')
    response.end()
  })()
}

function streamText(response: http.ServerResponse, answer: string, delayMs = 6): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  sendChunk(response, { role: 'assistant', content: '' })
  void (async () => {
    for (const part of answer.match(/\S+\s*/g) ?? [answer]) {
      sendChunk(response, { content: part })
      await delay(delayMs)
    }
    sendChunk(response, {}, 'stop')
    sendUsage(response, 1_100, 150)
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

function concreteClaimPath(system: string): string | null {
  const section = /## Active file claims\n([\s\S]*?)\n\n##/.exec(system)
  if (!section) {
    return null
  }
  const line = /^-\s+([^\s(]+)/m.exec(section[1])
  const claim = line?.[1]?.trim()
  if (!claim) {
    return null
  }
  if (claim.endsWith('/**')) {
    return `${claim.slice(0, -3)}/build-output.ts`
  }
  if (claim.includes('*')) {
    return claim.replace(/\*/g, 'build-output')
  }
  return claim
}

export function createPhase7MockServer(): Promise<Phase7MockServer> {
  return new Promise((resolve, reject) => {
    const requests: Array<Record<string, unknown>> = []
    const writePaths: string[] = []
    const state = {
      sawBuildPrompt: false,
      sawReviewPrompt: false,
      sawReportPrompt: false,
      sawActiveClaim: false,
      reviewRequests: 0
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
                id: 'phase7-chat',
                object: 'model',
                created: 1700000000,
                owned_by: 'agentdesk-phase7-mock'
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
          requests.push(body)
          const system = systemPrompt(body)
          const toolMessages = toolMessageCount(body)
          const isBuild = system.includes('You are executing one Build task')
          const isReview = system.includes('You are the QA reviewer for this task')
          const isReport = system.includes('You are the Coordinator writing the final Build report')
          const hasClaim = system.includes('## Active file claims') && !system.includes('(no active claims)')
          state.sawBuildPrompt = state.sawBuildPrompt || isBuild
          state.sawReviewPrompt = state.sawReviewPrompt || isReview
          state.sawReportPrompt = state.sawReportPrompt || isReport
          state.sawActiveClaim = state.sawActiveClaim || hasClaim
          const title = taskTitle(system)
          const claimPath = concreteClaimPath(system)

          if (isReport) {
            streamText(
              response,
              [
                'Build report for the Boss.',
                '',
                'The approved plan was executed sequentially with one active writer at a time.',
                'Every file write was claim-checked, snapshotted, and recorded in the change log.',
                'QA reviewed each task; the first review requested a focused fix, then approved it.',
                'Commands and approval decisions are listed in the final report.',
                'No unresolved blockers remain for the completed tasks.'
              ].join('\n')
            )
            return
          }

          if (isReview) {
            if (toolMessages === 0) {
              streamTools(response, [
                {
                  index: 0,
                  id: `call_phase7_qa_${Date.now()}`,
                  type: 'function',
                  function: {
                    name: 'run_command',
                    arguments: JSON.stringify({
                      command: `node -e "console.log('phase7 qa test output for ${title}')"`,
                      cwd: '.'
                    })
                  }
                }
              ])
              return
            }
            state.reviewRequests += 1
            const changesRequested = state.reviewRequests === 1
            streamText(
              response,
              JSON.stringify(
                changesRequested
                  ? {
                      status: 'changes_requested',
                      summary: 'The slice is close, but the change needs one focused follow-up.',
                      issues: [
                        'Add a clear marker that proves the Build task produced its claimed file.',
                        'Re-run the verification after the follow-up change.'
                      ],
                      testsRun: ['node -e phase7 qa test output'],
                      testsPassed: true
                    }
                  : {
                      status: 'approved',
                      summary: 'The task matches its claim and the verification passes.',
                      issues: [],
                      testsRun: ['node -e phase7 qa test output'],
                      testsPassed: true
                    }
              ),
              2
            )
            return
          }

          if (isBuild) {
            if (toolMessages === 0) {
              const target = claimPath ?? 'src/build-output.ts'
              writePaths.push(target)
              streamTools(response, [
                {
                  index: 0,
                  id: `call_phase7_write_${Date.now()}`,
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({
                      path: target,
                      content: `// Phase 7 Build output\nexport const phase7Build = '${title.replace(/'/g, '')}'\n`
                    })
                  }
                },
                {
                  index: 1,
                  id: `call_phase7_command_${Date.now()}`,
                  type: 'function',
                  function: {
                    name: 'run_command',
                    arguments: JSON.stringify({
                      command: `node -e "console.log('phase7 build command output for ${title}')"`,
                      cwd: '.'
                    })
                  }
                }
              ])
              return
            }
            streamText(
              response,
              [
                `Implemented "${title}" inside the active file claim.`,
                `File changed: ${claimPath ?? 'src/build-output.ts'}.`,
                'Ran the approved build verification command.',
                'Summary: the task is ready for QA review.',
                'Next steps: QA should verify the behavior and either approve or request a fix.'
              ].join('\n')
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
        requests,
        get sawBuildPrompt() {
          return state.sawBuildPrompt
        },
        get sawReviewPrompt() {
          return state.sawReviewPrompt
        },
        get sawReportPrompt() {
          return state.sawReportPrompt
        },
        get sawActiveClaim() {
          return state.sawActiveClaim
        },
        get reviewRequests() {
          return state.reviewRequests
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
