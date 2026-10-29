import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { OpenDialogOptions, WebContents } from 'electron'
import { z } from 'zod'
import {
  IPC_CHANNELS,
  type AgentModelSelection,
  type AgentCreateInput,
  type AgentRosterPatch,
  type ApprovalDecisionInput,
  type ApprovalRequest,
  type AppInfo,
  type AppSettings,
  type AppUpdateInfo,
  type ChatAttachment,
  type DataStats,
  type DiagnosticsBundle,
  type ExportRequest,
  type ExportResult,
  type MaintenanceResult,
  type RecoveryReport,
  type ResetRequest,
  type ResetResult,
  type SettingsPreferencesPatch,
  type UsageSummary,
  type ChatSendRequest,
  type ChatSessionDetail,
  type ChatSessionSummary,
  type ChangeRecord,
  type DiscoveryResult,
  type IpcResult,
  type MemoryBundle,
  type MemoryEntry,
  type MemoryPinInput,
  type MeetingBuildCreateRequest,
  type MeetingCreateRequest,
  type MeetingDetail,
  type MeetingDirectMessageRequest,
  type MeetingInterruptRequest,
  type MeetingQuestion,
  type MeetingSummary,
  type McpCallAudit,
  type McpProjectConfig,
  type McpServerDraft,
  type McpServerPatch,
  type McpServerView,
  type ModelMutationResult,
  type ModelTestRequest,
  type ProjectEntry,
  type ProjectInfo,
  type ProviderMutationResult,
  type SettingsWithProjectResult,
  type TeamConfig,
  type TeamMutationResult,
  type RevertChangeResult,
  type RevertTaskChangesInput,
  type RevertTaskChangesResult
} from '@shared/types'
import { getAppPaths } from '../config/appPaths'
import { createLogger } from '../config/logger'
import {
  loadSettings,
  removeRecentProject,
  updateSettings,
  updateSettingsPreferences
} from '../config/settings'
import { AppError, toIpcError } from '../errors'
import {
  closeProject,
  getCurrentProject,
  listProjectDirectory,
  openProject
} from '../project/projectService'
import { cancelModelTest, startModelTest } from '../providers/modelTestService'
import {
  addModel,
  clearProviderKey,
  createProvider,
  deleteModel,
  deleteProvider,
  discoverProviderModels,
  setProviderKey,
  updateModel,
  updateProvider
} from '../providers/providerService'
import {
  addAgent,
  deleteAgent,
  getTeam,
  setAgentModel,
  updateAgent
} from '../project/teamService'
import { pickChatImages } from '../chat/attachments'
import {
  cancelAllChatRuns,
  cancelChatRun,
  createSessionForAgent,
  setSessionMode,
  startChatRun
} from '../chat/chatService'
import {
  getChatSession,
  listChatSessions
} from '../chat/sessionService'
import {
  decideApproval,
  listPendingApprovals
} from '../approvals/approvalService'
import { listChanges, revertChange, revertTaskChanges } from '../changes/changeService'
import {
  deleteMemory,
  listMemory,
  toggleMemoryPin
} from '../memory/memoryService'
import { killAllManagedProcesses } from '../commands/commandRunner'
import {
  approveMeetingPlan,
  cancelAllMeetings,
  createBuildMeeting,
  answerQuestion,
  createMeeting,
  deleteMeeting,
  getMeeting,
  listMeetings,
  renameMeeting,
  markMeetingStopped,
  pauseMeeting,
  queueMeetingInterrupt,
  resumeMeeting,
  sendDirectMeetingMessage,
  startMeeting,
  stopMeeting
} from '../meetings/meetingService'
import {
  addServer as addMcpServer,
  callAudit as listMcpCalls,
  discoverServerTools,
  getServerLogs,
  listServers as listMcpServers,
  removeServer as deleteMcpServer,
  restartMcpServer,
  setProjectConfig as setMcpProjectConfig,
  testServer as testMcpServer,
  updateServer as updateMcpServer,
  warmProjectMcp
} from '../mcp/mcpService'
import {
  checkForUpdates,
  dismissUpdate,
  openUpdateDownload
} from '../updates/updateService'
import {
  backupNow,
  dataStats,
  pruneData,
  restoreBackup,
  vacuumDatabase
} from '../db/maintenanceService'
import {
  buildDiagnostics,
  exportDiagnostics,
  exportProjectData,
  resetProjectData,
  usageSummary
} from '../data/dataService'
import {
  currentRecoveryReport,
  markRecoveredMeetingStopped,
  recoverProjectOnOpen
} from '../recovery/recoveryService'

