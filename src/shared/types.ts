export const APP_NAME = 'AgentDesk'
export const PROJECT_DATA_DIR = '.agentdesk'
export const APP_SCHEMA_VERSION = 1

export const IPC_CHANNELS = {
  appInfo: 'app:info',
  appRevealData: 'app:reveal-data',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  projectPick: 'project:pick',
  projectOpenRecent: 'project:open-recent',
  projectCurrent: 'project:current',
  projectClose: 'project:close',
  projectListDirectory: 'project:list-directory',
  projectReveal: 'project:reveal',
  projectRemoveRecent: 'project:remove-recent',
  providerCreate: 'provider:create',
  providerUpdate: 'provider:update',
  providerDelete: 'provider:delete',
  providerSetKey: 'provider:set-key',
  providerClearKey: 'provider:clear-key',
  providerDiscover: 'provider:discover',
  modelAdd: 'model:add',
  modelUpdate: 'model:update',
  modelDelete: 'model:delete',
  teamGet: 'team:get',
  teamSetAgentModel: 'team:set-agent-model',
  teamUpdateAgent: 'team:update-agent',
  teamAddAgent: 'team:add-agent',
  teamDeleteAgent: 'team:delete-agent',
  modelTestStart: 'model:test-start',
  modelTestCancel: 'model:test-cancel',
  modelTestEvent: 'model:test-event',
  chatListSessions: 'chat:list-sessions',
  chatGetSession: 'chat:get-session',
  chatCreateSession: 'chat:create-session',
  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatPickImages: 'chat:pick-images',
  chatSetMode: 'chat:set-mode',
  chatEvent: 'chat:event',
  approvalList: 'approval:list',
  approvalDecide: 'approval:decide',
  approvalEvent: 'approval:event',
  changesList: 'changes:list',
  changesRevert: 'changes:revert',
  changesRevertTask: 'changes:revert-task',
  memoryList: 'memory:list',
  memoryPin: 'memory:pin',
  memoryDelete: 'memory:delete',
  meetingList: 'meeting:list',
  meetingGet: 'meeting:get',
  meetingCreate: 'meeting:create',
  meetingCreateBuild: 'meeting:create-build',
  meetingStart: 'meeting:start',
  meetingStop: 'meeting:stop',
  meetingPause: 'meeting:pause',
  meetingInterrupt: 'meeting:interrupt',
  meetingDirect: 'meeting:direct',
  meetingApprovePlan: 'meeting:approve-plan',
  meetingEvent: 'meeting:event',
  mcpList: 'mcp:list',
  mcpAdd: 'mcp:add',
  mcpUpdate: 'mcp:update',
  mcpDelete: 'mcp:delete',
  mcpTest: 'mcp:test',
  mcpDiscover: 'mcp:discover',
  mcpRestart: 'mcp:restart',
  mcpLogs: 'mcp:logs',
  mcpSetProjectConfig: 'mcp:set-project-config',
  mcpCalls: 'mcp:calls',
  updateCheck: 'update:check',
  updateOpen: 'update:open',
  updateEvent: 'update:event'
} as const

export type ThemePreference = 'dark' | 'light' | 'system'
export type ProviderType = 'openai' | 'google' | 'ollama' | 'custom'
export type AgentModelRef = {
  providerType: ProviderType
  providerConfigId: string
  modelId: string
  fallbackModelId?: string
  temperature: number
}

export type AgentPermissions = {
  writeGlobs: string[]
  denyGlobs: string[]
  tools: string[]
}

export type AgentConfig = {
  id: string
  name: string
  roleKey: string
  tagline: string
  color: string
  enabled: boolean
  promptAppend: string
  model: AgentModelRef | null
  permissions: AgentPermissions
}

export type OrchestrationDefaults = {
  maxRounds: number
  maxTurns: number
  maxMessages: number
  maxMinutes: number
  maxTokens: number
  maxCostUsd: number
  maxToolStepsPerTurn: number
  maxReviewCycles: number
}

