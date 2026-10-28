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
import { getSecret } from './config/secrets'
import { providerKeyName } from './providers/keys'
import { closeProject, openProject } from './project/projectService'
import { setAgentModel } from './project/teamService'
import { addModel, createProvider, deleteProvider } from './providers/providerService'
import { createSessionForAgent, setSessionMode, startChatRun } from './chat/chatService'
import { getChatSession } from './chat/sessionService'
import { listChanges, revertChange } from './changes/changeService'
import {
  decideApproval,
  listPendingApprovals,
  requestApproval
} from './approvals/approvalService'
import { commandActionKey } from './commands/commandPolicy'
import {
  killAllManagedProcesses,
  listManagedProcesses,
  runCommand,
  stopManagedProcess
} from './commands/commandRunner'
import {
  createPhase4MockServer,
  type Phase4MockServer,
  PHASE4_FEATURE_PATH,
  PHASE4_MOCK_KEY,
  PHASE4_OUTSIDE_FILE
} from './phase4Mock'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fakeSender(
  chatEvents: ChatEvent[],
  approvalEvents: ApprovalEvent[]
): WebContents {
  return {
    isDestroyed: () => false,
    send: (channel: string, event: ChatEvent | ApprovalEvent) => {
      if (channel === IPC_CHANNELS.chatEvent) {
        chatEvents.push(event as ChatEvent)
      } else if (channel === IPC_CHANNELS.approvalEvent) {
        approvalEvents.push(event as ApprovalEvent)
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
  throw new Error('Timed out waiting for the Phase 4 chat run')
}

async function waitForApproval(
  events: ApprovalEvent[],
  predicate: (event: ApprovalEvent) => boolean
): Promise<ApprovalEvent> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 15_000) {
    const match = events.find(predicate)
    if (match) {
      return match
    }
    await delay(40)
  }
  throw new Error('Timed out waiting for the Phase 4 approval')
}

function writeProject(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'phase4-smoke-project',
        version: '1.0.0',
        private: true,
        scripts: {
          test: 'node -e "console.log(\\"phase4 tests ok\\")"'
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
}

export async function runPhase4Smoke(): Promise<number> {
  const paths = getAppPaths()
  const projectRoot = path.join(paths.tmpDir, `phase4-smoke-${Date.now()}`)
  const outsideFile = path.resolve(projectRoot, PHASE4_OUTSIDE_FILE)
  const featureFile = path.join(projectRoot, PHASE4_FEATURE_PATH)
  let mock: Phase4MockServer | null = null
  let providerId: string | null = null

  try {
    writeProject(projectRoot)
    openProject(projectRoot)
    mock = await createPhase4MockServer()

    const created = createProvider({
      type: 'custom',
      name: 'Phase 4 Mock',
      baseUrl: mock.baseUrl,
      apiKey: PHASE4_MOCK_KEY
    })
    providerId = created.provider.id
    const keyInSettings = JSON.stringify(created.settings).includes(PHASE4_MOCK_KEY)
    const keyRoundTrip = getSecret(providerKeyName(providerId)) === PHASE4_MOCK_KEY
    if (!keyRoundTrip || keyInSettings) {
      throw new Error('Provider key storage check failed')
    }

    const model = addModel({
      providerId,
      modelId: 'phase4-chat',
      displayName: 'Phase 4 Chat',
      contextWindow: 128_000,
      maxOutputTokens: 4096,
      supportsTools: true,
      supportsVision: false,
      inputPricePerMillion: 0.2,
      outputPricePerMillion: 0.8
    })
    setAgentModel({
      agentId: 'backend',
      modelRecordId: model.model.id,
      temperature: 0.2
    })

    const session = createSessionForAgent('backend', 'build')
    const planMode = setSessionMode(session.session.id, 'plan')
    if (planMode.session.mode !== 'plan') {
      throw new Error('Plan mode switch did not persist')
    }
    const buildMode = setSessionMode(session.session.id, 'build')
    if (buildMode.session.mode !== 'build') {
      throw new Error('Build mode switch did not persist')
    }
    const chatEvents: ChatEvent[] = []
    const approvalEvents: ApprovalEvent[] = []
    const sender = fakeSender(chatEvents, approvalEvents)
    const run = startChatRun(sender, {
      sessionId: session.session.id,
      agentId: 'backend',
      text: 'Implement the Phase 4 smoke feature and run the outside-repo check.',
      attachmentIds: [],
      mode: 'build'
    })

    const requestApprovalEvent = await waitForApproval(
      approvalEvents,
      (event) =>
        event.type === 'request' &&
        event.approval.runId === run.runId &&
        event.approval.actionType === 'run_command'
    )
    if (requestApprovalEvent.type !== 'request') {
      throw new Error('Approval request event was not received')
    }
    if (requestApprovalEvent.approval.risk !== 'high') {
      throw new Error('Outside-repo command was not classified as high risk')
    }
    decideApproval({
      approvalId: requestApprovalEvent.approval.id,
      decision: 'once'
    })

    const terminal = await waitForChatRun(chatEvents, run.runId)
    if (terminal.type !== 'done') {
      throw new Error(
        terminal.type === 'error' ? terminal.message : 'The Phase 4 chat run was cancelled'
      )
    }

    if (!fs.existsSync(featureFile)) {
      throw new Error('The agent did not create the feature file')
    }
    const featureContent = fs.readFileSync(featureFile, 'utf8')
    if (!featureContent.includes("phase4Feature = 'patched'")) {
      throw new Error(`The feature was not patched: ${featureContent}`)
    }
    if (!fs.existsSync(outsideFile) || !fs.readFileSync(outsideFile, 'utf8').includes('outside-approved')) {
      throw new Error('The approved outside-repo command did not run')
    }

    const toolNames = terminal.message.metadata?.toolCalls?.map((tool) => tool.toolName) ?? []
    for (const expected of ['write_file', 'run_command', 'patch_file']) {
      if (!toolNames.includes(expected)) {
        throw new Error(`Tool trace is missing ${expected}`)
      }
    }
    const context = terminal.message.metadata?.context
    if (!context || context.mode !== 'build') {
      throw new Error('The context snapshot was not recorded in build mode')
    }
    if (!context.tools.some((tool) => tool.name === 'write_file')) {
      throw new Error('Build mode did not offer the write_file tool')
    }
    const commandOutputStreamed = chatEvents.some(
      (event) => event.type === 'tool-output' && event.text.includes('phase4-command-output')
    )
    if (!commandOutputStreamed) {
      throw new Error('Command output was not streamed to the renderer')
    }

    const detail = getChatSession(session.session.id)
    if (detail.session.mode !== 'build') {
      throw new Error('The session mode did not persist as build')
    }

    const changes = listChanges(session.session.id)
    const commandChange = changes.find((change) => change.type === 'command')
    if (!commandChange || commandChange.exitCode !== 0) {
      throw new Error('The command was not recorded with exit code 0')
    }
    const patchChange = changes.find((change) => change.type === 'patch')
    const writeChange = changes.find((change) => change.type === 'write')
    if (!patchChange || !writeChange) {
      throw new Error('Write and patch changes were not recorded')
    }

    const patchRevert = revertChange(patchChange.id)
    if (patchRevert.changes.length <= changes.length) {
      throw new Error('Reverting the patch did not add a revert entry')
    }
    if (!fs.readFileSync(featureFile, 'utf8').includes('phase4Feature = true')) {
      throw new Error('Reverting the patch did not restore the previous feature content')
    }
    revertChange(writeChange.id)
    if (fs.existsSync(featureFile)) {
      throw new Error('Reverting the initial write did not remove the new file')
    }

    const grantCommand = 'node -e "console.log(\'grant-test\')"'
    const grantKey = commandActionKey('.', grantCommand)
    const grantBase = {
      sessionId: session.session.id,
      runId: 'grant-test-run',
      agentId: 'backend',
      actionType: 'run_command' as const,
      actionKey: grantKey,
      risk: 'high' as const,
      reason: 'Phase 4 session grant test',
      payload: { command: grantCommand, cwd: '.' }
    }
    const eventsBeforeGrant = approvalEvents.length
    const firstGrant = requestApproval(sender, grantBase)
    const grantRequest = await waitForApproval(
      approvalEvents,
      (event) =>
        event.type === 'request' && event.approval.actionKey === grantKey
    )
    if (grantRequest.type !== 'request') {
      throw new Error('The grant test approval request was not received')
    }
    decideApproval({
      approvalId: grantRequest.approval.id,
      decision: 'session'
    })
    const firstGrantResult = await firstGrant
    if (firstGrantResult.decision !== 'approved') {
      throw new Error('The first grant approval was not approved')
    }
    const secondGrantResult = await requestApproval(sender, grantBase)
    if (secondGrantResult.decision !== 'approved') {
      throw new Error('The session grant did not auto-approve the second request')
    }
    if (approvalEvents.length !== eventsBeforeGrant + 2) {
      throw new Error('The session grant emitted an unexpected approval request')
    }
    if (listPendingApprovals().length !== 0) {
      throw new Error('Approval queue was not empty after the decisions')
    }

    closeProject()
    openProject(projectRoot)
    const persistedChanges = listChanges(session.session.id)
    if (!persistedChanges.some((change) => change.type === 'revert')) {
      throw new Error('Change history did not persist across project reopen')
    }

    const streamed: string[] = []
    const foreground = await runCommand({
      command: 'echo phase4-command-stream',
      cwd: projectRoot,
      onOutput: (_stream, text) => streamed.push(text)
    })
    if (foreground.exitCode !== 0 || !streamed.join('').includes('phase4-command-stream')) {
      throw new Error('Foreground command output did not stream')
    }

    const background = await runCommand({
      command: 'node -e "setInterval(() => console.log(\'phase4-tick\'), 100)"',
      cwd: paths.tmpDir,
      background: true,
      onOutput: () => undefined
    })
    await delay(350)
    const running = listManagedProcesses().find(
      (process) => process.processId === background.processId
    )
    if (!running || running.status !== 'running') {
      throw new Error('Background process was not tracked')
    }
    const stopped = stopManagedProcess(background.processId)
    if (stopped.status !== 'stopped') {
      throw new Error('Background process was not stopped')
    }
    killAllManagedProcesses()
    await delay(700)
    if (listManagedProcesses().length !== 0) {
      throw new Error('Process cleanup did not clear tracked processes')
    }

    console.log(
      `PHASE4_SMOKE_RESULT ${JSON.stringify({
        ok: true,
        providerId,
        baseUrl: mock.baseUrl,
        keyRoundTrip,
        keyInSettings,
        sessionId: session.session.id,
        mode: detail.session.mode,
        toolNames,
        contextTools: context.tools.map((tool) => tool.name),
        approvalRisk: requestApprovalEvent.approval.risk,
        approvalScope: requestApprovalEvent.approval.scope,
        changes: changes.map((change) => ({
          type: change.type,
          path: change.path,
          exitCode: change.exitCode,
          canRevert: change.canRevert
        })),
        patchReverted: patchRevert.change.type,
        featureRemovedAfterRevert: !fs.existsSync(featureFile),
        outsideFileCreated: fs.existsSync(outsideFile),
        sessionGrant: secondGrantResult.scope,
        persistedChangeCount: persistedChanges.length,
        foregroundExitCode: foreground.exitCode,
        commandOutputStreamed: commandOutputStreamed,
        foregroundStreamed: streamed.join('').includes('phase4-command-stream'),
        backgroundProcessId: background.processId,
        backgroundStopped: stopped.status,
        streamText: terminal.message.content
      })}`
    )
    return 0
  } catch (error) {
    console.error('PHASE4_SMOKE_FAILED', error)
    return 1
  } finally {
    if (providerId) {
      try {
        deleteProvider(providerId)
      } catch {
        console.error('PHASE4_SMOKE_CLEANUP_PROVIDER_FAILED')
      }
    }
    closeProject()
    removeRecentProject(projectRoot)
    if (mock) {
      await mock.close()
    }
    killAllManagedProcesses()
    await delay(500)
    try {
      fs.rmSync(outsideFile, { force: true })
      fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (cleanupError) {
      console.error('PHASE4_SMOKE_CLEANUP_FAILED', cleanupError)
    }
  }
}






