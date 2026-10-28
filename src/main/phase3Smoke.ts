import fs from 'node:fs'
import path from 'node:path'
import type { WebContents } from 'electron'
import type { ChatEvent } from '@shared/types'
import { getAppPaths } from './config/appPaths'
import { removeRecentProject } from './config/settings'
import { getSecret } from './config/secrets'
import { providerKeyName } from './providers/keys'
import { closeProject, openProject } from './project/projectService'
import { setAgentModel } from './project/teamService'
import {
  createProvider,
  deleteProvider
} from './providers/providerService'
import { addModel } from './providers/providerService'
import { createImageAttachmentFromBuffer } from './chat/attachments'
import {
  cancelChatRun,
  createSessionForAgent,
  startChatRun
} from './chat/chatService'
import {
  getChatSession,
  listChatSessions
} from './chat/sessionService'
import {
  createMockChatServer,
  type MockChatServer,
  MOCK_CHAT_KEY
} from './chatMock'

const PHASE3_PROJECT_NAME = 'phase3-smoke-project'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fakeSender(events: ChatEvent[]): WebContents {
  return {
    isDestroyed: () => false,
    send: (_channel: string, event: ChatEvent) => {
      events.push(event)
    }
  } as unknown as WebContents
}

async function waitForRun(
  events: ChatEvent[],
  runId: string,
  timeoutMs = 20_000
): Promise<ChatEvent> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const terminal = events.find(
      (event) =>
        event.runId === runId &&
        (event.type === 'done' || event.type === 'error' || event.type === 'cancelled')
    )
    if (terminal) {
      return terminal
    }
    await delay(50)
  }
  throw new Error('Timed out waiting for the Phase 3 chat run')
}

async function waitForEvent(
  events: ChatEvent[],
  runId: string,
  predicate: (event: ChatEvent) => boolean,
  timeoutMs = 20_000
): Promise<ChatEvent> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const match = events.find((event) => event.runId === runId && predicate(event))
    if (match) {
      return match
    }
    await delay(40)
  }
  throw new Error('Timed out waiting for a Phase 3 chat event')
}

function writeProject(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: PHASE3_PROJECT_NAME,
        version: '1.0.0',
        private: true,
        scripts: {
          build: 'tsc',
          test: 'vitest run'
        },
        dependencies: {
          electron: '45.0.0',
          react: '19.3.1',
          typescript: '5.9.3'
        }
      },
      null,
      2
    ),
    'utf8'
  )
  fs.writeFileSync(
    path.join(root, 'src', 'App.tsx'),
    'export function App() { return null }\n',
    'utf8'
  )
  fs.writeFileSync(
    path.join(root, 'README.md'),
    '# Phase 3 smoke project\n\nThe coordinator should read this repository.\n',
    'utf8'
  )
}