export type ProjectPermissionDefaults = {
  autoWriteInsideRepo: boolean
  autoShellInsideRepo: boolean
  askOutsideRepo: boolean
  askInstall: boolean
  askNetwork: boolean
  askDeploy: boolean
}

export type McpTransport = 'stdio' | 'http' | 'sse'
export type McpToolPolicy = 'allow' | 'ask' | 'deny'
export type McpServerState = 'stopped' | 'starting' | 'ready' | 'error'

export type McpSecretRef = {
  key: string
  secretKey: string
}

export type McpServerConfig = {
  id: string
  name: string
  transport: McpTransport
  enabled: boolean
  command: string
  args: string[]
  cwd: string
  url: string
  env: McpSecretRef[]
  headers: McpSecretRef[]
  createdAt: number
  updatedAt: number
}

export type McpToolAnnotations = {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export type McpToolInfo = {
  serverId: string
  serverName: string
  name: string
  namespacedName: string
  description: string
  inputSchema: unknown
  annotations: McpToolAnnotations
  policy: McpToolPolicy
  destructive: boolean
  readOnly: boolean
}

export type McpServerStatus = {
  state: McpServerState
  toolCount: number
  lastError: string | null
  pid?: number
  startedAt?: number
  lastCheckedAt?: number
}

export type McpServerView = {
  server: McpServerConfig
  status: McpServerStatus
  tools: McpToolInfo[]
  envKeys: string[]
  headerNames: string[]
}

export type McpServerDraft = {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  enabled?: boolean
}

export type McpServerPatch = McpServerDraft & {
  id: string
}

export type McpProjectConfig = {
  enabledServerIds: string[]
  toolPolicies: Record<string, McpToolPolicy>
}

export type McpCallAudit = {
  id: string
  serverId: string
  serverName: string
  toolName: string
  agentId: string | null
  sessionId: string | null
  meetingId: string | null
  status: string
  durationMs: number | null
  summary: string | null
  error: string | null
  createdAt: number
}

export type AppUpdateInfo = {
  currentVersion: string
  latestVersion: string | null
  available: boolean
  releaseName: string | null
  releaseUrl: string | null
  downloadUrl: string | null
  publishedAt: string | null
  checkedAt: number
  error?: string
}

export type TeamConfig = {
  schemaVersion: number
  boss: {
    name: string
    preferences: string
  }
  agents: AgentConfig[]
  orchestration: OrchestrationDefaults
  permissions: ProjectPermissionDefaults
  mcp: McpProjectConfig
}

export type ProviderConfig = {
  id: string
  type: ProviderType
  name: string
  baseUrl: string
  enabled: boolean
  hasKey: boolean
  createdAt: number
  updatedAt: number
}

export type ModelRecord = {
  id: string
  providerId: string
  modelId: string
  displayName: string
  contextWindow?: number
  maxOutputTokens?: number
  supportsTools: boolean
  supportsVision: boolean
  inputPricePerMillion?: number
  outputPricePerMillion?: number
  source: 'discovered' | 'manual'
  createdAt: number
  updatedAt: number
  lastSeenAt?: number
}

export type ProviderDraft = {
  type: ProviderType
  name: string
  baseUrl?: string
  apiKey?: string
  enabled?: boolean
}

export type ProviderPatch = {
  id: string
  name?: string
  baseUrl?: string
  enabled?: boolean
}

export type ProviderKeyInput = {
  id: string
  apiKey: string
}

export type ModelDraft = {
  providerId: string
  modelId: string
  displayName?: string
  contextWindow?: number
  maxOutputTokens?: number
  supportsTools?: boolean
  supportsVision?: boolean
  inputPricePerMillion?: number
  outputPricePerMillion?: number
}

export type ModelPatch = {
  id: string
  displayName?: string
  contextWindow?: number
  maxOutputTokens?: number
  supportsTools?: boolean
  supportsVision?: boolean
  inputPricePerMillion?: number
  outputPricePerMillion?: number
}

export type ProviderMutationResult = {
  settings: AppSettings
  provider: ProviderConfig
}

export type ModelMutationResult = {
  settings: AppSettings
  model: ModelRecord
}

export type DiscoveryResult = {
  settings: AppSettings
  providerId: string
  discovered: number
  added: number
  updated: number
}

export type TeamMutationResult = {
  team: TeamConfig
  project: ProjectInfo
}

export type AgentModelSelection = {
  agentId: string
  modelRecordId: string | null
  temperature?: number
}

export type ModelTestRequest = {
  providerId: string
  modelId: string
  prompt: string
}

export type ModelTestEvent =
  | {
      testId: string
      type: 'start'
      providerName: string
      modelId: string
    }
  | {
      testId: string
      type: 'delta'
      text: string
    }
  | {
      testId: string
      type: 'done'
      text: string
      inputTokens?: number
      outputTokens?: number
      durationMs: number
    }
  | {
      testId: string
      type: 'error'
      message: string
    }
  | {
      testId: string
      type: 'cancelled'
    }

export type ChatMode = 'plan' | 'build'

export type ChatUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedTokens?: number
  costUsd?: number
}

