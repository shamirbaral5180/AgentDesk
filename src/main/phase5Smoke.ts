import fs from 'node:fs'
import path from 'node:path'
import type { WebContents } from 'electron'
import {
  IPC_CHANNELS,
  type ApprovalEvent,
  type ChatEvent
} from '@shared/types'
import { getAppPaths } from './config/appPaths'
import { removeRecentProject } from './config/settings'
import { closeProject, openProject } from './project/projectService'
import { setAgentModel } from './project/teamService'
import {
  addModel,
  createProvider,
  deleteProvider,
  updateProvider
} from './providers/providerService'
import { createSessionForAgent, startChatRun } from './chat/chatService'
import { getChatSession } from './chat/sessionService'
import {
  deleteMemory,
  listMemory,
  memorySummaryForTool,
  retrieveMemoryContext,
  toggleMemoryPin
} from './memory/memoryService'
import { decideApproval } from './approvals/approvalService'
import { killAllManagedProcesses } from './commands/commandRunner'
import {
  createPhase4MockServer,
  type Phase4MockServer,
  PHASE4_FEATURE_PATH,
  PHASE4_MOCK_KEY,
  PHASE4_OUTSIDE_FILE
} from './phase4Mock'
import {
  createPhase5MockServer,
  type Phase5MockServer
} from './phase5Mock'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fakeSender(
  chatEvents: ChatEvent[],
  approvalEvents: ApprovalEvent[],
  autoApprove: boolean
): WebContents {
  return {
    isDestroyed: () => false,
    send: (channel: string, event: ChatEvent | ApprovalEvent) => {
      if (channel === IPC_CHANNELS.chatEvent) {
        chatEvents.push(event as ChatEvent)
        return
      }
      if (channel !== IPC_CHANNELS.approvalEvent) {
        return
      }
      const approvalEvent = event as ApprovalEvent
      approvalEvents.push(approvalEvent)
      if (autoApprove && approvalEvent.type === 'request') {
        decideApproval({
          approvalId: approvalEvent.approval.id,
          decision: 'once'
        })
      }
    }
  } as unknown as WebContents
}

async function waitForChatRun(events: ChatEvent[], runId: string): Promise<ChatEvent> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 30_000) {
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
  throw new Error('Timed out waiting for the Phase 5 chat run')
}

function writeProject(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'phase5-memory-project',
        version: '1.0.0',
        private: true,
        scripts: { test: 'node -e "console.log(\\"phase5 tests ok\\")"' }
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
}

