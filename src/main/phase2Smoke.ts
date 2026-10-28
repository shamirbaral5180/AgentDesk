import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { WebContents } from 'electron'
import type { ModelTestEvent } from '@shared/types'
import { getAppPaths } from './config/appPaths'
import { removeRecentProject } from './config/settings'
import { getSecret } from './config/secrets'
import { providerKeyName } from './providers/keys'
import { closeProject, getCurrentProject, openProject } from './project/projectService'
import { setAgentModel } from './project/teamService'
import {
  createProvider,
  deleteProvider,
  discoverProviderModels
} from './providers/providerService'
import { startModelTest } from './providers/modelTestService'

export const MOCK_KEY = 'agentdesk-mock-key'

export type MockServer = {
  baseUrl: string
  close: () => Promise<void>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function openAIModel(id: string): Record<string, unknown> {
  return {
    id,
    object: 'model',
    created: 1700000000,
    owned_by: 'agentdesk-mock'
  }
}

export function createMockOpenAIServer(): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            object: 'list',
            data: [openAIModel('mock-fast'), openAIModel('mock-vision')]
          })
        )
        return
      }

      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        request.resume()
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
            id: 'chatcmpl-agentdesk-mock',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'mock-fast',
            choices: [{ index: 0, delta, finish_reason: finish }]
          })
        }

        void (async () => {
          chunk({ role: 'assistant', content: '' })
          await delay(25)
          chunk({ content: 'Mock provider ' })
          await delay(25)
          chunk({ content: 'is online. ' })
          await delay(25)
          chunk({ content: 'Model: mock-fast.' })
          await delay(25)
          chunk({}, 'stop')
          send({
            id: 'chatcmpl-agentdesk-mock',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'mock-fast',
            choices: [],
            usage: {
              prompt_tokens: 17,
              completion_tokens: 7,
              total_tokens: 24
            }
          })
          response.write('data: [DONE]\n\n')
          response.end()
        })().catch(() => {
          response.end()
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
        close: () =>
          new Promise<void>((closeResolve) => {
            server.closeAllConnections()
            server.close(() => closeResolve())
          })
      })
    })
  })
}

function fakeSender(events: ModelTestEvent[]): WebContents {
  return {
    isDestroyed: () => false,
    send: (_channel: string, event: ModelTestEvent) => {
      events.push(event)
    }
  } as unknown as WebContents
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }
    await delay(50)
  }
  throw new Error('Timed out waiting for the model stream')
}

export async function runPhase2Smoke(): Promise<number> {
  const paths = getAppPaths()
  const projectRoot = path.join(paths.tmpDir, `phase2-smoke-${Date.now()}`)
  let mock: MockServer | null = null
  let providerId: string | null = null

  try {
    fs.mkdirSync(projectRoot, { recursive: true })
    fs.writeFileSync(
      path.join(projectRoot, 'README.md'),
      '# Phase 2 smoke project\n',
      'utf8'
    )
    openProject(projectRoot)
    mock = await createMockOpenAIServer()

    const created = createProvider({
      type: 'custom',
      name: 'AgentDesk Mock',
      baseUrl: mock.baseUrl,
      apiKey: MOCK_KEY
    })
    providerId = created.provider.id
    const keyRoundTrip =
      created.provider.hasKey &&
      getSecret(providerKeyName(providerId)) === MOCK_KEY
    const keyInSettings = JSON.stringify(created.settings).includes(MOCK_KEY)
    if (!keyRoundTrip || keyInSettings) {
      throw new Error('Provider key storage check failed')
    }

    const discovery = await discoverProviderModels(providerId)
    if (discovery.discovered < 2) {
      throw new Error(`Expected 2 mock models, got ${discovery.discovered}`)
    }
    const fastModel = discovery.settings.models.find(
      (model) => model.providerId === providerId && model.modelId === 'mock-fast'
    )
    if (!fastModel) {
      throw new Error('mock-fast was not added to the catalog')
    }

    setAgentModel({
      agentId: 'coordinator',
      modelRecordId: fastModel.id
    })
    const project = getCurrentProject()
    const coordinator = project?.agents.find((agent) => agent.id === 'coordinator')
    if (!coordinator?.modelLabel) {
      throw new Error('Coordinator model assignment did not persist')
    }

    const events: ModelTestEvent[] = []
    const { testId } = startModelTest(fakeSender(events), {
      providerId,
      modelId: 'mock-fast',
      prompt: 'Run the Phase 2 smoke test.'
    })

    await waitFor(
      () =>
        events.some(
          (event) =>
            event.testId === testId &&
            (event.type === 'done' || event.type === 'error' || event.type === 'cancelled')
        ),
      15_000
    )

    const done = events.find(
      (event) => event.testId === testId && event.type === 'done'
    )
    const failed = events.find(
      (event) => event.testId === testId && event.type === 'error'
    )
    if (!done || done.type !== 'done') {
      throw new Error(
        failed && failed.type === 'error'
          ? failed.message
          : 'Model test did not complete'
      )
    }
    if (!done.text.includes('Mock provider is online')) {
      throw new Error(`Unexpected streamed text: ${done.text}`)
    }

    const deltaCount = events.filter(
      (event) => event.testId === testId && event.type === 'delta'
    ).length

    console.log(
      `PHASE2_SMOKE_RESULT ${JSON.stringify({
        ok: true,
        providerId,
        baseUrl: mock.baseUrl,
        discovered: discovery.discovered,
        keyRoundTrip,
        keyInSettings,
        models: discovery.settings.models
          .filter((model) => model.providerId === providerId)
          .map((model) => model.modelId),
        assignedAgent: coordinator.modelLabel,
        streamText: done.text,
        deltaCount,
        inputTokens: done.inputTokens,
        outputTokens: done.outputTokens,
        durationMs: done.durationMs
      })}`
    )
    return 0
  } catch (error) {
    console.error('PHASE2_SMOKE_FAILED', error)
    return 1
  } finally {
    if (providerId) {
      try {
        deleteProvider(providerId)
      } catch {
        console.error('PHASE2_SMOKE_CLEANUP_PROVIDER_FAILED')
      }
    }
    closeProject()
    removeRecentProject(projectRoot)
    if (mock) {
      await mock.close()
    }
    fs.rmSync(projectRoot, { recursive: true, force: true })
  }
}