const log = createLogger('ipc')

const pathArgument = z.object({
  path: z.string().min(1).max(32767)
})

const directoryArgument = z.object({
  path: z.string().max(32767)
})

const settingsPatchArgument = z
  .object({
    bossName: z.string().min(1).max(80).optional(),
    theme: z.enum(['dark', 'light', 'system']).optional()
  })
  .strict()

const settingsPreferencesArgument = z
  .object({
    retention: z
      .object({
        sessionDays: z.number().int().min(1).max(3650).optional(),
        meetingDays: z.number().int().min(1).max(3650).optional(),
        usageDays: z.number().int().min(1).max(3650).optional(),
        mcpAuditDays: z.number().int().min(1).max(3650).optional(),
        toolCallDays: z.number().int().min(1).max(3650).optional(),
        commandLogDays: z.number().int().min(1).max(3650).optional(),
        snapshotDays: z.number().int().min(1).max(3650).optional(),
        databaseBackups: z.number().int().min(1).max(50).optional()
      })
      .optional(),
    costControl: z
      .object({
        monthlyCapUsd: z.number().nonnegative().max(100_000).optional(),
        warnPercent: z.number().int().min(1).max(100).optional(),
        hardStop: z.boolean().optional()
      })
      .optional(),
    updates: z
      .object({
        dismissedVersion: z.string().max(40).nullable().optional(),
        lastCheckedAt: z.number().int().nonnegative().nullable().optional()
      })
      .optional(),
    clearRecovery: z.boolean().optional()
  })
  .strict() as z.ZodType<SettingsPreferencesPatch>

const providerTypeArgument = z.enum(['openai', 'google', 'ollama', 'custom'])

const idArgument = z.object({
  id: z.string().min(1).max(200)
})

const providerDraftArgument = z.object({
  type: providerTypeArgument,
  name: z.string().min(1).max(80),
  baseUrl: z.string().max(2048).optional(),
  apiKey: z.string().max(8192).optional(),
  enabled: z.boolean().optional()
})

const providerPatchArgument = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(80).optional(),
  baseUrl: z.string().max(2048).optional(),
  enabled: z.boolean().optional()
})

const providerKeyArgument = z.object({
  id: z.string().min(1).max(200),
  apiKey: z.string().min(1).max(8192)
})

const modelDraftArgument = z.object({
  providerId: z.string().min(1).max(200),
  modelId: z.string().min(1).max(200),
  displayName: z.string().max(120).optional(),
  contextWindow: z.number().positive().optional(),
  maxOutputTokens: z.number().positive().optional(),
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  inputPricePerMillion: z.number().nonnegative().optional(),
  outputPricePerMillion: z.number().nonnegative().optional()
})

const modelPatchArgument = z.object({
  id: z.string().min(1).max(200),
  displayName: z.string().max(120).optional(),
  contextWindow: z.number().positive().optional(),
  maxOutputTokens: z.number().positive().optional(),
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  inputPricePerMillion: z.number().nonnegative().optional(),
  outputPricePerMillion: z.number().nonnegative().optional()
})

const agentModelArgument = z.object({
  agentId: z.string().min(1).max(200),
  modelRecordId: z.string().min(1).max(200).nullable(),
  temperature: z.number().min(0).max(2).optional()
})

const modelTestArgument = z.object({
  providerId: z.string().min(1).max(200),
  modelId: z.string().min(1).max(200),
  prompt: z.string().max(4000)
})

const testIdArgument = z.object({
  testId: z.string().min(1).max(200)
})