export async function runPhase5Smoke(): Promise<number> {
  const paths = getAppPaths()
  const projectRoot = path.join(paths.tmpDir, `phase5-smoke-${Date.now()}`)
  const outsideFile = path.resolve(projectRoot, PHASE4_OUTSIDE_FILE)
  const featureFile = path.join(projectRoot, PHASE4_FEATURE_PATH)
  let phase4Mock: Phase4MockServer | null = null
  let phase5Mock: Phase5MockServer | null = null
  let providerId: string | null = null

  try {
    writeProject(projectRoot)
    openProject(projectRoot)
    phase4Mock = await createPhase4MockServer()

    const provider = createProvider({
      type: 'custom',
      name: 'Memory Lab',
      baseUrl: phase4Mock.baseUrl,
      apiKey: PHASE4_MOCK_KEY
    })
    providerId = provider.provider.id
    const model = addModel({
      providerId,
      modelId: 'phase4-chat',
      displayName: 'Memory Model',
      contextWindow: 128_000,
      maxOutputTokens: 4096,
      supportsTools: true,
      supportsVision: false
    })
    setAgentModel({
      agentId: 'backend',
      modelRecordId: model.model.id,
      temperature: 0.2
    })

    const firstSession = createSessionForAgent('backend', 'build')
    const firstChat: ChatEvent[] = []
    const firstApprovals: ApprovalEvent[] = []
    const firstRun = startChatRun(fakeSender(firstChat, firstApprovals, true), {
      sessionId: firstSession.session.id,
      agentId: 'backend',
      text: 'Build the memory seed feature and run the outside check.',
      attachmentIds: [],
      mode: 'build'
    })
    const firstTerminal = await waitForChatRun(firstChat, firstRun.runId)
    if (firstTerminal.type !== 'done') {
      throw new Error(
        firstTerminal.type === 'error'
          ? firstTerminal.message
          : 'The Phase 5 memory seed run was cancelled'
      )
    }
    if (!fs.existsSync(featureFile)) {
      throw new Error('The memory seed did not create the feature file')
    }

    const memoryAfterRun = listMemory()
    if (memoryAfterRun.entries.length < 2) {
      throw new Error('Turn memories were not recorded')
    }
    if (!memoryAfterRun.entries.some((entry) => entry.scope === 'personal')) {
      throw new Error('Personal memory was not recorded')
    }
    if (!memoryAfterRun.entries.some((entry) => entry.scope === 'shared')) {
      throw new Error('Shared project memory was not recorded')
    }
    const summaryScopes = memoryAfterRun.summaries.map(
      (summary) => `${summary.scope}:${summary.level}`
    )
    for (const expected of ['session:session', 'personal:rolling', 'shared:rolling']) {
      if (!summaryScopes.includes(expected)) {
        throw new Error(`Missing memory summary ${expected}`)
      }
    }

    const sharedEntry = memoryAfterRun.entries.find(
      (entry) => entry.scope === 'shared' && entry.kind === 'project_update'
    )
    if (!sharedEntry) {
      throw new Error('Shared project update was not recorded')
    }
    const pinned = toggleMemoryPin(sharedEntry.id, true)
    if (!pinned.pinned) {
      throw new Error('Memory pin did not persist')
    }

    const victim = memoryAfterRun.entries.find(
      (entry) => entry.kind === 'commitment'
    ) ?? memoryAfterRun.entries.find((entry) => entry.kind === 'decision')
    if (!victim) {
      throw new Error('No memory entry was available for the delete test')
    }
    const beforeDelete = memoryAfterRun.entries.length
    deleteMemory(victim.id)
    const afterDelete = listMemory()
    if (afterDelete.entries.length !== beforeDelete - 1) {
      throw new Error('Deleting memory did not update the active memory list')
    }

    const firstContext = retrieveMemoryContext({
      agentId: 'backend',
      sessionId: firstSession.session.id,
      query: 'feature decision',
      limit: 6
    })
    if (firstContext.entries.length === 0) {
      throw new Error('Memory retrieval returned no entries')
    }

    closeProject()
    openProject(projectRoot)
    const reopened = listMemory()
    if (!reopened.entries.some((entry) => entry.id === pinned.id && entry.pinned)) {
      throw new Error('Pinned memory did not survive a project reopen')
    }

    phase5Mock = await createPhase5MockServer()
    updateProvider({
      id: providerId,
      baseUrl: phase5Mock.baseUrl
    })

    const secondSession = createSessionForAgent('backend', 'plan')
    const secondChat: ChatEvent[] = []
    const secondApprovals: ApprovalEvent[] = []
    const secondRun = startChatRun(fakeSender(secondChat, secondApprovals, false), {
      sessionId: secondSession.session.id,
      agentId: 'backend',
      text: 'What did we work on previously? Recall the feature and the decision.',
      attachmentIds: [],
      mode: 'plan'
    })
    const secondTerminal = await waitForChatRun(secondChat, secondRun.runId)
    if (secondTerminal.type !== 'done') {
      throw new Error(
        secondTerminal.type === 'error'
          ? secondTerminal.message
          : 'The cross-session recall run was cancelled'
      )
    }
    if (!phase5Mock.lastHadMemory) {
      throw new Error('The new session prompt did not include memory context')
    }
    if (!phase5Mock.lastHadFeature) {
      throw new Error('The recalled memory did not include the earlier feature')
    }
    if (!secondTerminal.message.content.includes('src/feature.ts')) {
      throw new Error('The agent did not recall the earlier feature')
    }
    const secondContext = secondTerminal.message.metadata?.context
    if (!secondContext || secondContext.memory.entries.length === 0) {
      throw new Error('The context inspector did not record retrieved memory')
    }
    if (!secondContext.tools.some((tool) => tool.name === 'recall_memory')) {
      throw new Error('The recall_memory tool was not offered')
    }
    const recalledDecision = secondContext.memory.entries.some(
      (entry) => entry.kind === 'decision' || entry.content.includes('Decision:')
    )
    if (!recalledDecision) {
      throw new Error('The recalled memory did not include the earlier decision')
    }

    const toolMemory = memorySummaryForTool({
      agentId: 'backend',
      query: 'feature',
      limit: 5
    })
    if (toolMemory.entries.length === 0) {
      throw new Error('recall_memory returned no entries')
    }

    const sessionDetail = getChatSession(secondSession.session.id)
    if (sessionDetail.messages.length !== 2) {
      throw new Error('Cross-session recall conversation did not persist')
    }

    console.log(
      `PHASE5_SMOKE_RESULT ${JSON.stringify({
        ok: true,
        providerId,
        memoryEntries: memoryAfterRun.entries.map((entry) => ({
          scope: entry.scope,
          kind: entry.kind,
          title: entry.title
        })),
        summaries: summaryScopes,
        pinnedPersisted: true,
        deleteWorks: true,
        sessionMemoryEntries: firstContext.entries.length,
        promptIncludedMemory: phase5Mock.lastHadMemory,
        promptIncludedFeature: phase5Mock.lastHadFeature,
        recallText: secondTerminal.message.content,
        recalledDecision: recalledDecision,
        contextMemoryEntries: secondContext.memory.entries.length,
        contextSummaries: secondContext.memory.summaries.map(
          (summary) => `${summary.scope}:${summary.level}`
        ),
        recallToolEntries: toolMemory.entries.length,
        messages: sessionDetail.messages.length
      })}`
    )
    return 0
  } catch (error) {
    console.error('PHASE5_SMOKE_FAILED', error)
    return 1
  } finally {
    if (providerId) {
      try {
        deleteProvider(providerId)
      } catch {
        console.error('PHASE5_SMOKE_CLEANUP_PROVIDER_FAILED')
      }
    }
    killAllManagedProcesses()
    closeProject()
    removeRecentProject(projectRoot)
    if (phase4Mock) {
      await phase4Mock.close()
    }
    if (phase5Mock) {
      await phase5Mock.close()
    }
    try {
      fs.rmSync(outsideFile, { force: true })
      fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (cleanupError) {
      console.error('PHASE5_SMOKE_CLEANUP_FAILED', cleanupError)
    }
  }
}


