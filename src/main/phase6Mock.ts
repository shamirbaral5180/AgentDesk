import http from 'node:http'
import type { AddressInfo } from 'node:net'

export const PHASE6_MOCK_KEY = 'agentdesk-phase6-mock-key'

export type Phase6MockServer = {
  baseUrl: string
  requests: Array<Record<string, unknown>>
  sawWriteTool: boolean
  sawCommandTool: boolean
  sawMeetingPrompt: boolean
  sawIntakePrompt: boolean
  sawDiscussionPrompt: boolean
  sawPlanPrompt: boolean
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
    owned_by: 'agentdesk-phase6-mock'
  }
}

function agentName(system: string): string {
  const match = /^Name:\s*(.+)$/m.exec(system)
  return match?.[1]?.trim() ?? 'Specialist'
}

function agentRole(system: string): string {
  const match = /^Role:\s*(.+)$/m.exec(system)
  return match?.[1]?.trim() ?? 'specialist'
}

function intakeAnswer(system: string): string {
  const name = agentName(system)
  const role = agentRole(system)
  return JSON.stringify({
    understanding: `${name} will review the ${role} implications of the Boss goal and report concrete constraints before the team settles on a plan.`,
    concerns:
      role === 'qa'
        ? ['Acceptance criteria must be observable.', 'The plan needs a verification step.']
        : ['The plan should not span more files than necessary.', 'Ownership must be explicit.'],
    files: role === 'frontend' ? ['src/App.tsx', 'src/styles.css'] : ['src/App.tsx', 'package.json'],
    risks:
      role === 'frontend'
        ? ['The interface could grow beyond the requested slice.']
        : ['A file claim may overlap another specialist.'],
    approach: `Inspect the relevant files, then propose a small ${role} work item with clear acceptance criteria.`
  })
}

function discussionAnswer(system: string): string {
  const name = agentName(system)
  const role = agentRole(system)
  if (role === 'coordinator') {
    return [
      'The intake cards converge on a small, sequential slice. I will keep the plan to one owner per task,',
      'make acceptance observable, and record the tradeoff about keeping the first build narrow.',
      'Frontend should inspect the app shell, Backend should check the data boundary, Database should',
      'confirm storage impact, QA should define the verification, and DevOps should keep the docs aligned.'
    ].join(' ')
  }
  return `${name} agrees with the narrow slice. Keep the change reviewable, name the files explicitly, and let QA verify the visible behavior before the Boss approves the plan.`
}

function planAnswer(): string {
  return JSON.stringify({
    summary: 'Deliver a focused onboarding slice with explicit ownership and a QA gate.',
    approach:
      'Keep the first build narrow. Inspect the app shell and data boundary, implement a small vertical slice, then verify the behavior and document the change.',
    tasks: [
      {
        title: 'Implement the onboarding surface',
        description:
          'Add the first-run onboarding surface to the app shell and wire the visible state transitions.',
        assignee: 'frontend',
        acceptanceCriteria:
          'A new user sees the onboarding surface and can complete it without touching unrelated screens.',
        fileGlobs: ['src/App.tsx', 'src/styles.css'],
        dependsOn: [],
        priority: 1
      },
      {
        title: 'Define the data boundary',
        description:
          'Confirm the onboarding state shape and provide the smallest backend contract needed for persistence.',
        assignee: 'backend',
        acceptanceCriteria:
          'The onboarding state has one documented contract and no unused persistence fields.',
        fileGlobs: ['src/main/**'],
        dependsOn: ['Implement the onboarding surface'],
        priority: 2
      },
      {
        title: 'Verify the first-run behavior',
        description:
          'Add a focused verification for first-run completion and review the changed paths.',
        assignee: 'qa',
        acceptanceCriteria:
          'The verification covers first-run completion and the review records any residual risk.',
        fileGlobs: ['tests/**'],
        dependsOn: ['Define the data boundary'],
        priority: 2
      }
    ],
    decisions: [
      {
        title: 'Keep the first build narrow',
        context: 'The intake cards proposed several adjacent improvements.',
        decision: 'Ship one onboarding slice before expanding the scope.',
        rationale: 'A narrow slice gives the Boss a reviewable result and keeps file claims independent.'
      }
    ],
    fileClaims: [
      { agent: 'frontend', pathPrefix: 'src/App.tsx', scope: 'explicit' },
      { agent: 'frontend', pathPrefix: 'src/styles.css', scope: 'explicit' },
      { agent: 'backend', pathPrefix: 'src/main/**', scope: 'proposed' },
      { agent: 'qa', pathPrefix: 'tests/**', scope: 'proposed' }
    ],
    risks: [
      'The first slice may need a follow-up before it is production-ready.',
      'The backend contract should be confirmed before Build starts.'
    ],
    acceptanceCriteria: [
      'The onboarding surface is visible and complete.',
      'QA has a focused verification path.',
      'The Boss approves the plan before Build begins.'
    ]
  })
}