export type ChatAttachment = {
  id: string
  name: string
  mime: string
  size: number
  width?: number
  height?: number
  dataUrl?: string
}

export type ChatToolTrace = {
  toolCallId: string
  toolName: string
  input: unknown
  output?: unknown
  status: 'running' | 'done' | 'error'
  durationMs?: number
  error?: string
}

export type ChatContextFile = {
  path: string
  content: string
  chars: number
  truncated: boolean
  exists: boolean
}

export type ChatContextHistoryItem = {
  role: 'user' | 'assistant'
  label: string
  text: string
  imageCount: number
  toolNames: string[]
}

export type ChatToolDefinition = {
  name: string
  description: string
}

export type ChatModelInfo = {
  providerId: string
  providerName: string
  providerType: ProviderType
  modelId: string
  displayName: string
  temperature: number
  supportsTools: boolean
  supportsVision: boolean
  contextWindow?: number
  maxOutputTokens?: number
}

export type ChatContextSnapshot = {
  mode: ChatMode
  system: string
  contextFiles: ChatContextFile[]
  history: ChatContextHistoryItem[]
  tools: ChatToolDefinition[]
  model: ChatModelInfo
  warnings: string[]
  memory: MemoryPromptContext
  usage?: ChatUsage
  durationMs?: number
  estimatedPromptTokens: number
  historyOmitted: number
}

export type ChatMessageMetadata = {
  context?: ChatContextSnapshot
  toolCalls?: ChatToolTrace[]
  modelMessages?: unknown
  usage?: ChatUsage
  durationMs?: number
  status?: 'streaming' | 'done' | 'cancelled' | 'error'
  error?: string
  cancelled?: boolean
}

export type ChatMessage = {
  id: string
  sessionId: string
  seq: number
  role: 'user' | 'assistant'
  senderName: string
  content: string
  createdAt: number
  attachments: ChatAttachment[]
  metadata?: ChatMessageMetadata
}

export type ChatSessionSummary = {
  id: string
  agentId: string
  title: string
  mode: ChatMode
  status: string
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
  messageCount: number
  preview: string | null
}

export type ChatSessionDetail = {
  session: ChatSessionSummary
  messages: ChatMessage[]
}

export type ChatSendRequest = {
  sessionId: string | null
  agentId: string
  text: string
  attachmentIds: string[]
  mode?: ChatMode
}

export type ChatSendResult = {
  runId: string
  sessionId: string
}

export type ChatEvent =
  | {
      runId: string
      type: 'start'
      agentId: string
      session: ChatSessionSummary
      userMessage: ChatMessage
      assistantMessage: ChatMessage
    }
  | {
      runId: string
      type: 'delta'
      text: string
    }
  | {
      runId: string
      type: 'tool'
      tool: ChatToolTrace
    }
  | {
      runId: string
      type: 'tool-result'
      tool: ChatToolTrace
    }
  | {
      runId: string
      type: 'tool-output'
      toolCallId: string
      stream: 'stdout' | 'stderr' | 'system'
      text: string
    }
  | {
      runId: string
      type: 'done'
      message: ChatMessage
      session: ChatSessionSummary
    }
  | {
      runId: string
      type: 'error'
      message: string
      assistantMessage?: ChatMessage
      session?: ChatSessionSummary
    }
  | {
      runId: string
      type: 'cancelled'
      message: ChatMessage
      session: ChatSessionSummary
    }

