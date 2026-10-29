import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import {
  IPC_CHANNELS,
  type AgentDeskApi,
  type AppInfo,
  type AppSettings,
  type AppUpdateInfo,
  type AgentCreateInput,
  type AgentModelSelection,
  type AgentRosterPatch,
  type ApprovalDecisionInput,
  type ApprovalEvent,
  type ApprovalRequest,
  type ChatAttachment,
  type ChatEvent,
  type ChatSendRequest,
  type ChatSessionDetail,
  type ChatSessionSummary,
  type ChatMode,
  type ChangeRecord,
  type DataStats,
  type DiagnosticsBundle,
  type DiscoveryResult,
  type ExportRequest,
  type ExportResult,
  type IpcResult,
  type MaintenanceResult,
  type RecoveryReport,
  type ResetRequest,
  type ResetResult,
  type SettingsPreferencesPatch,
  type UsageSummary,
  type MemoryBundle,
  type MemoryEntry,
  type MemoryPinInput,
  type MeetingBuildCreateRequest,
  type MeetingCreateRequest,
  type MeetingDetail,
  type MeetingDirectMessageRequest,
  type MeetingEvent,
  type MeetingInterruptRequest,
  type MeetingQuestion,
  type MeetingQuestionAnswerRequest,
  type MeetingSummary,
  type McpCallAudit,
  type McpProjectConfig,
  type McpServerDraft,
  type McpServerPatch,
  type McpServerView,
  type ModelDraft,
  type ModelMutationResult,
  type ModelPatch,
  type ModelTestEvent,
  type ModelTestRequest,
  type ProjectEntry,
  type ProjectInfo,
  type ProviderDraft,
  type ProviderKeyInput,
  type ProviderMutationResult,
  type ProviderPatch,
  type SettingsPatch,
  type SettingsWithProjectResult,
  type TeamConfig,
  type TeamMutationResult,
  type RevertChangeResult,
  type RevertTaskChangesInput,
  type RevertTaskChangesResult
} from '@shared/types'