export function createPhase6MockServer(): Promise<Phase6MockServer> {
  return new Promise((resolve, reject) => {
    const requests: Array<Record<string, unknown>> = []
    const state = {
      sawWriteTool: false,
      sawCommandTool: false,
      sawMeetingPrompt: false,
      sawIntakePrompt: false,
      sawDiscussionPrompt: false,
      sawPlanPrompt: false
    }

    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            object: 'list',
            data: [modelEntry('phase6-chat')]
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
          const system =
            typeof body.messages === 'object' && Array.isArray(body.messages)
              ? (body.messages.find(
                  (message) =>
                    typeof message === 'object' &&
                    message !== null &&
                    (message as { role?: string }).role === 'system'
                ) as { content?: string } | undefined)?.content ?? ''
              : ''
          const isMeeting = serialized.includes('AgentDesk meeting room')
          const isIntake = system.includes('structured intake card')
          const isDiscussion = system.includes('team discussion round')
          const isPlan = system.includes('Produce the final, decision-ready plan')
          state.sawMeetingPrompt = state.sawMeetingPrompt || isMeeting
          state.sawIntakePrompt = state.sawIntakePrompt || isIntake
          state.sawDiscussionPrompt = state.sawDiscussionPrompt || isDiscussion
          state.sawPlanPrompt = state.sawPlanPrompt || isPlan
          if (serialized.includes('write_file')) {
            state.sawWriteTool = true
          }
          if (serialized.includes('run_command')) {
            state.sawCommandTool = true
          }

          const answer = isPlan
            ? planAnswer()
            : isIntake
              ? intakeAnswer(system)
              : isDiscussion
                ? discussionAnswer(system)
                : `Direct answer from ${agentName(system)}: the meeting remains read-only and the plan should stay focused on the Boss goal.`

          const slow = system.includes('Stop test')
          const tokenDelay = slow ? 40 : 2

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
              id: 'chatcmpl-agentdesk-phase6',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: 'phase6-chat',
              choices: [{ index: 0, delta, finish_reason: finish }]
            })
          }
          void (async () => {
            chunk({ role: 'assistant', content: '' })
            for (const part of answer.match(/\S+\s*/g) ?? [answer]) {
              if (response.destroyed) {
                return
              }
              chunk({ content: part })
              await delay(tokenDelay)
            }
            if (response.destroyed) {
              return
            }
            chunk({}, 'stop')
            send({
              id: 'chatcmpl-agentdesk-phase6',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: 'phase6-chat',
              choices: [],
              usage: {
                prompt_tokens: 900,
                completion_tokens: 120,
                total_tokens: 1020
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
        get sawWriteTool() {
          return state.sawWriteTool
        },
        get sawCommandTool() {
          return state.sawCommandTool
        },
        get sawMeetingPrompt() {
          return state.sawMeetingPrompt
        },
        get sawIntakePrompt() {
          return state.sawIntakePrompt
        },
        get sawDiscussionPrompt() {
          return state.sawDiscussionPrompt
        },
        get sawPlanPrompt() {
          return state.sawPlanPrompt
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
