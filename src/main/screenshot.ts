import fs from 'node:fs'
import path from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'
import {
  IPC_CHANNELS,
  type ApprovalEvent,
  type ChatEvent,
  type MeetingEvent
} from '@shared/types'
import { getAppPaths } from './config/appPaths'
import { removeRecentProject } from './config/settings'
import { openProject, updateCurrentTeam } from './project/projectService'
import {
  addModel,
  createProvider,
  deleteProvider,
  updateProvider
} from './providers/providerService'
import { getCurrentTeamConfig } from './project/projectService'
import { setAgentModel } from './project/teamService'
import { createImageAttachmentFromBuffer } from './chat/attachments'
import {
  createSessionForAgent,
  startChatRun
} from './chat/chatService'
import { getChatSession } from './chat/sessionService'
import { decideApproval } from './approvals/approvalService'
import { PHASE4_OUTSIDE_FILE } from './phase4Mock'
import {
  approveMeetingPlan,
  createBuildMeeting,
  createMeeting,
  startMeeting
} from './meetings/meetingService'
import {
  addServer as addMcpServer,
  removeServer as removeMcpServer,
  setProjectConfig as setMcpProjectConfig
} from './mcp/mcpService'
import { writePhase8StdioServer } from './phase8Mock'

function writeFile(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
}

export function prepareShowcaseProject(): string {
  const root = path.join(getAppPaths().tmpDir, 'agentdesk-showcase')
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })

  writeFile(
    root,
    'package.json',
    JSON.stringify(
      {
        name: 'northstar-studio',
        version: '0.4.0',
        private: true,
        scripts: {
          dev: 'vite',
          build: 'tsc && vite build',
          test: 'vitest run',
          lint: 'eslint .'
        },
        dependencies: {
          electron: '45.0.0',
          react: '19.3.1',
          'react-dom': '19.3.1'
        },
        devDependencies: {
          typescript: '5.9.3',
          vite: '8.3.5',
          vitest: '4.0.0'
        }
      },
      null,
      2
    )
  )
  writeFile(
    root,
    'src/App.tsx',
    [
      "import { CommandPalette } from './components/CommandPalette'",
      '',
      'export function App() {',
      '  return (',
      '    <main className="studio-shell">',
      '      <CommandPalette />',
      '    </main>',
      '  )',
      '}',
      ''
    ].join('\n')
  )
  writeFile(
    root,
    'src/components/CommandPalette.tsx',
    [
      'export function CommandPalette() {',
      '  return <section className="command-palette">Northstar Studio</section>',
      '}',
      ''
    ].join('\n')
  )
  writeFile(
    root,
    'src/styles.css',
    [':root { color-scheme: dark; }', 'body { margin: 0; background: #080b10; }', ''].join(
      '\n'
    )
  )
  writeFile(
    root,
    'tests/App.test.tsx',
    ["import { describe, it } from 'vitest'", '', "describe('app', () => {", "  it('renders', () => {})", '})', ''].join(
      '\n'
    )
  )
  writeFile(
    root,
    'README.md',
    [
      '# Northstar Studio',
      '',
      'A local-first desktop workspace for creative teams.',
      '',
      '## Commands',
      '',
      '```bash',
      'npm install',
      'npm run dev',
      'npm test',
      '```',
      ''
    ].join('\n')
  )
  writeFile(root, '.git/HEAD', 'ref: refs/heads/main\n')

  openProject(root)
  return root
}

export function prepareModelShowcase(baseUrl = 'http://127.0.0.1:4545/v1'): {
  root: string
  providerId: string
} {
  const root = prepareShowcaseProject()
  const providerResult = createProvider({
    type: 'custom',
    name: 'Local Model Lab',
    baseUrl
  })
  const providerId = providerResult.provider.id
  const fast = addModel({
    providerId,
    modelId: 'northstar-fast',
    displayName: 'Northstar Fast',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.6
  })
  const vision = addModel({
    providerId,
    modelId: 'northstar-vision',
    displayName: 'Northstar Vision',
    contextWindow: 256000,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsVision: true,
    inputPricePerMillion: 0.4,
    outputPricePerMillion: 1.6
  })
  const team = getCurrentTeamConfig()
  if (team) {
    team.agents.forEach((agent, index) => {
      const model = index % 2 === 0 ? fast.model : vision.model
      setAgentModel({
        agentId: agent.id,
        modelRecordId: model.id,
        temperature: index % 2 === 0 ? 0.2 : 0.4
      })
    })
  }
  return { root, providerId }
}