const chatListArgument = z.object({
  agentId: z.string().min(1).max(200).optional()
})

const chatSessionArgument = z.object({
  sessionId: z.string().min(1).max(200)
})

const chatCreateArgument = z.object({
  agentId: z.string().min(1).max(200),
  mode: z.enum(['plan', 'build']).optional()
})

const chatSendArgument = z.object({
  sessionId: z.string().min(1).max(200).nullable(),
  agentId: z.string().min(1).max(200),
  text: z.string().max(20_000),
  attachmentIds: z.array(z.string().min(1).max(200)).max(4),
  mode: z.enum(['plan', 'build']).optional()
})

const chatModeArgument = z.object({
  sessionId: z.string().min(1).max(200),
  mode: z.enum(['plan', 'build'])
})

const chatRunArgument = z.object({
  runId: z.string().min(1).max(200)
})

const approvalDecisionArgument = z.object({
  approvalId: z.string().min(1).max(200),
  decision: z.enum(['deny', 'once', 'session', 'project']),
  note: z.string().max(2000).optional()
})

const changeSessionArgument = z.object({
  sessionId: z.string().min(1).max(200)
})

const changeIdArgument = z.object({
  changeId: z.string().min(1).max(200)
})

const memoryPinArgument = z.object({
  id: z.string().min(1).max(200),
  pinned: z.boolean()
})

const memoryIdArgument = z.object({
  id: z.string().min(1).max(200)
})

const agentPermissionsArgument = z.object({
  tools: z.array(z.string().min(1).max(80)).max(40),
  writeGlobs: z.array(z.string().max(512)).max(80),
  denyGlobs: z.array(z.string().max(512)).max(80)
})

const agentRosterPatchArgument = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(120).optional(),
  roleKey: z.string().min(1).max(80).optional(),
  tagline: z.string().max(300).optional(),
  color: z.string().max(20).optional(),
  enabled: z.boolean().optional(),
  promptAppend: z.string().max(20_000).optional(),
  permissions: agentPermissionsArgument.optional()
})

const agentCreateArgument = z.object({
  name: z.string().min(1).max(120),
  roleKey: z.string().max(80).optional(),
  tagline: z.string().max(300).optional(),
  color: z.string().max(20).optional(),
  promptAppend: z.string().max(20_000).optional(),
  permissions: agentPermissionsArgument.optional()
})

const meetingCreateArgument = z.object({
  goal: z.string().min(3).max(20_000),
  agentIds: z.array(z.string().min(1).max(200)).min(1).max(12),
  mode: z.enum(['plan', 'build']).optional()
})

const meetingIdArgument = z.object({
  meetingId: z.string().min(1).max(200)
})

const meetingRenameArgument = z.object({
  meetingId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(160)
})

const meetingQuestionAnswerArgument = z.object({
  meetingId: z.string().min(1).max(200),
  questionId: z.string().min(1).max(200),
  answer: z.string().trim().min(1).max(2000)
})

const meetingDirectArgument = z.object({
  meetingId: z.string().min(1).max(200),
  agentId: z.string().min(1).max(200),
  text: z.string().min(1).max(20_000)
})

const meetingBuildCreateArgument = z.object({
  planMeetingId: z.string().min(1).max(200)
})

const meetingInterruptArgument = z.object({
  meetingId: z.string().min(1).max(200),
  text: z.string().min(1).max(20_000),
  mode: z.enum(['queue', 'immediate'])
})

const revertTaskArgument = z.object({
  sessionId: z.string().min(1).max(200),
  taskId: z.string().min(1).max(200)
})