export async function runPhase3Smoke(): Promise<number> {
  const paths = getAppPaths()
  const projectRoot = path.join(paths.tmpDir, `phase3-smoke-${Date.now()}`)
  let mock: MockChatServer | null = null
  let providerId: string | null = null

  try {
    writeProject(projectRoot)
    openProject(projectRoot)
    mock = await createMockChatServer()

    const created = createProvider({
      type: 'custom',
      name: 'Phase 3 Mock',
      baseUrl: mock.baseUrl,
      apiKey: MOCK_CHAT_KEY
    })
    providerId = created.provider.id
    const keyRoundTrip = getSecret(providerKeyName(providerId)) === MOCK_CHAT_KEY
    const keyInSettings = JSON.stringify(created.settings).includes(MOCK_CHAT_KEY)
    if (!keyRoundTrip || keyInSettings) {
      throw new Error('Provider key storage check failed')
    }

    const modelResult = addModel({
      providerId,
      modelId: 'mock-chat',
      displayName: 'Mock Chat',
      contextWindow: 128_000,
      maxOutputTokens: 4096,
      supportsTools: true,
      supportsVision: true,
      inputPricePerMillion: 0.2,
      outputPricePerMillion: 0.8
    })
    setAgentModel({
      agentId: 'coordinator',
      modelRecordId: modelResult.model.id,
      temperature: 0.2
    })

    const session = createSessionForAgent('coordinator')
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==',
      'base64'
    )
    const attachment = createImageAttachmentFromBuffer({
      buffer: png,
      originalName: 'phase3-one-pixel.png'
    })

    const events: ChatEvent[] = []
    const sender = fakeSender(events)
    const first = startChatRun(sender, {
      sessionId: session.session.id,
      agentId: 'coordinator',
      text: 'Run the Phase 3 smoke check: inspect package.json and summarize this project.',
      attachmentIds: [attachment.id]
    })
    const firstTerminal = await waitForRun(events, first.runId)
    if (firstTerminal.type !== 'done') {
      throw new Error(
        firstTerminal.type === 'error'
          ? firstTerminal.message
          : 'The first Phase 3 chat run was cancelled'
      )
    }

    const start = events.find(
      (event) => event.runId === first.runId && event.type === 'start'
    )
    if (!start || start.type !== 'start') {
      throw new Error('The chat start event was not emitted')
    }
    if (start.userMessage.attachments.length !== 1) {
      throw new Error('The user message did not retain its image attachment')
    }

    const toolEvents = events.filter(
      (event) =>
        event.runId === first.runId &&
        (event.type === 'tool' || event.type === 'tool-result')
    )
    const readTool = toolEvents.find(
      (event) =>
        event.type === 'tool-result' &&
        event.tool.toolName === 'read_file' &&
        event.tool.status === 'done'
    )
    if (!readTool) {
      throw new Error('The read_file tool did not complete')
    }
    const readOutput =
      readTool.type === 'tool-result' ? JSON.stringify(readTool.tool.output) : ''
    if (!readOutput.includes(PHASE3_PROJECT_NAME)) {
      throw new Error('read_file did not return the package name')
    }

    const deltaCount = events.filter(
      (event) => event.runId === first.runId && event.type === 'delta'
    ).length
    if (deltaCount === 0) {
      throw new Error('No streamed text deltas were emitted')
    }

    if (!firstTerminal.message.content.includes(PHASE3_PROJECT_NAME)) {
      throw new Error('The assistant answer did not reference the inspected package name')
    }
    const context = firstTerminal.message.metadata?.context
    if (!context) {
      throw new Error('The context snapshot was not persisted')
    }
    if (!context.system.includes('Plan (read-only)')) {
      throw new Error('The system prompt does not describe read-only Plan mode')
    }
    if (!context.system.includes('Coordinator & Architect')) {
      throw new Error('The system prompt does not include the role card')
    }
    const toolNames = context.tools.map((tool) => tool.name)
    if (!toolNames.includes('read_file') || !toolNames.includes('search_project')) {
      throw new Error('The context snapshot does not include the read-only tools')
    }
    if (!context.history.some((item) => item.imageCount === 1)) {
      throw new Error('The context snapshot does not record the image attachment')
    }
    if (!context.usage?.inputTokens || !context.usage.outputTokens) {
      throw new Error('The context snapshot is missing token usage')
    }
    if (!firstTerminal.message.content.includes('attached image')) {
      throw new Error('The mock model did not receive the image')
    }
    if ((firstTerminal.message.metadata?.toolCalls?.length ?? 0) < 1) {
      throw new Error('Tool call traces were not persisted')
    }

    const firstRequest = JSON.stringify(mock.requests[0] ?? {})
    if (!firstRequest.includes('image_url') && !firstRequest.includes('data:image/')) {
      throw new Error('The image was not included in the model request')
    }
    const secondRequest = JSON.stringify(mock.requests[1] ?? {})
    if (!secondRequest.includes('"role":"tool"')) {
      throw new Error('Tool results were not sent back to the model')
    }

    closeProject()
    openProject(projectRoot)
    const reconnected = getChatSession(session.session.id)
    if (reconnected.messages.length !== 2) {
      throw new Error(
        `Expected 2 persisted messages after reopen, got ${reconnected.messages.length}`
      )
    }
    if (!reconnected.messages[1].content.includes(PHASE3_PROJECT_NAME)) {
      throw new Error('The assistant message did not survive a project reopen')
    }
    const sessions = listChatSessions('coordinator')
    if (sessions.length !== 1) {
      throw new Error(`Expected 1 persisted session after reopen, got ${sessions.length}`)
    }

    const second = startChatRun(sender, {
      sessionId: reconnected.session.id,
      agentId: 'coordinator',
      text: 'Continue the Phase 3 smoke check with one more sentence.',
      attachmentIds: []
    })
    const secondTerminal = await waitForRun(events, second.runId)
    if (secondTerminal.type !== 'done') {
      throw new Error(
        secondTerminal.type === 'error'
          ? secondTerminal.message
          : 'The resumed Phase 3 chat run was cancelled'
      )
    }
    const resumed = getChatSession(reconnected.session.id)
    if (resumed.messages.length !== 4) {
      throw new Error(`Expected 4 messages after continuing, got ${resumed.messages.length}`)
    }

    const cancelSession = createSessionForAgent('coordinator')
    const cancelRun = startChatRun(sender, {
      sessionId: cancelSession.session.id,
      agentId: 'coordinator',
      text: 'Give me a long architecture tour for the Phase 3 smoke cancellation test.',
      attachmentIds: []
    })
    await waitForEvent(events, cancelRun.runId, (event) => event.type === 'delta')
    await delay(80)
    cancelChatRun(cancelRun.runId)
    const cancelled = await waitForRun(events, cancelRun.runId)
    if (cancelled.type !== 'cancelled') {
      throw new Error(
        cancelled.type === 'error'
          ? cancelled.message
          : 'The cancellation test completed instead of stopping'
      )
    }
    if (!cancelled.message.metadata?.cancelled) {
      throw new Error('The cancelled assistant message was not marked as stopped')
    }

    console.log(
      `PHASE3_SMOKE_RESULT ${JSON.stringify({
        ok: true,
        providerId,
        baseUrl: mock.baseUrl,
        keyRoundTrip,
        keyInSettings,
        sessionId: resumed.session.id,
        messages: resumed.messages.length,
        toolCalls: firstTerminal.message.metadata?.toolCalls?.map((tool) => ({
          name: tool.toolName,
          status: tool.status
        })),
        contextTools: toolNames,
        contextFiles: context.contextFiles.map((file) => file.path),
        contextHistory: context.history.length,
        estimatedPromptTokens: context.estimatedPromptTokens,
        inputTokens: context.usage.inputTokens,
        outputTokens: context.usage.outputTokens,
        deltaCount,
        streamText: firstTerminal.message.content,
        imageAttachment: start.userMessage.attachments[0]?.name,
        imageInRequest:
          firstRequest.includes('image_url') || firstRequest.includes('data:image/'),
        toolResultInSecondRequest: secondRequest.includes('"role":"tool"'),
        cancellationStopped: cancelled.type === 'cancelled'
      })}`
    )
    return 0
  } catch (error) {
    console.error('PHASE3_SMOKE_FAILED', error)
    return 1
  } finally {
    if (providerId) {
      try {
        deleteProvider(providerId)
      } catch {
        console.error('PHASE3_SMOKE_CLEANUP_PROVIDER_FAILED')
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