export function cleanupMcpShowcase(serverId: string): void {
  try {
    removeMcpServer(serverId)
  } catch {
    // The server may already be gone during cleanup.
  }
}

export function cleanupModelShowcase(providerId: string, root: string): void {
  try {
    deleteProvider(providerId)
  } catch {
    return
  }
  removeRecentProject(root)
}

function fakeChatSender(events: ChatEvent[]): WebContents {
  return {
    isDestroyed: () => false,
    send: (_channel: string, event: ChatEvent) => {
      events.push(event)
    }
  } as unknown as WebContents
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForChatRun(events: ChatEvent[], runId: string): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 20_000) {
    const terminal = events.find(
      (event) =>
        event.runId === runId &&
        (event.type === 'done' || event.type === 'error' || event.type === 'cancelled')
    )
    if (terminal) {
      if (terminal.type !== 'done') {
        throw new Error(
          terminal.type === 'error'
            ? terminal.message
            : 'The chat showcase run was cancelled'
        )
      }
      return
    }
    await delay(50)
  }
  throw new Error('Timed out preparing the chat showcase')
}

function fakeBuildSender(
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

async function waitForApprovalEvent(
  events: ApprovalEvent[]
): Promise<ApprovalEvent> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 20_000) {
    const event = events.find((entry) => entry.type === 'request')
    if (event) {
      return event
    }
    await delay(50)
  }
  throw new Error('Timed out preparing the approval showcase')
}

export async function prepareBuildShowcase(baseUrl: string): Promise<{
  root: string
  providerId: string
  sessionId: string
}> {
  const root = prepareShowcaseProject()
  const providerResult = createProvider({
    type: 'custom',
    name: 'Studio Tools',
    baseUrl
  })
  const providerId = providerResult.provider.id
  const model = addModel({
    providerId,
    modelId: 'phase4-chat',
    displayName: 'Northstar Build',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    inputPricePerMillion: 0.2,
    outputPricePerMillion: 0.8
  })
  const team = getCurrentTeamConfig()
  if (team) {
    for (const agent of team.agents) {
      setAgentModel({
        agentId: agent.id,
        modelRecordId: model.model.id,
        temperature: 0.2
      })
    }
  }

  const session = createSessionForAgent('coordinator', 'build')
  const chatEvents: ChatEvent[] = []
  const approvalEvents: ApprovalEvent[] = []
  const { runId } = startChatRun(
    fakeBuildSender(chatEvents, approvalEvents, true),
    {
      sessionId: session.session.id,
      agentId: 'coordinator',
      text: 'Implement the Phase 4 showcase change and run the check.',
      attachmentIds: [],
      mode: 'build'
    }
  )
  await waitForChatRun(chatEvents, runId)
  fs.rmSync(path.resolve(root, PHASE4_OUTSIDE_FILE), { force: true })
  getChatSession(session.session.id, false)
  return { root, providerId, sessionId: session.session.id }
}