export type ApprovalActionType =
  | 'write_file'
  | 'patch_file'
  | 'delete_path'
  | 'move_path'
  | 'run_command'
  | 'mcp_call'

export type ApprovalRisk = 'low' | 'medium' | 'high'
export type ApprovalScope = 'once' | 'session' | 'project'
export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'cancelled'
  | 'expired'

export type ApprovalRequest = {
  id: string
  sessionId: string
  runId: string
  agentId: string
  actionType: ApprovalActionType
  actionKey: string
  risk: ApprovalRisk
  reason: string
  payload: Record<string, unknown>
  status: ApprovalStatus
  scope?: ApprovalScope
  createdAt: number
  decidedAt?: number
}

export type ApprovalDecisionInput = {
  approvalId: string
  decision: 'deny' | ApprovalScope
  note?: string
}

export type ApprovalEvent =
  | {
      type: 'request'
      approval: ApprovalRequest
    }
  | {
      type: 'resolved'
      approvalId: string
      status: ApprovalStatus
      scope?: ApprovalScope
    }

export type ChangeType =
  | 'write'
  | 'patch'
  | 'delete'
  | 'move'
  | 'revert'
  | 'command'

export type ChangeRecord = {
  id: string
  sessionId: string
  meetingId?: string | null
  taskId?: string | null
  turnId?: string | null
  agentId: string | null
  type: ChangeType
  path: string | null
  command: string | null
  exitCode: number | null
  beforeHash: string | null
  afterHash: string | null
  snapshotId: string | null
  metadata?: unknown
  createdAt: number
  canRevert: boolean
}

export type RevertChangeResult = {
  change: ChangeRecord
  changes: ChangeRecord[]
}

export type RevertTaskChangesInput = {
  sessionId: string
  taskId: string
}

export type RevertTaskChangesResult = {
  reverted: number
  changes: ChangeRecord[]
}

export type MemoryScope = 'personal' | 'shared'
export type MemoryKind =
  | 'turn_report'
  | 'project_update'
  | 'decision'
  | 'commitment'
  | 'blocker'
  | 'note'
  | 'summary'

export type MemoryEntry = {
  id: string
  agentId: string | null
  scope: MemoryScope
  kind: MemoryKind
  sessionId: string | null
  title: string
  content: string
  tags: unknown
  importance: number
  pinned: boolean
  status: string
  createdAt: number
  updatedAt: number
  lastAccessedAt?: number
}

export type MemorySummary = {
  id: string
  agentId: string | null
  scope: string
  level: string
  sessionId: string | null
  content: string
  version: number
  updatedAt: number
}

export type MemoryBundle = {
  entries: MemoryEntry[]
  summaries: MemorySummary[]
}

export type MemoryPinInput = {
  id: string
  pinned: boolean
}

export type MemoryPromptEntry = {
  id: string
  scope: MemoryScope
  kind: MemoryKind
  title: string
  content: string
  pinned: boolean
  score: number
}

export type MemoryPromptSummary = {
  scope: string
  level: string
  content: string
}

export type MemoryPromptContext = {
  entries: MemoryPromptEntry[]
  summaries: MemoryPromptSummary[]
}

export type AgentRosterPatch = {
  id: string
  name?: string
  roleKey?: string
  tagline?: string
  color?: string
  enabled?: boolean
  promptAppend?: string
  permissions?: AgentPermissions
}

export type AgentCreateInput = {
  name: string
  roleKey?: string
  tagline?: string
  color?: string
  promptAppend?: string
  permissions?: AgentPermissions
}