const mcpTransportArgument = z.enum(['stdio', 'http', 'sse'])
const mcpSecretMapArgument = z.record(z.string().max(200), z.string().max(8192))
const mcpDraftArgument = z.object({
  name: z.string().min(1).max(120),
  transport: mcpTransportArgument,
  command: z.string().max(2048).optional(),
  args: z.array(z.string().max(2048)).max(80).optional(),
  cwd: z.string().max(2048).optional(),
  url: z.string().max(4096).optional(),
  env: mcpSecretMapArgument.optional(),
  headers: mcpSecretMapArgument.optional(),
  enabled: z.boolean().optional()
})
const mcpPatchArgument = mcpDraftArgument.extend({
  id: z.string().min(1).max(200)
})
const mcpProjectConfigArgument = z.object({
  enabledServerIds: z.array(z.string().min(1).max(200)).max(50),
  toolPolicies: z.record(
    z.string().max(300),
    z.enum(['allow', 'ask', 'deny'])
  )
})
const mcpCallsArgument = z.object({
  serverId: z.string().min(1).max(200).optional()
})

const exportArgument = z.object({
  scope: z.enum(['project', 'meeting']),
  meetingId: z.string().min(1).max(200).optional(),
  includeAttachments: z.boolean()
}) as z.ZodType<ExportRequest>

const resetArgument = z.object({
  scope: z.enum(['personal_memory', 'shared_memory', 'session_memory', 'logs_cache']),
  agentId: z.string().min(1).max(200).optional(),
  sessionId: z.string().min(1).max(200).optional(),
  confirm: z.string().min(1).max(20)
}) as z.ZodType<ResetRequest>

async function chooseOutputDirectory(title: string): Promise<string | null> {
  const window = BrowserWindow.getFocusedWindow()
  const result = window
    ? await dialog.showOpenDialog(window, {
        title,
        buttonLabel: 'Use this folder',
        properties: ['openDirectory', 'createDirectory']
      })
    : await dialog.showOpenDialog({
        title,
        buttonLabel: 'Use this folder',
        properties: ['openDirectory', 'createDirectory']
      })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: toIpcError(error) }
}

function parseArgument<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new AppError(
      'INVALID_REQUEST',
      'The request payload is invalid.',
      result.error.issues.map((issue) => issue.message).join('; ')
    )
  }
  return result.data
}

function register<T>(channel: string, handler: (...args: unknown[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      return ok(await handler(...args))
    } catch (error) {
      log.error('IPC handler failed', { channel, error })
      return fail(error)
    }
  })
}

function registerWithSender<T>(
  channel: string,
  handler: (sender: WebContents, ...args: unknown[]) => Promise<T> | T
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    try {
      return ok(await handler(event.sender, ...args))
    } catch (error) {
      log.error('IPC handler failed', { channel, error })
      return fail(error)
    }
  })
}