export async function prepareApprovalShowcase(baseUrl: string): Promise<{
  root: string
  providerId: string
  sessionId: string
}> {
  const root = prepareShowcaseProject()
  const providerResult = createProvider({
    type: 'custom',
    name: 'Studio Tools',
    baseUrl
  })
  const providerId = providerResult.provider.id
  const model = addModel({
    providerId,
    modelId: 'phase4-chat',
    displayName: 'Northstar Build',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    inputPricePerMillion: 0.2,
    outputPricePerMillion: 0.8
  })
  const team = getCurrentTeamConfig()
  if (team) {
    for (const agent of team.agents) {
      setAgentModel({
        agentId: agent.id,
        modelRecordId: model.model.id,
        temperature: 0.2
      })
    }
  }

  updateCurrentTeam((currentTeam) => ({
    ...currentTeam,
    agents: currentTeam.agents.map((agent) =>
      agent.id === 'coordinator'
        ? {
            ...agent,
            permissions: {
              ...agent.permissions,
              writeGlobs: [...agent.permissions.writeGlobs, 'src/**']
            }
          }
        : agent
    )
  }))

  const session = createSessionForAgent('coordinator', 'build')
  const chatEvents: ChatEvent[] = []
  const approvalEvents: ApprovalEvent[] = []
  startChatRun(fakeBuildSender(chatEvents, approvalEvents, false), {
    sessionId: session.session.id,
    agentId: 'coordinator',
    text: 'Implement the Phase 4 showcase change and run the check.',
    attachmentIds: [],
    mode: 'build'
  })
  await waitForApprovalEvent(approvalEvents)
  getChatSession(session.session.id, false)
  return { root, providerId, sessionId: session.session.id }
}

export async function prepareChatShowcase(baseUrl: string): Promise<{
  root: string
  providerId: string
  sessionId: string
}> {
  const root = prepareShowcaseProject()
  const providerResult = createProvider({
    type: 'custom',
    name: 'Studio Mock',
    baseUrl
  })
  const providerId = providerResult.provider.id
  const model = addModel({
    providerId,
    modelId: 'northstar-chat',
    displayName: 'Northstar Chat',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsVision: true,
    inputPricePerMillion: 0.2,
    outputPricePerMillion: 0.8
  })
  const team = getCurrentTeamConfig()
  if (team) {
    for (const agent of team.agents) {
      setAgentModel({
        agentId: agent.id,
        modelRecordId: model.model.id,
        temperature: agent.roleKey === 'qa' ? 0.15 : 0.3
      })
    }
  }

  const iconPath = path.join(process.cwd(), 'build', 'icon.png')
  const attachmentBuffer = fs.existsSync(iconPath)
    ? fs.readFileSync(iconPath)
    : Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==',
        'base64'
      )
  const attachment = createImageAttachmentFromBuffer({
    buffer: attachmentBuffer,
    originalName: 'northstar-mark.png'
  })

  const session = createSessionForAgent('coordinator')
  const events: ChatEvent[] = []
  const { runId } = startChatRun(fakeChatSender(events), {
    sessionId: session.session.id,
    agentId: 'coordinator',
    text: 'Give me a short architecture readout of this project and point to the files you checked.',
    attachmentIds: [attachment.id],
    mode: 'plan'
  })
  await waitForChatRun(events, runId)
  getChatSession(session.session.id, false)
  return { root, providerId, sessionId: session.session.id }
}

function fakeMeetingSender(events: MeetingEvent[]): WebContents {
  return {
    isDestroyed: () => false,
    send: (_channel: string, event: MeetingEvent) => {
      events.push(event)
    }
  } as unknown as WebContents
}

function fakeBuildMeetingSender(
  events: MeetingEvent[],
  approvals: ApprovalEvent[]
): WebContents {
  return {
    isDestroyed: () => false,
    send: (channel: string, event: MeetingEvent | ApprovalEvent) => {
      if (channel === IPC_CHANNELS.meetingEvent) {
        events.push(event as MeetingEvent)
        return
      }
      if (channel !== IPC_CHANNELS.approvalEvent) {
        return
      }
      const approvalEvent = event as ApprovalEvent
      approvals.push(approvalEvent)
      if (approvalEvent.type === 'request') {
        decideApproval({
          approvalId: approvalEvent.approval.id,
          decision: 'once'
        })
      }
    }
  } as unknown as WebContents
}

async function waitForMeetingRun(
  events: MeetingEvent[],
  meetingId: string
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 30_000) {
    const terminal = events.find(
      (event) =>
        'meetingId' in event &&
        event.meetingId === meetingId &&
        (event.type === 'done' || event.type === 'cancelled' || event.type === 'error')
    )
    if (terminal) {
      if (terminal.type !== 'done') {
        throw new Error(
          terminal.type === 'error'
            ? terminal.message
            : 'The meeting showcase was cancelled'
        )
      }
      return
    }
    await delay(50)
  }
  throw new Error('Timed out preparing the meeting showcase')
}