export type MeetingMode = 'plan' | 'build'
export type MeetingStatus =
  | 'draft'
  | 'intake'
  | 'discussion'
  | 'planning'
  | 'building'
  | 'reviewing'
  | 'reporting'
  | 'completed'
  | 'stopped'
  | 'failed'
export type MeetingPhase =
  | 'boss'
  | 'intake'
  | 'discussion'
  | 'planning'
  | 'build'
  | 'review'
  | 'report'
  | 'interrupt'
  | 'direct'
  | 'system'
export type MeetingStopReason =
  | 'completed'
  | 'approved'
  | 'user'
  | 'paused'
  | 'budget'
  | 'no-progress'
  | 'repetition'
  | 'blocked'
  | 'error'
export type MeetingTaskStatus =
  | 'proposed'
  | 'queued'
  | 'in_progress'
  | 'review'
  | 'changes_requested'
  | 'done'
  | 'blocked'

export type MeetingBudget = {
  maxRounds: number
  maxTurns: number
  maxMessages: number
  maxMinutes: number
  maxTokens: number
  maxCostUsd: number
  maxToolStepsPerTurn: number
  maxReviewCycles: number
}

export type MeetingUsage = {
  rounds: number
  turns: number
  messages: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  elapsedMs: number
}

export type MeetingParticipant = {
  agentId: string
  name: string
  roleKey: string
  tagline: string
  color: string
  modelLabel: string | null
}

export type MeetingIntakeCard = {
  understanding: string
  concerns: string[]
  files: string[]
  risks: string[]
  approach: string
}

export type MeetingMessageMetadata = {
  phase: MeetingPhase
  round: number
  turnId?: string
  status?: 'streaming' | 'done' | 'error' | 'cancelled'
  usage?: ChatUsage
  durationMs?: number
  toolCalls?: ChatToolTrace[]
  card?: MeetingIntakeCard
  error?: string
}

export type MeetingMessage = {
  id: string
  meetingId: string
  seq: number
  senderType: 'boss' | 'agent' | 'system'
  senderAgentId: string | null
  senderName: string
  targetAgentId: string | null
  kind: string
  content: string
  metadata?: MeetingMessageMetadata
  createdAt: number
}