const api: AgentDeskApi = {
  getAppInfo: () =>
    ipcRenderer.invoke(IPC_CHANNELS.appInfo) as Promise<IpcResult<AppInfo>>,
  revealDataFolder: () =>
    ipcRenderer.invoke(IPC_CHANNELS.appRevealData) as Promise<IpcResult<null>>,
  getSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsGet) as Promise<IpcResult<AppSettings>>,
  updateSettings: (patch: SettingsPatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch) as Promise<
      IpcResult<AppSettings>
    >,
  updateSettingsPreferences: (patch: SettingsPreferencesPatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsPreferences, patch) as Promise<
      IpcResult<AppSettings>
    >,
  pickProject: () =>
    ipcRenderer.invoke(IPC_CHANNELS.projectPick) as Promise<
      IpcResult<ProjectInfo | null>
    >,
  openRecentProject: (projectPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.projectOpenRecent, {
      path: projectPath
    }) as Promise<IpcResult<ProjectInfo>>,
  getCurrentProject: () =>
    ipcRenderer.invoke(IPC_CHANNELS.projectCurrent) as Promise<
      IpcResult<ProjectInfo | null>
    >,
  closeProject: () =>
    ipcRenderer.invoke(IPC_CHANNELS.projectClose) as Promise<IpcResult<null>>,
  listProjectDirectory: (relativePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.projectListDirectory, {
      path: relativePath
    }) as Promise<IpcResult<ProjectEntry[]>>,
  revealProjectFolder: () =>
    ipcRenderer.invoke(IPC_CHANNELS.projectReveal) as Promise<IpcResult<null>>,
  removeRecentProject: (projectPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.projectRemoveRecent, {
      path: projectPath
    }) as Promise<IpcResult<AppSettings>>,
  createProvider: (draft: ProviderDraft) =>
    ipcRenderer.invoke(IPC_CHANNELS.providerCreate, draft) as Promise<
      IpcResult<ProviderMutationResult>
    >,
  updateProvider: (patch: ProviderPatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.providerUpdate, patch) as Promise<
      IpcResult<ProviderMutationResult>
    >,
  deleteProvider: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.providerDelete, { id }) as Promise<
      IpcResult<SettingsWithProjectResult>
    >,
  setProviderKey: (input: ProviderKeyInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.providerSetKey, input) as Promise<
      IpcResult<ProviderMutationResult>
    >,
  clearProviderKey: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.providerClearKey, { id }) as Promise<
      IpcResult<ProviderMutationResult>
    >,
  discoverProviderModels: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.providerDiscover, { id }) as Promise<
      IpcResult<DiscoveryResult>
    >,
  addModel: (draft: ModelDraft) =>
    ipcRenderer.invoke(IPC_CHANNELS.modelAdd, draft) as Promise<
      IpcResult<ModelMutationResult>
    >,
  updateModel: (patch: ModelPatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.modelUpdate, patch) as Promise<
      IpcResult<ModelMutationResult>
    >,
  deleteModel: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.modelDelete, { id }) as Promise<
      IpcResult<SettingsWithProjectResult>
    >,
  getTeam: () =>
    ipcRenderer.invoke(IPC_CHANNELS.teamGet) as Promise<
      IpcResult<TeamConfig | null>
    >,
  setAgentModel: (selection: AgentModelSelection) =>
    ipcRenderer.invoke(IPC_CHANNELS.teamSetAgentModel, selection) as Promise<
      IpcResult<TeamMutationResult>
    >,
  updateAgent: (patch: AgentRosterPatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.teamUpdateAgent, patch) as Promise<
      IpcResult<TeamMutationResult>
    >,
  addAgent: (input: AgentCreateInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.teamAddAgent, input) as Promise<
      IpcResult<TeamMutationResult>
    >,
  deleteAgent: (agentId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.teamDeleteAgent, { id: agentId }) as Promise<
      IpcResult<TeamMutationResult>
    >,
  startModelTest: (request: ModelTestRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.modelTestStart, request) as Promise<
      IpcResult<{ testId: string }>
    >,
  cancelModelTest: (testId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.modelTestCancel, { testId }) as Promise<
      IpcResult<null>
    >,
  onModelTestEvent: (listener: (event: ModelTestEvent) => void) => {
    const handler = (_event: IpcRendererEvent, event: ModelTestEvent): void => {
      listener(event)
    }
    ipcRenderer.on(IPC_CHANNELS.modelTestEvent, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.modelTestEvent, handler)
    }
  },
  listChatSessions: (agentId?: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.chatListSessions,
      agentId ? { agentId } : {}
    ) as Promise<IpcResult<ChatSessionSummary[]>>,
  getChatSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.chatGetSession, { sessionId }) as Promise<
      IpcResult<ChatSessionDetail>
    >,
  createChatSession: (agentId: string, mode?: ChatMode) =>
    ipcRenderer.invoke(IPC_CHANNELS.chatCreateSession, { agentId, mode }) as Promise<
      IpcResult<ChatSessionDetail>
    >,
  sendChatMessage: (request: ChatSendRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.chatSend, request) as Promise<
      IpcResult<{ runId: string; sessionId: string }>
    >,
  cancelChatRun: (runId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.chatCancel, { runId }) as Promise<IpcResult<null>>,
  pickChatImages: () =>
    ipcRenderer.invoke(IPC_CHANNELS.chatPickImages) as Promise<
      IpcResult<ChatAttachment[]>
    >,
  setChatMode: (sessionId: string, mode: ChatMode) =>
    ipcRenderer.invoke(IPC_CHANNELS.chatSetMode, { sessionId, mode }) as Promise<
      IpcResult<ChatSessionDetail>
    >,
  listApprovals: () =>
    ipcRenderer.invoke(IPC_CHANNELS.approvalList) as Promise<
      IpcResult<ApprovalRequest[]>
    >,
  decideApproval: (input: ApprovalDecisionInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.approvalDecide, input) as Promise<
      IpcResult<ApprovalRequest>
    >,
  listChanges: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.changesList, { sessionId }) as Promise<
      IpcResult<ChangeRecord[]>
    >,
  revertChange: (changeId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.changesRevert, { changeId }) as Promise<
      IpcResult<RevertChangeResult>
    >,
  revertTaskChanges: (input: RevertTaskChangesInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.changesRevertTask, input) as Promise<
      IpcResult<RevertTaskChangesResult>
    >,
  listMemory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.memoryList) as Promise<IpcResult<MemoryBundle>>,
  setMemoryPinned: (input: MemoryPinInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.memoryPin, input) as Promise<IpcResult<MemoryEntry>>,
  deleteMemory: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.memoryDelete, { id }) as Promise<IpcResult<null>>,
  listMeetings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.meetingList) as Promise<IpcResult<MeetingSummary[]>>,
  getMeeting: (meetingId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.meetingGet, { meetingId }) as Promise<
      IpcResult<MeetingDetail>
    >,
  renameMeeting: (meetingId: string, title: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.meetingRename, { meetingId, title }) as Promise<
      IpcResult<MeetingSummary>
    >,
  deleteMeeting: (meetingId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.meetingDelete, { meetingId }) as Promise<IpcResult<null>>,
  answerMeetingQuestion: (input: MeetingQuestionAnswerRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.meetingQuestionAnswer, input) as Promise<
      IpcResult<MeetingQuestion>
    >,
  createMeeting: (request: MeetingCreateRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.meetingCreate, request) as Promise<
      IpcResult<MeetingDetail>
    >,
  createBuildMeeting: (request: MeetingBuildCreateRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.meetingCreateBuild, request) as Promise<
      IpcResult<MeetingDetail>
    >,
  startMeeting: (meetingId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.meetingStart, { meetingId }) as Promise<
      IpcResult<MeetingSummary>
    >,
  stopMeeting: (meetingId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.meetingStop, { meetingId }) as Promise<
      IpcResult<MeetingSummary>
    >,
  pauseMeeting: (meetingId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.meetingPause, { meetingId }) as Promise<
      IpcResult<MeetingSummary>
    >,
  queueMeetingInterrupt: (request: MeetingInterruptRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.meetingInterrupt, request) as Promise<
      IpcResult<MeetingSummary>
    >,
  sendMeetingDirectMessage: (request: MeetingDirectMessageRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.meetingDirect, request) as Promise<
      IpcResult<MeetingSummary>
    >,
  approveMeetingPlan: (meetingId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.meetingApprovePlan, { meetingId }) as Promise<
      IpcResult<MeetingDetail>
    >,
  resumeMeeting: (meetingId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.meetingResume, { meetingId }) as Promise<
      IpcResult<MeetingSummary>
    >,
  markMeetingStopped: (meetingId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.meetingMarkStopped, { meetingId }) as Promise<
      IpcResult<MeetingSummary>
    >,
  listMcpServers: () =>
    ipcRenderer.invoke(IPC_CHANNELS.mcpList) as Promise<IpcResult<McpServerView[]>>,
  addMcpServer: (draft: McpServerDraft) =>
    ipcRenderer.invoke(IPC_CHANNELS.mcpAdd, draft) as Promise<IpcResult<McpServerView>>,
  updateMcpServer: (patch: McpServerPatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.mcpUpdate, patch) as Promise<IpcResult<McpServerView>>,
  deleteMcpServer: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.mcpDelete, { id }) as Promise<
      IpcResult<{ servers: McpServerView[] }>
    >,
  testMcpServer: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.mcpTest, { id }) as Promise<IpcResult<McpServerView>>,
  discoverMcpTools: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.mcpDiscover, { id }) as Promise<IpcResult<McpServerView>>,
  restartMcpServer: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.mcpRestart, { id }) as Promise<IpcResult<McpServerView>>,
  getMcpLogs: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.mcpLogs, { id }) as Promise<IpcResult<string>>,
  setMcpProjectConfig: (config: McpProjectConfig) =>
    ipcRenderer.invoke(IPC_CHANNELS.mcpSetProjectConfig, config) as Promise<
      IpcResult<TeamMutationResult>
    >,
  listMcpCalls: (serverId?: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.mcpCalls,
      serverId ? { serverId } : {}
    ) as Promise<IpcResult<McpCallAudit[]>>,
  checkForUpdates: () =>
    ipcRenderer.invoke(IPC_CHANNELS.updateCheck) as Promise<IpcResult<AppUpdateInfo>>,
  openUpdateDownload: (url: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateOpen, { url }) as Promise<IpcResult<null>>,
  dismissUpdate: (version: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateDismiss, { version }) as Promise<
      IpcResult<AppSettings>
    >,
  getRecoveryReport: () =>
    ipcRenderer.invoke(IPC_CHANNELS.recoveryReport) as Promise<IpcResult<RecoveryReport>>,
  markRecoveryStopped: (meetingId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.recoveryMarkStopped, { meetingId }) as Promise<
      IpcResult<RecoveryReport>
    >,
  getDataStats: () =>
    ipcRenderer.invoke(IPC_CHANNELS.dataStats) as Promise<IpcResult<DataStats>>,
  backupData: () =>
    ipcRenderer.invoke(IPC_CHANNELS.dataBackup) as Promise<IpcResult<MaintenanceResult>>,
  restoreData: () =>
    ipcRenderer.invoke(IPC_CHANNELS.dataRestore) as Promise<IpcResult<MaintenanceResult>>,
  pruneData: () =>
    ipcRenderer.invoke(IPC_CHANNELS.dataPrune) as Promise<IpcResult<MaintenanceResult>>,
  vacuumData: () =>
    ipcRenderer.invoke(IPC_CHANNELS.dataVacuum) as Promise<IpcResult<MaintenanceResult>>,
  exportData: (request: ExportRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.dataExport, request) as Promise<
      IpcResult<ExportResult | null>
    >,
  resetData: (request: ResetRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.dataReset, request) as Promise<IpcResult<ResetResult>>,
  getDiagnostics: () =>
    ipcRenderer.invoke(IPC_CHANNELS.diagnosticsGet) as Promise<IpcResult<DiagnosticsBundle>>,
  exportDiagnostics: () =>
    ipcRenderer.invoke(IPC_CHANNELS.diagnosticsExport) as Promise<
      IpcResult<ExportResult | null>
    >,
  getUsageSummary: () =>
    ipcRenderer.invoke(IPC_CHANNELS.usageSummary) as Promise<IpcResult<UsageSummary>>,
  onUpdateEvent: (listener: (event: AppUpdateInfo) => void) => {
    const handler = (_event: IpcRendererEvent, event: AppUpdateInfo): void => {
      listener(event)
    }
    ipcRenderer.on(IPC_CHANNELS.updateEvent, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.updateEvent, handler)
    }
  },
  onMeetingEvent: (listener: (event: MeetingEvent) => void) => {
    const handler = (_event: IpcRendererEvent, event: MeetingEvent): void => {
      listener(event)
    }
    ipcRenderer.on(IPC_CHANNELS.meetingEvent, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.meetingEvent, handler)
    }
  },
  onApprovalEvent: (listener: (event: ApprovalEvent) => void) => {
    const handler = (_event: IpcRendererEvent, event: ApprovalEvent): void => {
      listener(event)
    }
    ipcRenderer.on(IPC_CHANNELS.approvalEvent, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.approvalEvent, handler)
    }
  },
  onChatEvent: (listener: (event: ChatEvent) => void) => {
    const handler = (_event: IpcRendererEvent, event: ChatEvent): void => {
      listener(event)
    }
    ipcRenderer.on(IPC_CHANNELS.chatEvent, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.chatEvent, handler)
    }
  }
}

contextBridge.exposeInMainWorld('agentdesk', api)