export async function prepareMeetingShowcase(baseUrl: string): Promise<{
  root: string
  providerId: string
  meetingId: string
}> {
  const root = prepareShowcaseProject()
  const providerResult = createProvider({
    type: 'custom',
    name: 'Plan Room Lab',
    baseUrl
  })
  const providerId = providerResult.provider.id
  const model = addModel({
    providerId,
    modelId: 'phase6-chat',
    displayName: 'Plan Room Model',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsTools: true,
    supportsVision: false,
    inputPricePerMillion: 0.2,
    outputPricePerMillion: 0.8
  })
  const team = getCurrentTeamConfig()
  if (team) {
    for (const agent of team.agents) {
      setAgentModel({
        agentId: agent.id,
        modelRecordId: model.model.id,
        temperature: 0.2
      })
    }
  }

  const meeting = createMeeting({
    goal: 'Plan a focused first-run onboarding slice with clear ownership and a QA gate.',
    agentIds: ['frontend', 'backend', 'database', 'qa', 'devops'],
    mode: 'plan'
  })
  const events: MeetingEvent[] = []
  startMeeting(fakeMeetingSender(events), meeting.meeting.id)
  await waitForMeetingRun(events, meeting.meeting.id)
  approveMeetingPlan(meeting.meeting.id)
  return { root, providerId, meetingId: meeting.meeting.id }
}

export async function prepareBuildRoomShowcase(input: {
  planBaseUrl: string
  buildBaseUrl: string
}): Promise<{
  root: string
  providerId: string
  planMeetingId: string
  buildMeetingId: string
}> {
  const root = prepareShowcaseProject()
  const providerResult = createProvider({
    type: 'custom',
    name: 'Build Room Lab',
    baseUrl: input.planBaseUrl
  })
  const providerId = providerResult.provider.id
  const model = addModel({
    providerId,
    modelId: 'phase6-chat',
    displayName: 'Build Room Model',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsTools: true,
    supportsVision: false,
    inputPricePerMillion: 0.2,
    outputPricePerMillion: 0.8
  })
  const team = getCurrentTeamConfig()
  if (team) {
    for (const agent of team.agents) {
      setAgentModel({
        agentId: agent.id,
        modelRecordId: model.model.id,
        temperature: 0.2
      })
    }
  }

  const plan = createMeeting({
    goal: 'Ship a focused first-run onboarding slice with a QA gate.',
    agentIds: ['frontend', 'backend', 'database', 'qa', 'devops'],
    mode: 'plan'
  })
  const planEvents: MeetingEvent[] = []
  startMeeting(fakeMeetingSender(planEvents), plan.meeting.id)
  await waitForMeetingRun(planEvents, plan.meeting.id)
  approveMeetingPlan(plan.meeting.id)

  updateProvider({
    id: providerId,
    baseUrl: input.buildBaseUrl
  })

  const build = createBuildMeeting({ planMeetingId: plan.meeting.id })
  const buildEvents: MeetingEvent[] = []
  const buildApprovals: ApprovalEvent[] = []
  startMeeting(fakeBuildMeetingSender(buildEvents, buildApprovals), build.meeting.id)
  await waitForMeetingRun(buildEvents, build.meeting.id)
  return {
    root,
    providerId,
    planMeetingId: plan.meeting.id,
    buildMeetingId: build.meeting.id
  }
}

export async function prepareMcpShowcase(): Promise<{
  root: string
  serverId: string
}> {
  const root = prepareShowcaseProject()
  const scriptPath = writePhase8StdioServer(root)
  const view = await addMcpServer({
    name: 'Workspace Tools',
    transport: 'stdio',
    command: 'node',
    args: [scriptPath],
    env: { MOCK_TOKEN: 'showcase-secret' }
  })
  const echo = view.tools.find((tool) => tool.name === 'echo')
  const remove = view.tools.find((tool) => tool.name === 'delete_thing')
  const probe = view.tools.find((tool) => tool.name === 'env_probe')
  setMcpProjectConfig({
    enabledServerIds: [view.server.id],
    toolPolicies: {
      ...(echo ? { [echo.namespacedName]: 'allow' as const } : {}),
      ...(remove ? { [remove.namespacedName]: 'ask' as const } : {}),
      ...(probe ? { [probe.namespacedName]: 'ask' as const } : {})
    }
  })
  return { root, serverId: view.server.id }
}