export type MeetingTask = {
  id: string
  meetingId: string
  title: string
  description: string
  status: MeetingTaskStatus
  priority: number
  assigneeAgentId: string | null
  createdBy: string
  acceptanceCriteria: string | null
  fileGlobs: string[]
  dependsOn: string[]
  reviewCycles: number
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export type MeetingTaskEvent = {
  id: string
  taskId: string
  meetingId: string
  agentId: string | null
  type: string
  fromStatus: MeetingTaskStatus | null
  toStatus: MeetingTaskStatus | null
  note: string | null
  createdAt: number
}

export type MeetingDecision = {
  id: string
  meetingId: string
  title: string
  context: string | null
  decision: string
  rationale: string | null
  status: string
  proposedByAgentId: string | null
  createdAt: number
  updatedAt: number
}

export type MeetingFileClaim = {
  id: string
  meetingId: string
  taskId: string | null
  agentId: string
  pathPrefix: string
  scope: string
  status: string
  claimedAt: number
}

export type MeetingPlanTask = {
  title: string
  description: string
  assigneeAgentId: string
  acceptanceCriteria: string
  fileGlobs: string[]
  dependsOn: string[]
  priority: number
}

export type MeetingPlanDecision = {
  title: string
  context: string
  decision: string
  rationale: string
}

export type MeetingPlanFileClaim = {
  agentId: string
  pathPrefix: string
  scope: string
}

export type MeetingPlan = {
  summary: string
  approach: string
  tasks: MeetingPlanTask[]
  decisions: MeetingPlanDecision[]
  fileClaims: MeetingPlanFileClaim[]
  risks: string[]
  acceptanceCriteria: string[]
  generatedAt: number
  fallback: boolean
}

export type MeetingReportFile = {
  path: string
  type: string
  agentId: string | null
  taskId: string | null
  canRevert: boolean
}

export type MeetingReportCommand = {
  command: string
  exitCode: number | null
  agentId: string | null
  taskId: string | null
}

export type MeetingReportApproval = {
  id: string
  agentId: string
  actionType: string
  status: string
  risk: string
  reason: string
  scope: string | null
  createdAt: number
}

export type MeetingReportTask = {
  id: string
  title: string
  status: MeetingTaskStatus
  assigneeAgentId: string | null
  reviewCycles: number
  acceptanceCriteria: string | null
}

export type MeetingFinalReport = {
  summary: string
  filesChanged: MeetingReportFile[]
  commands: MeetingReportCommand[]
  tests: string[]
  approvals: MeetingReportApproval[]
  decisions: string[]
  unresolved: string[]
  revertInstructions: string[]
  tasks: MeetingReportTask[]
  generatedAt: number
  partial: boolean
}

export type MeetingSummary = {
  id: string
  sessionId: string
  title: string
  mode: MeetingMode
  goal: string
  status: MeetingStatus
  stopReason: MeetingStopReason | null
  coordinatorAgentId: string
  parentMeetingId: string | null
  createdAt: number
  updatedAt: number
  startedAt: number | null
  endedAt: number | null
  budget: MeetingBudget
  usage: MeetingUsage
  participants: MeetingParticipant[]
  messageCount: number
  taskCount: number
  decisionCount: number
  claimCount: number
  planApprovedAt: number | null
  error: string | null
}

export type MeetingDetail = {
  meeting: MeetingSummary
  messages: MeetingMessage[]
  tasks: MeetingTask[]
  decisions: MeetingDecision[]
  fileClaims: MeetingFileClaim[]
  activity: MeetingTaskEvent[]
  plan: MeetingPlan | null
  finalReport: MeetingFinalReport | null
}

export type MeetingCreateRequest = {
  goal: string
  agentIds: string[]
  mode?: MeetingMode
}

export type MeetingDirectMessageRequest = {
  meetingId: string
  agentId: string
  text: string
}

export type MeetingBuildCreateRequest = {
  planMeetingId: string
}

export type MeetingInterruptRequest = {
  meetingId: string
  text: string
  mode: 'queue' | 'immediate'
}

export type MeetingEvent =
  | {
      type: 'meeting-start'
      meeting: MeetingSummary
    }
  | {
      type: 'turn-start'
      meetingId: string
      turnId: string
      message: MeetingMessage
      meeting: MeetingSummary
    }
  | {
      type: 'delta'
      meetingId: string
      turnId: string
      text: string
    }
  | {
      type: 'message'
      meetingId: string
      message: MeetingMessage
      meeting: MeetingSummary
    }
  | {
      type: 'meeting-update'
      meeting: MeetingSummary
    }
  | {
      type: 'plan'
      meetingId: string
      plan: MeetingPlan
      meeting: MeetingSummary
    }
  | {
      type: 'task'
      meetingId: string
      task: MeetingTask
      meeting: MeetingSummary
    }
  | {
      type: 'tool-output'
      meetingId: string
      turnId: string
      toolCallId: string
      stream: 'stdout' | 'stderr' | 'system'
      text: string
    }
  | {
      type: 'report'
      meetingId: string
      report: MeetingFinalReport
      meeting: MeetingSummary
    }
  | {
      type: 'done'
      meetingId: string
      meeting: MeetingDetail
    }
  | {
      type: 'cancelled'
      meetingId: string
      meeting: MeetingDetail
    }
  | {
      type: 'error'
      meetingId: string
      message: string
      meeting: MeetingDetail | null
    }

export type RecentProject = {
  id: string
  name: string
  path: string
  lastOpenedAt: number
}

export type WindowState = {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

export type AppSettings = {
  schemaVersion: number
  bossName: string
  theme: ThemePreference
  recentProjects: RecentProject[]
  window: WindowState
  providers: ProviderConfig[]
  models: ModelRecord[]
  createdAt: number
  updatedAt: number
}

export type SettingsPatch = {
  bossName?: string
  theme?: ThemePreference
}

export type AppInfo = {
  name: string
  version: string
  platform: string
  isPackaged: boolean
  dataDir: string
  logsDir: string
  settingsPath: string
  mcpDir: string
  electronVersion: string
  nodeVersion: string
}

export type ProjectDetection = {
  stacks: string[]
  packageManager: string | null
  scripts: Record<string, string>
  commands: {
    install?: string
    build?: string
    test?: string
    lint?: string
    dev?: string
  }
  entryPoints: string[]
  gitBranch: string | null
  fileCount: number
  notes: string[]
}

export type AgentSummary = {
  id: string
  name: string
  roleKey: string
  tagline: string
  color: string
  enabled: boolean
  model: AgentModelRef | null
  modelLabel: string | null
}

export type ProjectInfo = {
  id: string
  name: string
  path: string
  dataDir: string
  dbPath: string
  openedAt: number
  detection: ProjectDetection
  agents: AgentSummary[]
  teamPath: string
}

export type ProjectEntry = {
  name: string
  relativePath: string
  type: 'file' | 'dir'
  size: number | null
}

export type SettingsWithProjectResult = {
  settings: AppSettings
  project: ProjectInfo | null
}

export type IpcErrorPayload = {
  code: string
  message: string
  details?: string
}

export type IpcResult<T> =
  | {
      ok: true
      data: T
    }
  | {
      ok: false
      error: IpcErrorPayload
    }

export type AgentDeskApi = {
  getAppInfo: () => Promise<IpcResult<AppInfo>>
  revealDataFolder: () => Promise<IpcResult<null>>
  getSettings: () => Promise<IpcResult<AppSettings>>
  updateSettings: (patch: SettingsPatch) => Promise<IpcResult<AppSettings>>
  pickProject: () => Promise<IpcResult<ProjectInfo | null>>
  openRecentProject: (path: string) => Promise<IpcResult<ProjectInfo>>
  getCurrentProject: () => Promise<IpcResult<ProjectInfo | null>>
  closeProject: () => Promise<IpcResult<null>>
  listProjectDirectory: (relativePath: string) => Promise<IpcResult<ProjectEntry[]>>
  revealProjectFolder: () => Promise<IpcResult<null>>
  removeRecentProject: (path: string) => Promise<IpcResult<AppSettings>>
  createProvider: (draft: ProviderDraft) => Promise<IpcResult<ProviderMutationResult>>
  updateProvider: (patch: ProviderPatch) => Promise<IpcResult<ProviderMutationResult>>
  deleteProvider: (id: string) => Promise<IpcResult<SettingsWithProjectResult>>
  setProviderKey: (input: ProviderKeyInput) => Promise<IpcResult<ProviderMutationResult>>
  clearProviderKey: (id: string) => Promise<IpcResult<ProviderMutationResult>>
  discoverProviderModels: (id: string) => Promise<IpcResult<DiscoveryResult>>
  addModel: (draft: ModelDraft) => Promise<IpcResult<ModelMutationResult>>
  updateModel: (patch: ModelPatch) => Promise<IpcResult<ModelMutationResult>>
  deleteModel: (id: string) => Promise<IpcResult<SettingsWithProjectResult>>
  getTeam: () => Promise<IpcResult<TeamConfig | null>>
  setAgentModel: (selection: AgentModelSelection) => Promise<IpcResult<TeamMutationResult>>
  updateAgent: (patch: AgentRosterPatch) => Promise<IpcResult<TeamMutationResult>>
  addAgent: (input: AgentCreateInput) => Promise<IpcResult<TeamMutationResult>>
  deleteAgent: (agentId: string) => Promise<IpcResult<TeamMutationResult>>
  startModelTest: (request: ModelTestRequest) => Promise<IpcResult<{ testId: string }>>
  cancelModelTest: (testId: string) => Promise<IpcResult<null>>
  onModelTestEvent: (listener: (event: ModelTestEvent) => void) => () => void
  listChatSessions: (agentId?: string) => Promise<IpcResult<ChatSessionSummary[]>>
  getChatSession: (sessionId: string) => Promise<IpcResult<ChatSessionDetail>>
  createChatSession: (
    agentId: string,
    mode?: ChatMode
  ) => Promise<IpcResult<ChatSessionDetail>>
  sendChatMessage: (request: ChatSendRequest) => Promise<IpcResult<ChatSendResult>>
  cancelChatRun: (runId: string) => Promise<IpcResult<null>>
  pickChatImages: () => Promise<IpcResult<ChatAttachment[]>>
  setChatMode: (sessionId: string, mode: ChatMode) => Promise<IpcResult<ChatSessionDetail>>
  onChatEvent: (listener: (event: ChatEvent) => void) => () => void
  listApprovals: () => Promise<IpcResult<ApprovalRequest[]>>
  decideApproval: (input: ApprovalDecisionInput) => Promise<IpcResult<ApprovalRequest>>
  onApprovalEvent: (listener: (event: ApprovalEvent) => void) => () => void
  listChanges: (sessionId: string) => Promise<IpcResult<ChangeRecord[]>>
  revertChange: (changeId: string) => Promise<IpcResult<RevertChangeResult>>
  revertTaskChanges: (
    input: RevertTaskChangesInput
  ) => Promise<IpcResult<RevertTaskChangesResult>>
  listMemory: () => Promise<IpcResult<MemoryBundle>>
  setMemoryPinned: (input: MemoryPinInput) => Promise<IpcResult<MemoryEntry>>
  deleteMemory: (id: string) => Promise<IpcResult<null>>
  listMeetings: () => Promise<IpcResult<MeetingSummary[]>>
  getMeeting: (meetingId: string) => Promise<IpcResult<MeetingDetail>>
  createMeeting: (request: MeetingCreateRequest) => Promise<IpcResult<MeetingDetail>>
  createBuildMeeting: (
    request: MeetingBuildCreateRequest
  ) => Promise<IpcResult<MeetingDetail>>
  startMeeting: (meetingId: string) => Promise<IpcResult<MeetingSummary>>
  stopMeeting: (meetingId: string) => Promise<IpcResult<MeetingSummary>>
  pauseMeeting: (meetingId: string) => Promise<IpcResult<MeetingSummary>>
  queueMeetingInterrupt: (
    request: MeetingInterruptRequest
  ) => Promise<IpcResult<MeetingSummary>>
  sendMeetingDirectMessage: (
    request: MeetingDirectMessageRequest
  ) => Promise<IpcResult<MeetingSummary>>
  approveMeetingPlan: (meetingId: string) => Promise<IpcResult<MeetingDetail>>
  onMeetingEvent: (listener: (event: MeetingEvent) => void) => () => void
  listMcpServers: () => Promise<IpcResult<McpServerView[]>>
  addMcpServer: (draft: McpServerDraft) => Promise<IpcResult<McpServerView>>
  updateMcpServer: (patch: McpServerPatch) => Promise<IpcResult<McpServerView>>
  deleteMcpServer: (id: string) => Promise<IpcResult<{ servers: McpServerView[] }>>
  testMcpServer: (id: string) => Promise<IpcResult<McpServerView>>
  discoverMcpTools: (id: string) => Promise<IpcResult<McpServerView>>
  restartMcpServer: (id: string) => Promise<IpcResult<McpServerView>>
  getMcpLogs: (id: string) => Promise<IpcResult<string>>
  setMcpProjectConfig: (
    config: McpProjectConfig
  ) => Promise<IpcResult<TeamMutationResult>>
  listMcpCalls: (serverId?: string) => Promise<IpcResult<McpCallAudit[]>>
  checkForUpdates: () => Promise<IpcResult<AppUpdateInfo>>
  openUpdateDownload: (url: string) => Promise<IpcResult<null>>
  onUpdateEvent: (listener: (event: AppUpdateInfo) => void) => () => void
}