export function registerIpcHandlers(): void {
  register<AppInfo>(IPC_CHANNELS.appInfo, () => {
    const paths = getAppPaths()
    return {
      name: 'AgentDesk',
      version: app.getVersion(),
      platform: process.platform,
      isPackaged: app.isPackaged,
      dataDir: paths.appDataDir,
      logsDir: paths.logsDir,
      settingsPath: paths.settingsPath,
      mcpDir: paths.mcpDir,
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.versions.node
    }
  })

  register<null>(IPC_CHANNELS.appRevealData, async () => {
    const errorMessage = await shell.openPath(getAppPaths().appDataDir)
    if (errorMessage) {
      throw new AppError('OPEN_PATH_FAILED', errorMessage)
    }
    return null
  })

  register<AppSettings>(IPC_CHANNELS.settingsGet, () => loadSettings())

  register<AppSettings>(IPC_CHANNELS.settingsUpdate, (rawPatch) => {
    const patch = parseArgument(settingsPatchArgument, rawPatch)
    return updateSettings(patch)
  })

  register<AppSettings>(IPC_CHANNELS.settingsPreferences, (rawPatch) => {
    const patch = parseArgument(settingsPreferencesArgument, rawPatch)
    return updateSettingsPreferences(patch)
  })

  register<ProjectInfo | null>(IPC_CHANNELS.projectPick, async () => {
    const window = BrowserWindow.getFocusedWindow()
    const options: OpenDialogOptions = {
      title: 'Open project folder',
      buttonLabel: 'Open project',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    cancelAllChatRuns()
    cancelAllMeetings()
    killAllManagedProcesses()
    const project = openProject(result.filePaths[0])
    recoverProjectOnOpen()
    warmProjectMcp()
    return project
  })

  register<ProjectInfo>(IPC_CHANNELS.projectOpenRecent, (rawArgument) => {
    const argument = parseArgument(pathArgument, rawArgument)
    cancelAllChatRuns()
    cancelAllMeetings()
    killAllManagedProcesses()
    const project = openProject(argument.path)
    recoverProjectOnOpen()
    warmProjectMcp()
    return project
  })

  register<ProjectInfo | null>(IPC_CHANNELS.projectCurrent, () => getCurrentProject())

  register<null>(IPC_CHANNELS.projectClose, () => {
    cancelAllChatRuns()
    cancelAllMeetings()
    killAllManagedProcesses()
    closeProject()
    return null
  })

  register<ProjectEntry[]>(IPC_CHANNELS.projectListDirectory, (rawArgument) => {
    const argument = parseArgument(directoryArgument, rawArgument)
    return listProjectDirectory(argument.path)
  })

  register<null>(IPC_CHANNELS.projectReveal, async () => {
    const project = getCurrentProject()
    if (!project) {
      throw new AppError('NO_PROJECT', 'No project is currently open.')
    }
    const errorMessage = await shell.openPath(project.path)
    if (errorMessage) {
      throw new AppError('OPEN_PATH_FAILED', errorMessage)
    }
    return null
  })

  register<AppSettings>(IPC_CHANNELS.projectRemoveRecent, (rawArgument) => {
    const argument = parseArgument(pathArgument, rawArgument)
    return removeRecentProject(argument.path)
  })

  register<ProviderMutationResult>(IPC_CHANNELS.providerCreate, (rawArgument) => {
    const draft = parseArgument(providerDraftArgument, rawArgument)
    return createProvider(draft)
  })

  register<ProviderMutationResult>(IPC_CHANNELS.providerUpdate, (rawArgument) => {
    const patch = parseArgument(providerPatchArgument, rawArgument)
    return updateProvider(patch)
  })

  register<SettingsWithProjectResult>(IPC_CHANNELS.providerDelete, (rawArgument) => {
    const argument = parseArgument(idArgument, rawArgument)
    return deleteProvider(argument.id)
  })

  register<ProviderMutationResult>(IPC_CHANNELS.providerSetKey, (rawArgument) => {
    const input = parseArgument(providerKeyArgument, rawArgument)
    return setProviderKey(input)
  })

  register<ProviderMutationResult>(IPC_CHANNELS.providerClearKey, (rawArgument) => {
    const argument = parseArgument(idArgument, rawArgument)
    return clearProviderKey(argument.id)
  })

  register<DiscoveryResult>(IPC_CHANNELS.providerDiscover, (rawArgument) => {
    const argument = parseArgument(idArgument, rawArgument)
    return discoverProviderModels(argument.id)
  })

  register<ModelMutationResult>(IPC_CHANNELS.modelAdd, (rawArgument) => {
    const draft = parseArgument(modelDraftArgument, rawArgument)
    return addModel(draft)
  })

  register<ModelMutationResult>(IPC_CHANNELS.modelUpdate, (rawArgument) => {
    const patch = parseArgument(modelPatchArgument, rawArgument)
    return updateModel(patch)
  })

  register<SettingsWithProjectResult>(IPC_CHANNELS.modelDelete, (rawArgument) => {
    const argument = parseArgument(idArgument, rawArgument)
    return deleteModel(argument.id)
  })

  register<TeamConfig | null>(IPC_CHANNELS.teamGet, () => getTeam())

  register<TeamMutationResult>(IPC_CHANNELS.teamSetAgentModel, (rawArgument) => {
    const selection = parseArgument(
      agentModelArgument,
      rawArgument
    ) as AgentModelSelection
    return setAgentModel(selection)
  })

  register<TeamMutationResult>(IPC_CHANNELS.teamUpdateAgent, (rawArgument) => {
    const patch = parseArgument(agentRosterPatchArgument, rawArgument) as AgentRosterPatch
    return updateAgent(patch)
  })

  register<TeamMutationResult>(IPC_CHANNELS.teamAddAgent, (rawArgument) => {
    const input = parseArgument(agentCreateArgument, rawArgument) as AgentCreateInput
    return addAgent(input)
  })

  register<TeamMutationResult>(IPC_CHANNELS.teamDeleteAgent, (rawArgument) => {
    const argument = parseArgument(idArgument, rawArgument)
    return deleteAgent(argument.id)
  })

  register<MeetingSummary[]>(IPC_CHANNELS.meetingList, () => listMeetings())

  register<MeetingDetail>(IPC_CHANNELS.meetingGet, (rawArgument) => {
    const argument = parseArgument(meetingIdArgument, rawArgument)
    return getMeeting(argument.meetingId)
  })

  register<MeetingSummary>(IPC_CHANNELS.meetingRename, (rawArgument) => {
    const argument = parseArgument(meetingRenameArgument, rawArgument)
    return renameMeeting(argument.meetingId, argument.title)
  })

  register<null>(IPC_CHANNELS.meetingDelete, (rawArgument) => {
    const argument = parseArgument(meetingIdArgument, rawArgument)
    deleteMeeting(argument.meetingId)
    return null
  })

  register<MeetingQuestion>(IPC_CHANNELS.meetingQuestionAnswer, (rawArgument) => {
    const argument = parseArgument(meetingQuestionAnswerArgument, rawArgument)
    return answerQuestion(argument)
  })

  register<MeetingDetail>(IPC_CHANNELS.meetingCreate, (rawArgument) => {
    const request = parseArgument(meetingCreateArgument, rawArgument) as MeetingCreateRequest
    return createMeeting(request)
  })

  register<MeetingDetail>(IPC_CHANNELS.meetingCreateBuild, (rawArgument) => {
    const request = parseArgument(
      meetingBuildCreateArgument,
      rawArgument
    ) as MeetingBuildCreateRequest
    return createBuildMeeting(request)
  })

  registerWithSender<MeetingSummary>(IPC_CHANNELS.meetingStart, (sender, rawArgument) => {
    const argument = parseArgument(meetingIdArgument, rawArgument)
    return startMeeting(sender, argument.meetingId)
  })

  registerWithSender<MeetingSummary>(
    IPC_CHANNELS.meetingInterrupt,
    (sender, rawArgument) => {
      const request = parseArgument(
        meetingInterruptArgument,
        rawArgument
      ) as MeetingInterruptRequest
      return queueMeetingInterrupt(sender, request)
    }
  )

  register<MeetingSummary>(IPC_CHANNELS.meetingStop, (rawArgument) => {
    const argument = parseArgument(meetingIdArgument, rawArgument)
    return stopMeeting(argument.meetingId)
  })

  register<MeetingSummary>(IPC_CHANNELS.meetingPause, (rawArgument) => {
    const argument = parseArgument(meetingIdArgument, rawArgument)
    return pauseMeeting(argument.meetingId)
  })

  registerWithSender<MeetingSummary>(IPC_CHANNELS.meetingDirect, (sender, rawArgument) => {
    const request = parseArgument(
      meetingDirectArgument,
      rawArgument
    ) as MeetingDirectMessageRequest
    return sendDirectMeetingMessage(sender, request)
  })

  register<MeetingDetail>(IPC_CHANNELS.meetingApprovePlan, (rawArgument) => {
    const argument = parseArgument(meetingIdArgument, rawArgument)
    return approveMeetingPlan(argument.meetingId)
  })

  registerWithSender<MeetingSummary>(IPC_CHANNELS.meetingResume, (sender, rawArgument) => {
    const argument = parseArgument(meetingIdArgument, rawArgument)
    return resumeMeeting(sender, argument.meetingId)
  })

  register<MeetingSummary>(IPC_CHANNELS.meetingMarkStopped, (rawArgument) => {
    const argument = parseArgument(meetingIdArgument, rawArgument)
    return markMeetingStopped(argument.meetingId)
  })

  registerWithSender<{ testId: string }>(IPC_CHANNELS.modelTestStart, (sender, rawArgument) => {
    const request = parseArgument(
      modelTestArgument,
      rawArgument
    ) as ModelTestRequest
    return startModelTest(sender, request)
  })

  register<null>(IPC_CHANNELS.modelTestCancel, (rawArgument) => {
    const argument = parseArgument(testIdArgument, rawArgument)
    cancelModelTest(argument.testId)
    return null
  })

  register<ChatSessionSummary[]>(IPC_CHANNELS.chatListSessions, (rawArgument) => {
    const argument = parseArgument(chatListArgument, rawArgument)
    return listChatSessions(argument.agentId)
  })

  register<ChatSessionDetail>(IPC_CHANNELS.chatGetSession, (rawArgument) => {
    const argument = parseArgument(chatSessionArgument, rawArgument)
    return getChatSession(argument.sessionId)
  })

  register<ChatSessionDetail>(IPC_CHANNELS.chatCreateSession, (rawArgument) => {
    const argument = parseArgument(chatCreateArgument, rawArgument)
    return createSessionForAgent(argument.agentId, argument.mode)
  })

  registerWithSender<{ runId: string; sessionId: string }>(
    IPC_CHANNELS.chatSend,
    (sender, rawArgument) => {
      const request = parseArgument(chatSendArgument, rawArgument) as ChatSendRequest
      return startChatRun(sender, request)
    }
  )

  register<null>(IPC_CHANNELS.chatCancel, (rawArgument) => {
    const argument = parseArgument(chatRunArgument, rawArgument)
    cancelChatRun(argument.runId)
    return null
  })

  register<ChatAttachment[]>(IPC_CHANNELS.chatPickImages, () => pickChatImages())

  register<ChatSessionDetail>(IPC_CHANNELS.chatSetMode, (rawArgument) => {
    const argument = parseArgument(chatModeArgument, rawArgument)
    return setSessionMode(argument.sessionId, argument.mode)
  })

  register<ApprovalRequest[]>(IPC_CHANNELS.approvalList, () => listPendingApprovals())

  register<ApprovalRequest>(IPC_CHANNELS.approvalDecide, (rawArgument) => {
    const input = parseArgument(
      approvalDecisionArgument,
      rawArgument
    ) as ApprovalDecisionInput
    return decideApproval(input)
  })

  register<ChangeRecord[]>(IPC_CHANNELS.changesList, (rawArgument) => {
    const argument = parseArgument(changeSessionArgument, rawArgument)
    return listChanges(argument.sessionId)
  })

  register<RevertChangeResult>(IPC_CHANNELS.changesRevert, (rawArgument) => {
    const argument = parseArgument(changeIdArgument, rawArgument)
    return revertChange(argument.changeId)
  })

  register<RevertTaskChangesResult>(IPC_CHANNELS.changesRevertTask, (rawArgument) => {
    const argument = parseArgument(revertTaskArgument, rawArgument) as RevertTaskChangesInput
    return revertTaskChanges(argument.sessionId, argument.taskId)
  })

  register<McpServerView[]>(IPC_CHANNELS.mcpList, () => listMcpServers())

  register<McpServerView>(IPC_CHANNELS.mcpAdd, (rawArgument) => {
    const draft = parseArgument(mcpDraftArgument, rawArgument) as McpServerDraft
    return addMcpServer(draft)
  })

  register<McpServerView>(IPC_CHANNELS.mcpUpdate, (rawArgument) => {
    const patch = parseArgument(mcpPatchArgument, rawArgument) as McpServerPatch
    return updateMcpServer(patch)
  })

  register<{ servers: McpServerView[] }>(IPC_CHANNELS.mcpDelete, (rawArgument) => {
    const argument = parseArgument(idArgument, rawArgument)
    return deleteMcpServer(argument.id)
  })

  register<McpServerView>(IPC_CHANNELS.mcpTest, (rawArgument) => {
    const argument = parseArgument(idArgument, rawArgument)
    return testMcpServer(argument.id)
  })

  register<McpServerView>(IPC_CHANNELS.mcpDiscover, (rawArgument) => {
    const argument = parseArgument(idArgument, rawArgument)
    return discoverServerTools(argument.id)
  })

  register<McpServerView>(IPC_CHANNELS.mcpRestart, (rawArgument) => {
    const argument = parseArgument(idArgument, rawArgument)
    return restartMcpServer(argument.id)
  })

  register<string>(IPC_CHANNELS.mcpLogs, (rawArgument) => {
    const argument = parseArgument(idArgument, rawArgument)
    return getServerLogs(argument.id)
  })

  register<TeamMutationResult>(IPC_CHANNELS.mcpSetProjectConfig, (rawArgument) => {
    const config = parseArgument(
      mcpProjectConfigArgument,
      rawArgument
    ) as McpProjectConfig
    return setMcpProjectConfig(config)
  })

  register<McpCallAudit[]>(IPC_CHANNELS.mcpCalls, (rawArgument) => {
    const argument = parseArgument(mcpCallsArgument, rawArgument)
    return listMcpCalls(argument.serverId)
  })

  register<AppUpdateInfo>(IPC_CHANNELS.updateCheck, async () => {
    return checkForUpdates(true)
  })

  register<null>(IPC_CHANNELS.updateOpen, async (rawArgument) => {
    const argument = parseArgument(
      z.object({ url: z.string().url().max(4096) }),
      rawArgument
    )
    await openUpdateDownload(argument.url)
    return null
  })

  register<AppSettings>(IPC_CHANNELS.updateDismiss, (rawArgument) => {
    const argument = parseArgument(
      z.object({ version: z.string().min(1).max(40) }),
      rawArgument
    )
    return dismissUpdate(argument.version)
  })

  register<RecoveryReport>(IPC_CHANNELS.recoveryReport, () => currentRecoveryReport())

  register<RecoveryReport>(IPC_CHANNELS.recoveryMarkStopped, (rawArgument) => {
    const argument = parseArgument(meetingIdArgument, rawArgument)
    markMeetingStopped(argument.meetingId)
    return markRecoveredMeetingStopped(argument.meetingId)
  })

  register<DataStats>(IPC_CHANNELS.dataStats, () => dataStats())

  register<MaintenanceResult>(IPC_CHANNELS.dataBackup, () => backupNow('manual'))

  register<MaintenanceResult>(IPC_CHANNELS.dataRestore, () => restoreBackup())

  register<MaintenanceResult>(IPC_CHANNELS.dataPrune, () => pruneData())
  register<MaintenanceResult>(IPC_CHANNELS.dataVacuum, () => vacuumDatabase())

  register<ExportResult | null>(IPC_CHANNELS.dataExport, async (rawArgument) => {
    const request = parseArgument(exportArgument, rawArgument)
    const directory = await chooseOutputDirectory('Choose where to export AgentDesk data')
    if (!directory) {
      return null
    }
    return exportProjectData(request, directory)
  })

  register<ResetResult>(IPC_CHANNELS.dataReset, (rawArgument) => {
    const request = parseArgument(resetArgument, rawArgument)
    return resetProjectData(request)
  })

  register<DiagnosticsBundle>(IPC_CHANNELS.diagnosticsGet, () => buildDiagnostics())

  register<ExportResult | null>(IPC_CHANNELS.diagnosticsExport, async () => {
    const directory = await chooseOutputDirectory('Choose where to save diagnostics')
    if (!directory) {
      return null
    }
    return exportDiagnostics(directory)
  })

  register<UsageSummary>(IPC_CHANNELS.usageSummary, () => usageSummary())

  register<MemoryBundle>(IPC_CHANNELS.memoryList, () => listMemory())

  register<MemoryEntry>(IPC_CHANNELS.memoryPin, (rawArgument) => {
    const input = parseArgument(memoryPinArgument, rawArgument) as MemoryPinInput
    return toggleMemoryPin(input.id, input.pinned)
  })

  register<null>(IPC_CHANNELS.memoryDelete, (rawArgument) => {
    const argument = parseArgument(memoryIdArgument, rawArgument)
    deleteMemory(argument.id)
    return null
  })

  log.info('IPC handlers registered')
}