export async function sendChatFromUi(window: BrowserWindow): Promise<boolean> {
  if (window.webContents.isLoading()) {
    await new Promise<void>((resolve) => {
      window.webContents.once('did-finish-load', () => resolve())
    })
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 1600))
  const typed = await window.webContents.executeJavaScript(
    `(() => {
      const textarea = document.querySelector('.chat-composer-input')
      if (!textarea) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      if (!setter) return false
      setter.call(textarea, 'Stream one short confirmation that this conversation is live, then stop.')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.focus()
      return true
    })()`
  )
  await new Promise<void>((resolve) => setTimeout(resolve, 300))
  const clicked = await window.webContents.executeJavaScript(
    "(() => { const button = document.querySelector('.chat-composer-right .btn-primary'); if (button) { button.click(); return true } return false })()"
  )
  console.log('SCREENSHOT_CHAT_SEND', { typed, clicked })
  return Boolean(typed && clicked)
}

export async function openChatContextInspector(window: BrowserWindow): Promise<void> {
  if (window.webContents.isLoading()) {
    await new Promise<void>((resolve) => {
      window.webContents.once('did-finish-load', () => resolve())
    })
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 1200))
  const opened = await window.webContents.executeJavaScript(
    "(() => { const button = document.querySelector('.message-context-button'); if (button) { button.click(); return true } return false })()"
  )
  console.log('SCREENSHOT_CONTEXT_OPENED', opened)
  await new Promise<void>((resolve) => setTimeout(resolve, 500))
}

export async function openChangesDialog(window: BrowserWindow): Promise<void> {
  if (window.webContents.isLoading()) {
    await new Promise<void>((resolve) => {
      window.webContents.once('did-finish-load', () => resolve())
    })
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 1400))
  const opened = await window.webContents.executeJavaScript(
    "(() => { const button = document.querySelector('.changes-button'); if (button) { button.click(); return true } return false })()"
  )
  console.log('SCREENSHOT_CHANGES_OPENED', opened)
  await new Promise<void>((resolve) => setTimeout(resolve, 600))
}

export async function captureWindow(
  window: BrowserWindow,
  fileName: string,
  scrollSelector?: string,
  scrollToTop = false
): Promise<string> {
  if (window.webContents.isLoading()) {
    await new Promise<void>((resolve) => {
      window.webContents.once('did-finish-load', () => resolve())
    })
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 1400))
  if (scrollSelector) {
    await window.webContents.executeJavaScript(
      `(() => { const element = document.querySelector(${JSON.stringify(scrollSelector)}); if (!element) return false; element.scrollTop = ${
        scrollToTop ? '0' : 'element.scrollHeight'
      }; return true })()`
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 450))
  }
  const image = await window.webContents.capturePage()
  const target = path.join(getAppPaths().tmpDir, fileName)
  fs.writeFileSync(target, image.toPNG())
  return target
}

export async function openSettingsTab(
  window: BrowserWindow,
  tab: 'Providers' | 'Team' | 'MCP' | 'Memory'
): Promise<void> {
  if (window.webContents.isLoading()) {
    await new Promise<void>((resolve) => {
      window.webContents.once('did-finish-load', () => resolve())
    })
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 1200))
  const opened = await window.webContents.executeJavaScript(
    `(() => { const button = document.querySelector('[aria-label="Open settings"]'); if (button) { button.click(); return true } return false })()`
  )
  await new Promise<void>((resolve) => setTimeout(resolve, 400))
  const selected = await window.webContents.executeJavaScript(
    `(() => { const tab = [...document.querySelectorAll('.modal-tab')].find((element) => element.textContent?.trim() === ${JSON.stringify(tab)}); if (tab) { tab.click(); return true } return false })()`
  )
  console.log('SCREENSHOT_SETTINGS_TAB', { opened, selected })
  await new Promise<void>((resolve) => setTimeout(resolve, 500))
}






