import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { WebContents } from 'electron'
import {
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type ToolSet
} from 'ai'
import {
  IPC_CHANNELS,
  type AgentConfig,
  type ChatToolTrace,
  type ChatUsage,
  type MeetingCheckpoint,
  type MeetingEvent,
  type MeetingFinalReport,
  type MeetingMessage,
  type MeetingMessageMetadata,
  type MeetingPlan,
  type MeetingReportTask,
  type MeetingStatus,
  type MeetingSummary,
  type MeetingTask,
  type ModelRecord,
  type ProviderConfig
} from '@shared/types'
import { createLogger } from '../config/logger'
import { loadSettings } from '../config/settings'
import { AppError } from '../errors'
import {
  getCurrentProject,
  getCurrentProjectRoot,
  getCurrentTeamConfig
} from '../project/projectService'
import { createLanguageModel } from '../providers/modelGateway'
import { formatProviderError } from '../providers/providerErrors'
import { agentCanUseTools, compileBuildPrompt } from '../chat/promptCompiler'
import { createAgentTools, type AgentToolBundle } from '../chat/projectTools'
import { buildMcpToolBundle, mergeToolBundles } from '../mcp/mcpAgentTools'
import { retrieveMemoryContext, recordTurnMemories } from '../memory/memoryService'
import {
  requestApproval as requestBossApproval,
  cancelApprovalsForSession
} from '../approvals/approvalService'
import {
  hashBuffer,
  listChanges,
  recordChange,
  snapshotFile
} from '../changes/changeService'
import { ensureDir, writeFileAtomic } from '../utils/fs'
import { resolveWritableProjectPath } from '../chat/pathPolicy'
import { stopManagedProcess } from '../commands/commandRunner'
import {
  createRunLease,
  finishRunLease,
  heartbeatRunLease,
  meetingCheckpoint,
  resumableLease
} from '../recovery/runLeaseService'
import {
  activeMeetingClaims,
  appendMeetingMessage,
  approvalSummaryForSession,
  assertTaskWriteAllowed,
  beginMeetingMessage,
  clearMeetingFinalReport,
  coordinatorAgent,
  createRequestTask,
  createTaskClaims,
  findClaimConflict,
  getMeetingDetail,
  listAgentTodos,
  listMeetingTasks,
  markMeetingDeliveriesProcessed,
  meetingParticipants,
  meetingSessionId,
  meetingSummary,
  meetingTask,
  meetingTitle,
  recordMeetingTurn,
  recordMeetingUsage,
  releaseAllActiveClaims,
  releaseTasksWaitingOn,
  releaseTaskClaims,
  replaceAgentTodos,
  setMeetingBuildState,
  setMeetingFinalReport,
  setMeetingStatus,
  setTaskWaiting,
  transitionMeetingTask,
  updateMeetingMessage,
  updateMeetingUsage
} from './meetingStore'

const log = createLogger('build')

type ActiveBuild = {
  controller: AbortController
  sender: WebContents
  stopReason: 'user' | 'paused' | null
}

const activeBuilds = new Map<string, ActiveBuild>()

type BuildContext = {
  meetingId: string
  sessionId: string
  goal: string
  sender: WebContents
  controller: AbortController
  budget: MeetingSummary['budget']
  startedAt: number
  usage: MeetingSummary['usage']
  plan: MeetingPlan | null
  tasks: MeetingTask[]
  reviewResults: Array<{
    taskId: string
    taskTitle: string
    status: 'approved' | 'changes_requested'
    summary: string
    issues: string[]
    testsRun: string[]
    testsPassed: boolean
  }>
  processIds: Set<string>
  stopSignalReason: () => 'user' | 'paused'
  leaseId: string
  checkpoint: MeetingCheckpoint
  agentLocks: Map<string, Promise<void>>
}

function defaultCheckpoint(): MeetingCheckpoint {
  return {
    phase: 'build',
    round: 0,
    completedIntakeAgentIds: [],
    completedDiscussionAgentIds: [],
    planningStarted: false,
    planProduced: false,
    taskIndex: 0,
    currentTaskId: null,
    reviewCycle: 0,
    completedTaskIds: [],
    reviewResults: [],
    reportStarted: false,
    updatedAt: Date.now()
  }
}

function saveCheckpoint(context: BuildContext, state: Record<string, unknown>): void {
  context.checkpoint = { ...context.checkpoint, updatedAt: Date.now() }
  heartbeatRunLease(context.leaseId, context.checkpoint)
  setMeetingBuildState(context.meetingId, {
    ...state,
    checkpoint: context.checkpoint
  })
}

type TurnResult = {
  message: MeetingMessage
  text: string
  usage: ChatUsage
  cancelled: boolean
  toolTraces: ChatToolTrace[]
  durationMs: number
  recoveredFiles: number
  usedWrite: boolean
}

type ReviewResult = {
  status: 'approved' | 'changes_requested'
  summary: string
  issues: string[]
  testsRun: string[]
  testsPassed: boolean
}

function emit(sender: WebContents, event: MeetingEvent): void {
  if (!sender.isDestroyed()) {
    sender.send(IPC_CHANNELS.meetingEvent, event)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withAgentLock<T>(
  context: BuildContext,
  agentId: string,
  run: () => Promise<T>
): Promise<T> {
  const previous = context.agentLocks.get(agentId)
  let release: () => void = () => undefined
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const chained = previous ? previous.then(() => current) : current
  context.agentLocks.set(agentId, chained)
  if (previous) {
    await previous
  }
  try {
    return await run()
  } finally {
    release()
    if (context.agentLocks.get(agentId) === chained) {
      context.agentLocks.delete(agentId)
    }
  }
}

function clampText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function usageFrom(
  usage: LanguageModelUsage | null | undefined,
  model: ModelRecord
): ChatUsage {
  const inputTokens = usage?.inputTokens ?? undefined
  const outputTokens = usage?.outputTokens ?? undefined
  const totalTokens = usage?.totalTokens ?? undefined
  const cachedTokens = usage?.inputTokenDetails?.cacheReadTokens ?? undefined
  const costUsd =
    model.inputPricePerMillion !== undefined || model.outputPricePerMillion !== undefined
      ? ((inputTokens ?? 0) * (model.inputPricePerMillion ?? 0) +
          (outputTokens ?? 0) * (model.outputPricePerMillion ?? 0)) /
        1_000_000
      : undefined
  return { inputTokens, outputTokens, totalTokens, cachedTokens, costUsd }
}

function resolveModel(agent: AgentConfig): {
  model: ModelRecord
  provider: ProviderConfig
} {
  const settings = loadSettings()
  if (!agent.model) {
    throw new AppError(
      'AGENT_MODEL_MISSING',
      `${agent.name} has no model assigned. Assign one in Settings, Team.`
    )
  }
  const model = settings.models.find(
    (entry) =>
      entry.providerId === agent.model?.providerConfigId &&
      entry.modelId === agent.model?.modelId
  )
  if (!model) {
    throw new AppError(
      'AGENT_MODEL_MISSING',
      `The model assigned to ${agent.name} is no longer in the catalog.`
    )
  }
  const provider = settings.providers.find((entry) => entry.id === model.providerId)
  if (!provider || !provider.enabled) {
    throw new AppError(
      'PROVIDER_DISABLED',
      `Enable the provider for ${agent.name} before starting Build.`
    )
  }
  return { model, provider }
}

function modelLabel(agent: AgentConfig): string {
  return agent.model
    ? `${agent.model.providerType} / ${agent.model.modelId}`
    : 'No model assigned'
}

function transcript(messages: MeetingMessage[], maxChars = 24_000): string {
  const relevant = messages.filter(
    (message) =>
      message.content.trim() &&
      message.metadata?.status !== 'streaming' &&
      message.kind !== 'report'
  )
  const parts: string[] = []
  let used = 0
  for (const message of relevant) {
    const header = `[${message.metadata?.phase ?? message.kind} r${message.metadata?.round ?? 0}] ${message.senderName}:`
    const piece = `${header}\n${clampText(message.content.trim(), 3_000)}`
    if (used + piece.length > maxChars) {
      parts.push('[Older transcript omitted]')
      break
    }
    used += piece.length
    parts.push(piece)
  }
  return parts.join('\n\n')
}

function changesSummary(sessionId: string): string {
  const changes = listChanges(sessionId, 200)
  if (changes.length === 0) {
    return 'No changes have been recorded in this Build meeting yet.'
  }
  return changes
    .slice(0, 40)
    .map((change) =>
      change.type === 'command'
        ? `- command: ${change.command} (exit ${change.exitCode ?? 'running'})`
        : `- ${change.type}: ${change.path} (agent ${change.agentId ?? 'unknown'})`
    )
    .join('\n')
}

function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('No JSON object found')
  }
  return JSON.parse(candidate.slice(start, end + 1)) as unknown
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
}

function reviewResult(text: string): ReviewResult {
  try {
    const parsed = extractJsonObject(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Review was not an object')
    }
    const value = parsed as Record<string, unknown>
    const status = String(value.status ?? '').toLowerCase()
    return {
      status: status.includes('approved') ? 'approved' : 'changes_requested',
      summary:
        typeof value.summary === 'string' && value.summary.trim()
          ? value.summary.trim()
          : 'QA completed the review.',
      issues: stringArray(value.issues),
      testsRun: stringArray(value.testsRun),
      testsPassed: value.testsPassed !== false
    }
  } catch {
    const normalized = normalizeText(text)
    const approved =
      normalized.includes('approved') &&
      !normalized.includes('changes requested') &&
      !normalized.includes('changes_requested')
    return {
      status: approved ? 'approved' : 'changes_requested',
      summary: clampText(text.trim(), 1_200) || 'QA completed the review.',
      issues: approved ? [] : ['QA requested changes. See the review details.'],
      testsRun: [],
      testsPassed: approved
    }
  }
}

const FILE_BLOCK_PATTERN =
  /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*|\/\/[ \t]*|<!--[ \t]*)?(?:\*\*)?(?:File|Path|Filename)(?:\*\*)?[ \t]*:[ \t]*`?([^\n`]+?)`?[ \t]*(?:-->)?[ \t]*\n[ \t]*```[^\n]*\n([\s\S]*?)```/gi

const WRITE_TOOLS = new Set([
  'write_file',
  'patch_file',
  'edit_file',
  'apply_patch',
  'delete_path',
  'move_path'
])

function usedWriteTool(traces: ChatToolTrace[]): boolean {
  return traces.some((trace) => trace.status === 'done' && WRITE_TOOLS.has(trace.toolName))
}

function usedCommandTool(traces: ChatToolTrace[]): boolean {
  return traces.some((trace) => trace.status === 'done' && trace.toolName === 'run_command')
}

function displayContent(text: string, wroteFiles: boolean): string {
  if (!wroteFiles) {
    return text
  }
  return text.replace(/```[\s\S]*?```/g, (block) =>
    block.length > 700 ? '\n[code written to the project files]\n' : block
  )
}

function persistFilesFromResponse(input: {
  sessionId: string
  meetingId: string
  taskId: string | null
  turnId: string
  agentId: string
  text: string
}): number {
  const root = getCurrentProjectRoot()
  if (!root) {
    return 0
  }
  const blocks: Array<{ filePath: string; content: string }> = []
  FILE_BLOCK_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FILE_BLOCK_PATTERN.exec(input.text)) !== null) {
    const filePath = match[1].trim().replace(/^["'`]+|["'`]+$/g, '')
    const content = match[2]
    if (filePath && content.trim()) {
      blocks.push({ filePath, content })
    }
  }
  let written = 0
  for (const block of blocks) {
    try {
      const { relative, absolute } = resolveWritableProjectPath(root, block.filePath)
      if (input.taskId) {
        assertTaskWriteAllowed({
          meetingId: input.meetingId,
          agentId: input.agentId,
          relativePath: relative
        })
      }
      const content = block.content.endsWith('\n') ? block.content : `${block.content}\n`
      const snapshot = snapshotFile(
        input.sessionId,
        relative,
        `before recovered response ${input.taskId ?? input.turnId}`
      )
      ensureDir(path.dirname(absolute))
      writeFileAtomic(absolute, content)
      recordChange({
        sessionId: input.sessionId,
        meetingId: input.meetingId,
        taskId: input.taskId ?? undefined,
        turnId: input.turnId,
        agentId: input.agentId,
        type: 'write',
        path: relative,
        beforeHash: snapshot.objectHash,
        afterHash: hashBuffer(Buffer.from(content, 'utf8')),
        snapshotId: snapshot.id,
        metadata: { source: 'agent_response_file_block' }
      })
      written += 1
    } catch (error) {
      log.warn('Could not persist a file block from the agent response', {
        meetingId: input.meetingId,
        taskId: input.taskId,
        filePath: block.filePath,
        error
      })
    }
  }
  if (written > 0) {
    appendMeetingMessage({
      meetingId: input.meetingId,
      senderType: 'system',
      senderAgentId: null,
      senderName: 'System',
      targetAgentId: null,
      kind: 'recovery',
      content: `Recovered ${written} file${written === 1 ? '' : 's'} from the agent response because it described files without calling a write tool. QA will review the result.`,
      metadata: { phase: 'build', round: 1, status: 'done' }
    })
  }
  return written
}

function toolBundleFor(input: {
  agent: AgentConfig
  root: string
  sessionId: string
  meetingId: string
  taskId: string | null
  task: MeetingTask | null
  round: number
  turnId: string
  sender: WebContents
  onTaskChanged?: (task: MeetingTask) => void
}): AgentToolBundle {
  const team = getCurrentTeamConfig()
  if (!team) {
    return { tools: {}, definitions: [], names: [], warnings: [] }
  }
  const settings = loadSettings()
  if (!agentCanUseTools(input.agent, settings)) {
    return { tools: {}, definitions: [], names: [], warnings: [] }
  }
  const runtime = {
    mode: 'build' as const,
    sessionId: input.sessionId,
    meetingId: input.meetingId,
    taskId: input.taskId ?? undefined,
    turnId: input.turnId,
    runId: input.turnId,
    agentId: input.agent.id,
    assertWriteAllowed: (relativePath: string) =>
      assertTaskWriteAllowed({
        meetingId: input.meetingId,
        agentId: input.agent.id,
        relativePath
      }),
    requestApproval: (approval: {
      actionType: Parameters<typeof requestBossApproval>[1]['actionType']
      actionKey: string
      risk: Parameters<typeof requestBossApproval>[1]['risk']
      reason: string
      payload: Record<string, unknown>
    }) =>
      requestBossApproval(input.sender, {
        sessionId: input.sessionId,
        runId: input.turnId,
        agentId: input.agent.id,
        ...approval
      }),
    emitOutput: (toolCallId: string, stream: 'stdout' | 'stderr' | 'system', text: string) => {
      emit(input.sender, {
        type: 'tool-output',
        meetingId: input.meetingId,
        turnId: input.turnId,
        toolCallId,
        stream,
        text
      })
    },
    readTodos: () => listAgentTodos(input.meetingId, input.agent.id),
    writeTodos: (items: Array<{ content: string; status?: 'pending' | 'in_progress' | 'done' | 'blocked' }>) => {
      const todos = replaceAgentTodos({
        meetingId: input.meetingId,
        agentId: input.agent.id,
        taskId: input.taskId,
        items
      })
      emit(input.sender, {
        type: 'todo',
        meetingId: input.meetingId,
        agentId: input.agent.id,
        todos,
        meeting: meetingSummary(input.meetingId)
      })
      return todos
    },
    postMessage: (message: {
      text: string
      targetAgentId?: string | null
      kind?: 'message' | 'notify' | 'question'
    }) => {
      const saved = appendMeetingMessage({
        meetingId: input.meetingId,
        senderType: 'agent',
        senderAgentId: input.agent.id,
        senderName: input.agent.name,
        targetAgentId: message.targetAgentId ?? null,
        kind: message.kind ?? 'message',
        content: message.text,
        metadata: { phase: 'build', round: input.round, status: 'done' }
      })
      emit(input.sender, {
        type: 'message',
        meetingId: input.meetingId,
        message: saved,
        meeting: meetingSummary(input.meetingId)
      })
      return saved
    },
    requestFromAgent: (request: {
      targetAgentId: string
      title: string
      description: string
      acceptanceCriteria?: string
      fileGlobs?: string[]
      priority?: number
    }) => {
      if (!input.task) {
        throw new Error('Start a task before requesting work from another agent.')
      }
      if (request.targetAgentId === input.agent.id) {
        throw new Error('You cannot request work from yourself.')
      }
      const created = createRequestTask({
        meetingId: input.meetingId,
        requestedByAgentId: input.agent.id,
        targetAgentId: request.targetAgentId,
        title: request.title,
        description: request.description,
        acceptanceCriteria: request.acceptanceCriteria ?? null,
        fileGlobs: request.fileGlobs ?? [],
        parentTaskId: input.task.id,
        priority: request.priority ?? 1
      })
      const current = meetingTask(input.task.id)
      const waiting = setTaskWaiting({
        taskId: current.id,
        waitingOnTaskIds: [...current.waitingOnTaskIds, created.id],
        note: `Waiting for ${request.targetAgentId} to complete: ${created.title}`
      })
      const saved = appendMeetingMessage({
        meetingId: input.meetingId,
        senderType: 'agent',
        senderAgentId: input.agent.id,
        senderName: input.agent.name,
        targetAgentId: request.targetAgentId,
        kind: 'request',
        content: `@${request.targetAgentId}: I need "${created.title}" built by you. ${request.description}`,
        metadata: {
          phase: 'build',
          round: input.round,
          status: 'done',
          requestTaskId: created.id,
          requestFromAgentId: input.agent.id,
          waitingOnTaskIds: [created.id]
        }
      })
      emit(input.sender, {
        type: 'task',
        meetingId: input.meetingId,
        task: created,
        meeting: meetingSummary(input.meetingId)
      })
      emit(input.sender, {
        type: 'task',
        meetingId: input.meetingId,
        task: waiting,
        meeting: meetingSummary(input.meetingId)
      })
      emit(input.sender, {
        type: 'message',
        meetingId: input.meetingId,
        message: saved,
        meeting: meetingSummary(input.meetingId)
      })
      input.onTaskChanged?.(waiting)
      return {
        taskId: created.id,
        title: created.title,
        targetAgentId: request.targetAgentId
      }
    }
  }
  return mergeToolBundles(
    createAgentTools({
      root: input.root,
      agent: input.agent,
      permissions: team.permissions,
      runtime
    }),
    buildMcpToolBundle({
      team,
      agent: input.agent,
      runtime,
      mode: 'build'
    })
  )
}

async function runBuildTurn(input: {
  context: BuildContext
  agent: AgentConfig
  phase: MeetingMessageMetadata['phase']
  round: number
  kind: string
  task: MeetingTask | null
  userText: string
  withTools: boolean
  reviewRound?: number
}): Promise<TurnResult> {
  const { context, agent, phase, round, kind, task, userText, withTools, reviewRound } = input
  const root = getCurrentProjectRoot()
  if (!root) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }
  const { model, provider } = resolveModel(agent)
  const settings = loadSettings()
  const memory = retrieveMemoryContext({
    agentId: agent.id,
    sessionId: context.sessionId,
    query: `${context.goal}\n${task?.title ?? ''}\n${userText}`,
    limit: 5
  })
  const turnId = randomUUID()
  const claims = activeMeetingClaims(context.meetingId).filter(
    (claim) => claim.agentId === agent.id
  )
  const toolBundle = withTools
    ? toolBundleFor({
        agent,
        root,
        sessionId: context.sessionId,
        meetingId: context.meetingId,
        taskId: task?.id ?? null,
        task,
        round,
        turnId,
        sender: context.sender,
        onTaskChanged: (updated) => {
          context.tasks = context.tasks.map((entry) =>
            entry.id === updated.id ? updated : entry
          )
        }
      })
    : { tools: {}, definitions: [], names: [], warnings: [] }
  const toolsAvailable = withTools && toolBundle.names.length > 0
  const allMessages = getMeetingDetail(context.meetingId).messages
  const teamChannelText = transcript(
    allMessages.filter((message) =>
      ['message', 'request', 'notify', 'question', 'recovery'].includes(message.kind)
    ),
    14_000
  )
  const todos = listAgentTodos(context.meetingId, agent.id)
  markMeetingDeliveriesProcessed(context.meetingId, agent.id)
  const prompt = compileBuildPrompt({
    agent,
    team: getCurrentTeamConfig() ?? {
      schemaVersion: 1,
      boss: { name: 'Boss', preferences: '' },
      agents: [agent],
      orchestration: {
        maxRounds: 3,
        maxTurns: 32,
        maxMessages: 50,
        maxMinutes: 15,
        maxTokens: 300_000,
        maxCostUsd: 2,
        maxToolStepsPerTurn: 8,
        maxReviewCycles: 2,
        maxConcurrentAgents: 4
      },
      permissions: {
        autoWriteInsideRepo: true,
        autoShellInsideRepo: true,
        askOutsideRepo: true,
        askInstall: true,
        askNetwork: true,
        askDeploy: true
      },
      mcp: { enabledServerIds: [], toolPolicies: {} }
    },
    project: getCurrentProject()!,
    settings,
    phase,
    goal: context.goal,
    tasks: context.tasks,
    task,
    plan: context.plan,
    claims,
    historyText: transcript(allMessages),
    teamChannelText,
    todos,
    maxConcurrentAgents: context.budget.maxConcurrentAgents ?? 4,
    memory,
    toolsAvailable,
    toolNames: toolBundle.names,
    modelLabel: modelLabel(agent),
    reviewRound: reviewRound ?? 0,
    maxReviewCycles: context.budget.maxReviewCycles,
    changesSummary: changesSummary(context.sessionId)
  })

  const startedAt = Date.now()
  const streaming = beginMeetingMessage({
    meetingId: context.meetingId,
    senderType: 'agent',
    senderAgentId: agent.id,
    senderName: agent.name,
    targetAgentId: null,
    kind,
    metadata: {
      phase,
      round,
      turnId,
      status: 'streaming'
    }
  })
  emit(context.sender, {
    type: 'turn-start',
    meetingId: context.meetingId,
    turnId,
    message: streaming,
    meeting: meetingSummary(context.meetingId)
  })

  let fullText = ''
  let usage: ChatUsage = {}
  const toolTraces: ChatToolTrace[] = []
  const toolStarts = new Map<string, number>()
  let stepCount = 0
  let streamError: unknown = null

  try {
    const result = streamText({
      model: createLanguageModel(provider, model),
      system: prompt.system,
      messages: [{ role: 'user', content: userText }],
      maxOutputTokens:
        phase === 'report'
          ? Math.min(model.maxOutputTokens ?? 6_000, 6_000)
          : phase === 'review'
            ? Math.min(model.maxOutputTokens ?? 4_000, 4_000)
            : Math.min(model.maxOutputTokens ?? 32_000, 32_000),
      temperature: Math.min(Math.max(agent.model?.temperature ?? 0.2, 0), 2),
      maxRetries: 0,
      timeout: 180_000,
      abortSignal: context.controller.signal,
      ...(toolsAvailable
        ? {
            tools: toolBundle.tools as ToolSet,
            stopWhen: stepCountIs(Math.min(Math.max(context.budget.maxToolStepsPerTurn, 1), 8))
          }
        : {})
    })

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        fullText += part.text
        emit(context.sender, {
          type: 'delta',
          meetingId: context.meetingId,
          turnId,
          text: part.text
        })
        continue
      }
      if (part.type === 'tool-call') {
        stepCount += 1
        const trace: ChatToolTrace = {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
          status: 'running'
        }
        toolTraces.push(trace)
        toolStarts.set(part.toolCallId, Date.now())
        continue
      }
      if (part.type === 'tool-result') {
        const trace = toolTraces.find((entry) => entry.toolCallId === part.toolCallId)
        if (trace) {
          trace.status = 'done'
          trace.output = part.output
          trace.durationMs = Date.now() - (toolStarts.get(part.toolCallId) ?? Date.now())
        }
        if (
          part.output &&
          typeof part.output === 'object' &&
          'processId' in part.output &&
          typeof (part.output as { processId?: unknown }).processId === 'string'
        ) {
          context.processIds.add((part.output as { processId: string }).processId)
        }
        continue
      }
      if (part.type === 'tool-error') {
        const trace = toolTraces.find((entry) => entry.toolCallId === part.toolCallId)
        if (trace) {
          trace.status = 'error'
          trace.error = part.error instanceof Error ? part.error.message : String(part.error)
          trace.durationMs = Date.now() - (toolStarts.get(part.toolCallId) ?? Date.now())
        }
        continue
      }
      if (part.type === 'finish') {
        usage = usageFrom(part.totalUsage, model)
        continue
      }
      if (part.type === 'error') {
        streamError = part.error
      }
    }

    if (streamError && !context.controller.signal.aborted) {
      throw streamError
    }

    const durationMs = Date.now() - startedAt
    const wroteWithTool = usedWriteTool(toolTraces)
    const rawContent =
      fullText.trim() || (context.controller.signal.aborted ? 'Stopped.' : 'No response.')
    let recoveredFiles = 0
    if (phase === 'build' && !context.controller.signal.aborted && !wroteWithTool) {
      recoveredFiles = persistFilesFromResponse({
        sessionId: context.sessionId,
        meetingId: context.meetingId,
        taskId: task?.id ?? null,
        turnId,
        agentId: agent.id,
        text: rawContent
      })
    }
    const content = displayContent(rawContent, wroteWithTool || recoveredFiles > 0)
    const message = updateMeetingMessage({
      messageId: streaming.id,
      content,
      metadata: {
        phase,
        round,
        turnId,
        status: context.controller.signal.aborted ? 'cancelled' : 'done',
        usage,
        durationMs,
        toolCalls: toolTraces
      }
    })
    recordMeetingUsage({
      meetingId: context.meetingId,
      turnId,
      agentId: agent.id,
      providerId: provider.id,
      modelId: model.modelId,
      usage
    })
    recordMeetingTurn({
      meetingId: context.meetingId,
      turnId,
      agentId: agent.id,
      reason: phase,
      status: context.controller.signal.aborted ? 'cancelled' : 'done',
      stepCount,
      usage,
      startedAt
    })
    emit(context.sender, {
      type: 'message',
      meetingId: context.meetingId,
      message,
      meeting: meetingSummary(context.meetingId)
    })
    if (!context.controller.signal.aborted) {
      try {
        recordTurnMemories({
          sessionId: context.sessionId,
          sessionTitle: meetingTitle(context.meetingId),
          agentId: agent.id,
          agentName: agent.name,
          mode: 'build',
          userText,
          assistantText: content,
          assistantMessageId: message.id,
          startedAt,
          toolTraces
        })
      } catch (error) {
        log.warn('Could not record Build turn memory', {
          meetingId: context.meetingId,
          agentId: agent.id,
          error
        })
      }
    }
    return {
      message,
      text: content,
      usage,
      cancelled: context.controller.signal.aborted,
      toolTraces,
      durationMs,
      recoveredFiles,
      usedWrite: wroteWithTool || recoveredFiles > 0
    }
  } catch (error) {
    const durationMs = Date.now() - startedAt
    const message = formatProviderError(error, provider)
    const cancelled = context.controller.signal.aborted
    const failed = updateMeetingMessage({
      messageId: streaming.id,
      content: fullText.trim() || (cancelled ? 'Stopped.' : `The agent failed: ${message}`),
      metadata: {
        phase,
        round,
        turnId,
        status: cancelled ? 'cancelled' : 'error',
        usage,
        durationMs,
        toolCalls: toolTraces,
        error: message
      }
    })
    recordMeetingUsage({
      meetingId: context.meetingId,
      turnId,
      agentId: agent.id,
      providerId: provider.id,
      modelId: model.modelId,
      usage
    })
    recordMeetingTurn({
      meetingId: context.meetingId,
      turnId,
      agentId: agent.id,
      reason: phase,
      status: cancelled ? 'cancelled' : 'error',
      stepCount,
      usage,
      error: message,
      startedAt
    })
    emit(context.sender, {
      type: 'message',
      meetingId: context.meetingId,
      message: failed,
      meeting: meetingSummary(context.meetingId)
    })
    if (cancelled) {
      return {
        message: failed,
        text: fullText,
        usage,
        cancelled: true,
        toolTraces,
        durationMs,
        recoveredFiles: 0,
        usedWrite: false
      }
    }
    throw new Error(message)
  }
}

function addUsage(context: BuildContext, turn: TurnResult, round: number): void {
  context.usage = {
    ...context.usage,
    rounds: Math.max(context.usage.rounds, round),
    turns: context.usage.turns + 1,
    messages: context.usage.messages + 1,
    inputTokens: context.usage.inputTokens + (turn.usage.inputTokens ?? 0),
    outputTokens: context.usage.outputTokens + (turn.usage.outputTokens ?? 0),
    costUsd: context.usage.costUsd + (turn.usage.costUsd ?? 0),
    elapsedMs: Date.now() - context.startedAt
  }
  updateMeetingUsage(context.meetingId, context.usage)
}

function budgetExceeded(context: BuildContext): boolean {
  const totalTokens = context.usage.inputTokens + context.usage.outputTokens
  return (
    context.usage.turns >= context.budget.maxTurns ||
    context.usage.messages >= context.budget.maxMessages ||
    totalTokens >= context.budget.maxTokens ||
    context.usage.costUsd >= context.budget.maxCostUsd ||
    context.usage.elapsedMs >= context.budget.maxMinutes * 60_000
  )
}

function agentForTask(
  agents: AgentConfig[],
  task: MeetingTask,
  coordinator: AgentConfig
): AgentConfig {
  return (
    agents.find((agent) => agent.id === task.assigneeAgentId) ??
    agents.find((agent) => agent.id === coordinator.id) ??
    coordinator
  )
}

function qaAgent(agents: AgentConfig[], coordinator: AgentConfig): AgentConfig {
  return (
    agents.find((agent) => agent.roleKey === 'qa') ??
    agents.find((agent) => agent.permissions.tools.includes('run_command')) ??
    coordinator
  )
}


function buildReport(input: {
  context: BuildContext
  summary: string
  status: MeetingStatus
  stopReason: MeetingSummary['stopReason']
  partial: boolean
}): MeetingFinalReport {
  const { context, summary, partial } = input
  const detail = getMeetingDetail(context.meetingId)
  const changes = listChanges(context.sessionId, 300)
  const files = changes
    .filter((change) => change.path && change.type !== 'command')
    .map((change) => ({
      path: change.path ?? '',
      type: change.type,
      agentId: change.agentId,
      taskId: change.taskId ?? null,
      canRevert: change.canRevert
    }))
  const uniqueFiles = [
    ...new Map(files.map((file) => [`${file.type}:${file.path}`, file])).values()
  ]
  const commands = changes
    .filter((change) => change.type === 'command' && change.command)
    .map((change) => ({
      command: change.command ?? '',
      exitCode: change.exitCode,
      agentId: change.agentId,
      taskId: change.taskId ?? null
    }))
  const tests = context.reviewResults.flatMap((review) =>
    review.testsRun.length > 0
      ? review.testsRun.map(
          (test) =>
            `${review.taskTitle}: ${test} (${review.testsPassed ? 'passed' : 'failed'})`
        )
      : []
  )
  const latestReview = new Map<string, (typeof context.reviewResults)[number]>()
  for (const review of context.reviewResults) {
    latestReview.set(review.taskId, review)
  }
  const unresolvedTasks = context.tasks.filter(
    (task) => task.status === 'blocked' || task.status === 'changes_requested'
  )
  const unresolved = [
    ...unresolvedTasks
      .filter((task) => task.status === 'blocked')
      .map((task) => `${task.title} is blocked.`),
    ...unresolvedTasks.flatMap((task) => {
      const review = latestReview.get(task.id)
      return review && review.status === 'changes_requested'
        ? review.issues.map((issue) => `${task.title}: ${issue}`)
        : []
    }),
    ...(partial ? [`Build stopped before every task completed (${input.stopReason ?? 'unknown'}).`] : [])
  ]
  const tasks: MeetingReportTask[] = context.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    assigneeAgentId: task.assigneeAgentId,
    reviewCycles: task.reviewCycles,
    acceptanceCriteria: task.acceptanceCriteria
  }))
  const report: MeetingFinalReport = {
    summary:
      summary.trim() ||
      'Build meeting completed. Review the task board and change log for the exact outcome.',
    filesChanged: uniqueFiles,
    commands,
    tests: [...new Set(tests)],
    approvals: approvalSummaryForSession(context.sessionId),
    decisions: detail.decisions.map((decision) => `${decision.title}: ${decision.decision}`),
    unresolved: [...new Set(unresolved)],
    revertInstructions: [
      'Open Changes in the Build room header to inspect or revert individual file edits.',
      'Use Revert task on a completed task card to restore every file change from that task.',
      'Reverts are snapshotted and recorded like any other change.'
    ],
    tasks,
    generatedAt: Date.now(),
    partial
  }
  setMeetingFinalReport(context.meetingId, report)
  const meeting = meetingSummary(context.meetingId)
  emit(context.sender, {
    type: 'report',
    meetingId: context.meetingId,
    report,
    meeting
  })
  return report
}

function finishBuild(input: {
  context: BuildContext
  status: MeetingStatus
  stopReason: MeetingSummary['stopReason']
  summary: string
  partial: boolean
}): void {
  const { context, status, stopReason, summary, partial } = input
  releaseAllActiveClaims(context.meetingId)
  for (const processId of context.processIds) {
    try {
      stopManagedProcess(processId)
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'PROCESS_NOT_FOUND')) {
        log.warn('Could not stop a Build background process', {
          meetingId: context.meetingId,
          processId,
          error
        })
      }
    }
  }
  context.processIds.clear()
  context.checkpoint.phase = status === 'completed' ? 'done' : context.checkpoint.phase
  context.checkpoint.updatedAt = Date.now()
  heartbeatRunLease(context.leaseId, context.checkpoint)
  setMeetingBuildState(context.meetingId, {
    phase: context.checkpoint.phase,
    checkpoint: context.checkpoint,
    status
  })
  finishRunLease(context.leaseId, status === 'completed' ? 'completed' : 'stopped')
  const report = buildReport({ context, summary, status, stopReason, partial })
  setMeetingStatus({
    meetingId: context.meetingId,
    status,
    stopReason,
    ended: true
  })
  const detail = getMeetingDetail(context.meetingId)
  emit(context.sender, {
    type: 'done',
    meetingId: context.meetingId,
    meeting: detail
  })
  log.info('Build meeting finished', {
    meetingId: context.meetingId,
    status,
    stopReason,
    tasks: context.tasks.length,
    turns: context.usage.turns,
    costUsd: context.usage.costUsd,
    filesChanged: report.filesChanged.length
  })
}

function stopCurrentBuild(context: BuildContext, reason: 'user' | 'paused'): void {
  finishBuild({
    context,
    status: 'stopped',
    stopReason: reason,
    summary:
      reason === 'paused'
        ? 'Build paused by the Boss. Partial work is recorded in the task board and change log.'
        : 'Build stopped by the Boss. Partial work is recorded in the task board and change log.',
    partial: true
  })
}

async function runImplementerTurn(input: {
  context: BuildContext
  task: MeetingTask
  agent: AgentConfig
  userText: string
  round: number
}): Promise<TurnResult | null> {
  const { context, task, agent } = input
  createTaskClaims({
    meetingId: context.meetingId,
    task,
    agent
  })
  try {
    const turn = await withAgentLock(context, agent.id, () =>
      runBuildTurn({
        context,
        agent,
        phase: 'build',
        round: input.round,
        kind: 'build',
        task,
        withTools: true,
        userText: input.userText
      })
    )
    addUsage(context, turn, input.round)
    return turn.cancelled ? null : turn
  } finally {
    releaseTaskClaims(context.meetingId, task.id)
  }
}

async function runReviewerTurn(input: {
  context: BuildContext
  task: MeetingTask
  reviewer: AgentConfig
  reviewRound: number
}): Promise<TurnResult | null> {
  const { context, task, reviewer } = input
  createTaskClaims({
    meetingId: context.meetingId,
    task,
    agent: reviewer,
    globs: reviewer.permissions.writeGlobs
  })
  try {
    const turn = await withAgentLock(context, reviewer.id, () =>
      runBuildTurn({
        context,
        agent: reviewer,
        phase: 'review',
        round: 2 + input.reviewRound,
        kind: 'review',
        task,
        withTools: true,
        reviewRound: input.reviewRound,
        userText: `Review this completed task and return the required JSON review.\n\nTask: ${task.title}\n${task.description}\n\nAcceptance: ${task.acceptanceCriteria ?? 'not supplied'}`
      })
    )
    addUsage(context, turn, 2 + input.reviewRound)
    return turn.cancelled ? null : turn
  } finally {
    releaseTaskClaims(context.meetingId, task.id)
  }
}

function notifyTeam(
  context: BuildContext,
  agent: AgentConfig,
  content: string,
  kind = 'notify'
): void {
  const message = appendMeetingMessage({
    meetingId: context.meetingId,
    senderType: 'agent',
    senderAgentId: agent.id,
    senderName: agent.name,
    targetAgentId: null,
    kind,
    content,
    metadata: { phase: 'build', round: 1, status: 'done' }
  })
  emit(context.sender, {
    type: 'message',
    meetingId: context.meetingId,
    message,
    meeting: meetingSummary(context.meetingId)
  })
}

function taskFiles(context: BuildContext, taskId: string): string[] {
  return [
    ...new Set(
      listChanges(context.sessionId, 500)
        .filter((change) => change.taskId === taskId && change.path)
        .map((change) => change.path as string)
    )
  ]
}

function completeTask(context: BuildContext, task: MeetingTask, agent: AgentConfig): void {
  const done = transitionMeetingTask({
    taskId: task.id,
    status: 'done',
    agentId: agent.id,
    note: 'Task approved and completed.',
    type: 'approved'
  })
  context.tasks = context.tasks.map((entry) => (entry.id === done.id ? done : entry))
  context.checkpoint.completedTaskIds = [
    ...new Set([...context.checkpoint.completedTaskIds, done.id])
  ]
  saveCheckpoint(context, { taskId: done.id, phase: 'build' })
  emit(context.sender, {
    type: 'task',
    meetingId: context.meetingId,
    task: done,
    meeting: meetingSummary(context.meetingId)
  })
  const files = taskFiles(context, done.id)
  notifyTeam(
    context,
    agent,
    `Completed "${done.title}".${files.length > 0 ? ` Files: ${files.join(', ')}.` : ''} Notifying the Coordinator.`,
    'notify'
  )
  const released = releaseTasksWaitingOn(context.meetingId, done.id)
  for (const waiting of released) {
    context.tasks = context.tasks.map((entry) =>
      entry.id === waiting.id ? waiting : entry
    )
    emit(context.sender, {
      type: 'task',
      meetingId: context.meetingId,
      task: waiting,
      meeting: meetingSummary(context.meetingId)
    })
  }
  if (released.length > 0) {
    notifyTeam(
      context,
      agent,
      `Request complete. ${released
        .map((entry) => `"${entry.title}" (${entry.assigneeAgentId})`)
        .join(', ')} can resume.`,
      'notify'
    )
  }
}

function blockTask(
  context: BuildContext,
  task: MeetingTask,
  agent: AgentConfig,
  error: unknown
): void {
  const note = error instanceof Error ? error.message : String(error)
  try {
    const blocked = transitionMeetingTask({
      taskId: task.id,
      status: 'blocked',
      agentId: agent.id,
      note,
      type: 'failed'
    })
    context.tasks = context.tasks.map((entry) =>
      entry.id === blocked.id ? blocked : entry
    )
    emit(context.sender, {
      type: 'task',
      meetingId: context.meetingId,
      task: blocked,
      meeting: meetingSummary(context.meetingId)
    })
    notifyTeam(
      context,
      agent,
      `Blocked "${blocked.title}": ${note}`,
      'notify'
    )
  } catch (transitionError) {
    log.warn('Could not mark a Build task blocked', {
      meetingId: context.meetingId,
      taskId: task.id,
      error: transitionError
    })
  }
}

async function runTaskPipeline(input: {
  context: BuildContext
  taskId: string
  agents: AgentConfig[]
  coordinator: AgentConfig
  reviewer: AgentConfig
}): Promise<void> {
  const { context, agents, coordinator, reviewer } = input
  const task = meetingTask(input.taskId)
  if (['done', 'blocked', 'waiting'].includes(task.status)) {
    return
  }
  const implementer = agentForTask(agents, task, coordinator)
  let working = task
  let reviewCycle = working.reviewCycles
  const startedInReview =
    working.status === 'review' || working.status === 'changes_requested'

  try {
    if (working.status === 'changes_requested') {
      const priorReview = [...context.reviewResults]
        .reverse()
        .find((entry) => entry.taskId === working.id)
      const issues = priorReview?.issues ?? [
        'Resume the requested fix from the saved review checkpoint.'
      ]
      const fix = await runImplementerTurn({
        context,
        task: working,
        agent: implementer,
        round: 2 + reviewCycle,
        userText: `QA requested changes. Fix only these issues, inside the project.\n\nTask: ${working.title}\n${issues.map((issue) => `- ${issue}`).join('\n')}`
      })
      if (!fix) {
        return
      }
      if (meetingTask(working.id).status === 'waiting') {
        return
      }
      working = transitionMeetingTask({
        taskId: working.id,
        status: 'review',
        agentId: reviewer.id,
        note: 'Resumed after the requested fix.',
        type: 'review-start'
      })
    } else if (!startedInReview) {
      working =
        working.status === 'in_progress'
          ? working
          : transitionMeetingTask({
              taskId: working.id,
              status: 'in_progress',
              agentId: implementer.id,
              note: `${implementer.name} started the task.`,
              type: 'start'
            })
      context.checkpoint.currentTaskId = working.id
      context.checkpoint.reviewCycle = 0
      saveCheckpoint(context, { taskId: working.id, phase: 'build' })
      const build = await runImplementerTurn({
        context,
        task: working,
        agent: implementer,
        round: 1,
        userText: `Implement this Build task. You have full access inside the project.\n\nTask: ${working.title}\n${working.description}\n\nAcceptance: ${working.acceptanceCriteria ?? 'not supplied'}\n\nIf you need another agent to build something first, call request_from_agent.`
      })
      if (!build) {
        return
      }
      if (meetingTask(working.id).status === 'waiting') {
        return
      }
      if (!build.usedWrite && !usedCommandTool(build.toolTraces)) {
        const repair = await runImplementerTurn({
          context,
          task: working,
          agent: implementer,
          round: 2,
          userText: `You answered without calling a write tool and without running a command. Do not paste source code in chat. Call write_file, edit_file, or apply_patch now for every file you described, then run the smallest useful check.`
        })
        if (!repair) {
          return
        }
        if (meetingTask(working.id).status === 'waiting') {
          return
        }
        if (!repair.usedWrite && !usedCommandTool(repair.toolTraces)) {
          throw new Error(
            'The agent did not create or edit any files and did not run a command. Build stopped this task so it can be retried with a tool-capable model.'
          )
        }
      }
      working = transitionMeetingTask({
        taskId: working.id,
        status: 'review',
        agentId: reviewer.id,
        note: `${reviewer.name} is reviewing the task.`,
        type: 'review-start'
      })
    }

    while (reviewCycle < context.budget.maxReviewCycles) {
      reviewCycle += 1
      working = meetingTask(working.id)
      context.checkpoint.currentTaskId = working.id
      context.checkpoint.reviewCycle = reviewCycle
      saveCheckpoint(context, { taskId: working.id, phase: 'review', reviewCycle })
      if (context.controller.signal.aborted) {
        return
      }
      let review: ReviewResult | null = null
      const reviewTurn = await runReviewerTurn({
        context,
        task: working,
        reviewer,
        reviewRound: reviewCycle
      }).catch((error: unknown) => {
        review = {
          status: 'changes_requested',
          summary: error instanceof Error ? error.message : String(error),
          issues: ['The QA review could not complete.'],
          testsRun: [],
          testsPassed: false
        }
        return null
      })
      if (reviewTurn) {
        review = reviewResult(reviewTurn.text)
      }
      if (!review) {
        break
      }
      context.reviewResults.push({
        taskId: working.id,
        taskTitle: working.title,
        status: review.status,
        summary: review.summary,
        issues: review.issues,
        testsRun: review.testsRun,
        testsPassed: review.testsPassed
      })
      context.checkpoint.reviewResults = context.reviewResults
      context.checkpoint.reviewCycle = reviewCycle
      saveCheckpoint(context, { taskId: working.id, phase: 'review', reviewCycle })

      if (review.status === 'approved') {
        completeTask(context, working, reviewer)
        return
      }
      if (reviewCycle >= context.budget.maxReviewCycles) {
        working = transitionMeetingTask({
          taskId: working.id,
          status: 'blocked',
          agentId: reviewer.id,
          note: `Review limit reached. ${review.summary}`,
          type: 'blocked'
        })
        notifyTeam(
          context,
          reviewer,
          `Blocked "${working.title}" after ${reviewCycle} review cycles: ${review.summary}`,
          'notify'
        )
        return
      }
      working = transitionMeetingTask({
        taskId: working.id,
        status: 'changes_requested',
        agentId: implementer.id,
        note: review.issues.join('; ') || review.summary,
        type: 'changes-requested',
        incrementReview: true
      })
      emit(context.sender, {
        type: 'task',
        meetingId: context.meetingId,
        task: working,
        meeting: meetingSummary(context.meetingId)
      })
      const fix = await runImplementerTurn({
        context,
        task: working,
        agent: implementer,
        round: 2 + reviewCycle,
        userText: `QA requested changes. Fix only these issues inside the project.\n\nTask: ${working.title}\n${review.issues.map((issue) => `- ${issue}`).join('\n') || review.summary}`
      })
      if (!fix) {
        return
      }
      if (meetingTask(working.id).status === 'waiting') {
        return
      }
      working = transitionMeetingTask({
        taskId: working.id,
        status: 'review',
        agentId: reviewer.id,
        note: `Review cycle ${reviewCycle + 1}.`,
        type: 'review-start'
      })
    }

    const latest = meetingTask(working.id)
    if (latest.status !== 'done' && latest.status !== 'blocked' && latest.status !== 'waiting') {
      blockTask(
        context,
        latest,
        reviewer,
        new Error('The task did not receive an approved review.')
      )
    }
  } catch (error) {
    if (context.controller.signal.aborted) {
      releaseTaskClaims(context.meetingId, task.id)
      return
    }
    blockTask(context, meetingTask(task.id), implementer, error)
  } finally {
    releaseTaskClaims(context.meetingId, task.id)
  }
}

function refreshTask(context: BuildContext, taskId: string): MeetingTask | null {
  try {
    const task = meetingTask(taskId)
    context.tasks = context.tasks.map((entry) => (entry.id === task.id ? task : entry))
    return task
  } catch {
    return null
  }
}

function dependencyTasks(context: BuildContext, task: MeetingTask): MeetingTask[] {
  return task.dependsOn
    .map((dependency) =>
      context.tasks.find((entry) => entry.title === dependency || entry.id === dependency)
    )
    .filter((entry): entry is MeetingTask => Boolean(entry))
}

async function runBuild(context: BuildContext): Promise<void> {
  const agents = meetingParticipants(context.meetingId)
  const coordinator = coordinatorAgent(context.meetingId)
  const reviewer = qaAgent(agents, coordinator)
  const maxConcurrent = Math.min(
    Math.max(context.budget.maxConcurrentAgents ?? 4, 2),
    Math.max(agents.length, 2)
  )
  const running = new Map<string, { agentId: string; promise: Promise<void> }>()
  let stopped = false

  try {
    setMeetingStatus({
      meetingId: context.meetingId,
      status: 'building',
      stopReason: null,
      started: true
    })
    emit(context.sender, {
      type: 'meeting-start',
      meeting: meetingSummary(context.meetingId)
    })

    for (const task of context.tasks) {
      if (['in_progress', 'review', 'changes_requested'].includes(task.status)) {
        transitionMeetingTask({
          taskId: task.id,
          status: 'queued',
          note: 'Task re-queued for parallel execution.',
          type: 'queued'
        })
      }
    }
    context.tasks = listMeetingTasks(context.meetingId)

    appendMeetingMessage({
      meetingId: context.meetingId,
      senderType: 'agent',
      senderAgentId: coordinator.id,
      senderName: coordinator.name,
      targetAgentId: null,
      kind: 'dispatch',
      content: [
        `Build dispatched with ${context.tasks.length} tasks.`,
        `Up to ${maxConcurrent} agents work in parallel.`,
        'Agents can request work from each other; requests are high priority and the requester waits automatically.',
        'Only the Coordinator answers the Boss. Team messages are visible to everyone.'
      ].join(' '),
      metadata: { phase: 'build', round: 1, status: 'done' }
    })
    notifyTeam(
      context,
      coordinator,
      `Team, we are starting in parallel. Max ${maxConcurrent} agents. Post progress, request work when blocked, and notify me when your part is complete.`,
      'message'
    )

    while (!context.controller.signal.aborted) {
      context.tasks = listMeetingTasks(context.meetingId)

      for (const task of context.tasks) {
        if (task.status !== 'waiting') {
          continue
        }
        const waits = task.waitingOnTaskIds
          .map((id) => context.tasks.find((entry) => entry.id === id))
          .filter((entry): entry is MeetingTask => Boolean(entry))
        if (waits.some((entry) => entry.status === 'blocked')) {
          const blocked = transitionMeetingTask({
            taskId: task.id,
            status: 'blocked',
            note: `A requested task failed: ${waits
              .filter((entry) => entry.status === 'blocked')
              .map((entry) => entry.title)
              .join(', ')}`,
            type: 'blocked'
          })
          emit(context.sender, {
            type: 'task',
            meetingId: context.meetingId,
            task: blocked,
            meeting: meetingSummary(context.meetingId)
          })
          continue
        }
        if (waits.length === task.waitingOnTaskIds.length && waits.every((entry) => entry.status === 'done')) {
          const ready = transitionMeetingTask({
            taskId: task.id,
            status: 'queued',
            note: 'The requested work is complete. Task is ready to resume.',
            type: 'ready'
          })
          emit(context.sender, {
            type: 'task',
            meetingId: context.meetingId,
            task: ready,
            meeting: meetingSummary(context.meetingId)
          })
        }
      }

      context.tasks = listMeetingTasks(context.meetingId)
      const open = context.tasks.filter(
        (task) => task.status !== 'done' && task.status !== 'blocked'
      )
      if (open.length === 0 && running.size === 0) {
        break
      }

      if (budgetExceeded(context)) {
        finishBuild({
          context,
          status: 'stopped',
          stopReason: 'budget',
          summary: 'Build stopped because a meeting budget limit was reached. Partial work is recorded.',
          partial: true
        })
        stopped = true
        break
      }

      const busyAgents = new Set([...running.values()].map((entry) => entry.agentId))
      const candidates = context.tasks
        .filter((task) => task.status === 'queued')
        .sort((a, b) => {
          const requestA = a.requestKind === 'request' ? 0 : 1
          const requestB = b.requestKind === 'request' ? 0 : 1
          return requestA - requestB || a.priority - b.priority || a.createdAt - b.createdAt
        })

      for (const candidate of candidates) {
        if (context.controller.signal.aborted) {
          break
        }
        if (running.size >= maxConcurrent) {
          break
        }
        const agentId = candidate.assigneeAgentId ?? coordinator.id
        if (busyAgents.has(agentId)) {
          continue
        }
        const dependencies = dependencyTasks(context, candidate)
        const pending = dependencies.filter((entry) => entry.status !== 'done')
        if (pending.length > 0) {
          const blocked = pending.filter((entry) => entry.status === 'blocked')
          if (blocked.length > 0) {
            const updated = transitionMeetingTask({
              taskId: candidate.id,
              status: 'blocked',
              note: `Blocked by ${blocked.map((entry) => entry.title).join(', ')}.`,
              type: 'blocked'
            })
            emit(context.sender, {
              type: 'task',
              meetingId: context.meetingId,
              task: updated,
              meeting: meetingSummary(context.meetingId)
            })
          } else {
            const updated = setTaskWaiting({
              taskId: candidate.id,
              waitingOnTaskIds: pending.map((entry) => entry.id),
              note: `Waiting for ${pending.map((entry) => entry.title).join(', ')}.`
            })
            emit(context.sender, {
              type: 'task',
              meetingId: context.meetingId,
              task: updated,
              meeting: meetingSummary(context.meetingId)
            })
          }
          continue
        }

        const agent = agentForTask(agents, candidate, coordinator)
        const globs =
          candidate.fileGlobs.length > 0
            ? candidate.fileGlobs
            : agent.permissions.writeGlobs
        const conflict =
          running.size > 0
            ? findClaimConflict({
                meetingId: context.meetingId,
                agentId: agent.id,
                taskId: candidate.id,
                globs
              })
            : null
        if (conflict) {
          log.info('Task waits for a file claim', {
            meetingId: context.meetingId,
            taskId: candidate.id,
            conflict
          })
          continue
        }

        const promise = runTaskPipeline({
          context,
          taskId: candidate.id,
          agents,
          coordinator,
          reviewer
        })
          .catch((error: unknown) => {
            blockTask(context, meetingTask(candidate.id), agent, error)
          })
          .finally(() => {
            running.delete(candidate.id)
            refreshTask(context, candidate.id)
          })
        running.set(candidate.id, { agentId: agent.id, promise })
        busyAgents.add(agent.id)
        emit(context.sender, {
          type: 'meeting-update',
          meeting: meetingSummary(context.meetingId)
        })
      }

      if (running.size === 0) {
        const stuck = context.tasks.filter(
          (task) => task.status === 'waiting' || task.status === 'queued'
        )
        for (const task of stuck) {
          const agent = agentForTask(agents, task, coordinator)
          blockTask(
            context,
            task,
            agent,
            new Error(
              'No runnable work remains. A dependency or file claim could not be resolved.'
            )
          )
        }
        if (stuck.length === 0) {
          break
        }
        continue
      }

      await Promise.race([...running.values()].map((entry) => entry.promise))
    }

    if (context.controller.signal.aborted) {
      stopCurrentBuild(context, context.stopSignalReason())
      stopped = true
    }

    if (!stopped) {
      await Promise.allSettled([...running.values()].map((entry) => entry.promise))
      context.tasks = listMeetingTasks(context.meetingId)
      setMeetingStatus({ meetingId: context.meetingId, status: 'reporting' })
      context.checkpoint.phase = 'report'
      context.checkpoint.reportStarted = true
      context.checkpoint.currentTaskId = null
      saveCheckpoint(context, { phase: 'report' })
      let reportSummary = ''
      try {
        const reportTurn = await runBuildTurn({
          context,
          agent: coordinator,
          phase: 'report',
          round: 10,
          kind: 'report',
          task: null,
          withTools: false,
          userText:
            'Write the final Build report for the Boss from the parallel task board, team requests, change log, approvals, and reviews.'
        })
        addUsage(context, reportTurn, 10)
        if (reportTurn.cancelled) {
          stopCurrentBuild(context, context.stopSignalReason())
          return
        }
        reportSummary = reportTurn.text
      } catch (error) {
        reportSummary = `Build finished but the Coordinator report could not be generated: ${
          error instanceof Error ? error.message : String(error)
        }`
      }

      const blocked = context.tasks.filter((task) => task.status === 'blocked').length
      finishBuild({
        context,
        status: blocked > 0 ? 'stopped' : 'completed',
        stopReason: blocked > 0 ? 'blocked' : 'completed',
        summary: reportSummary,
        partial: blocked > 0
      })
    }
  } catch (error) {
    if (!getCurrentProject()) {
      log.info('Build stopped because the project closed', {
        meetingId: context.meetingId
      })
      return
    }
    if (context.controller.signal.aborted) {
      stopCurrentBuild(context, context.stopSignalReason())
      return
    }
    releaseAllActiveClaims(context.meetingId)
    const message = error instanceof Error ? error.message : String(error)
    try {
      finishBuild({
        context,
        status: 'failed',
        stopReason: 'error',
        summary: `Build failed: ${message}`,
        partial: true
      })
    } catch (reportError) {
      log.error('Could not finalize failed Build report', {
        meetingId: context.meetingId,
        error: reportError
      })
    }
    emit(context.sender, {
      type: 'error',
      meetingId: context.meetingId,
      message,
      meeting: getMeetingDetail(context.meetingId)
    })
  } finally {
    releaseAllActiveClaims(context.meetingId)
    activeBuilds.delete(context.meetingId)
  }
}

export function startBuildEngine(
  sender: WebContents,
  meetingId: string,
  options: { resume?: boolean } = {}
): MeetingSummary {
  if (activeBuilds.has(meetingId)) {
    throw new AppError('MEETING_ACTIVE', 'This Build meeting is already running.')
  }
  const meeting = meetingSummary(meetingId)
  if (meeting.mode !== 'build') {
    throw new AppError('MEETING_MODE_INVALID', 'This is not a Build meeting.')
  }
  const meetingDetail = getMeetingDetail(meetingId)
  const settings = loadSettings()
  const requiredAgents = new Set(
    meetingDetail.tasks
      .map((task) => task.assigneeAgentId)
      .filter((id): id is string => Boolean(id))
  )
  requiredAgents.add(meetingDetail.meeting.coordinatorAgentId)
  requiredAgents.add(qaAgent(meetingParticipants(meetingId), coordinatorAgent(meetingId)).id)
  const missingTools = meetingParticipants(meetingId)
    .filter((agent) => requiredAgents.has(agent.id))
    .filter((agent) => !agentCanUseTools(agent, settings))
    .map((agent) => agent.name)
  if (missingTools.length > 0) {
    throw new AppError(
      'AGENT_TOOLS_REQUIRED',
      `Assign a tool-capable model to: ${missingTools.join(', ')}. Their current model cannot call file, shell, or coordination tools, so Build cannot create files.`
    )
  }
  const interrupted = ['building', 'reviewing', 'reporting'].includes(meeting.status)
  if (
    !options.resume &&
    meeting.status !== 'draft' &&
    !(meeting.status === 'stopped' && meeting.stopReason === 'paused')
  ) {
    throw new AppError('MEETING_NOT_READY', 'This Build meeting has already run.')
  }
  if (
    options.resume &&
    !interrupted &&
    !(meeting.status === 'stopped' && meeting.stopReason === 'paused')
  ) {
    throw new AppError('MEETING_NOT_INTERRUPTED', 'This Build meeting has nothing to resume.')
  }
  releaseAllActiveClaims(meetingId)
  clearMeetingFinalReport(meetingId)
  const lease = resumableLease(meetingId)
  const checkpoint =
    options.resume
      ? lease?.checkpoint ?? meetingCheckpoint(meetingId) ?? defaultCheckpoint()
      : defaultCheckpoint()
  const leaseId = lease?.id ?? createRunLease({
    kind: 'build',
    sessionId: meetingSessionId(meetingId),
    meetingId,
    checkpoint
  })
  const controller = new AbortController()
  const active: ActiveBuild = {
    controller,
    sender,
    stopReason: null
  }
  activeBuilds.set(meetingId, active)
  const detail = getMeetingDetail(meetingId)
  const context: BuildContext = {
    meetingId,
    sessionId: meetingSessionId(meetingId),
    goal: meeting.goal,
    sender,
    controller,
    budget: meeting.budget,
    startedAt: Date.now(),
    usage: meeting.usage,
    plan: detail.plan,
    tasks: detail.tasks,
    reviewResults: [...checkpoint.reviewResults],
    processIds: new Set<string>(),
    stopSignalReason: () => (active.stopReason ? active.stopReason : 'user'),
    leaseId,
    checkpoint,
    agentLocks: new Map<string, Promise<void>>()
  }
  void runBuild(context)
  return meetingSummary(meetingId)
}

export function stopBuildEngine(meetingId: string, reason: 'user' | 'paused'): MeetingSummary {
  const active = activeBuilds.get(meetingId)
  if (active) {
    active.stopReason = reason
    active.controller.abort()
    cancelApprovalsForSession(meetingSessionId(meetingId))
  }
  return meetingSummary(meetingId)
}

export function cancelAllBuildRuns(): void {
  for (const active of activeBuilds.values()) {
    active.stopReason = 'user'
    active.controller.abort()
  }
  activeBuilds.clear()
}

export function isBuildActive(meetingId: string): boolean {
  return activeBuilds.has(meetingId)
}

export async function queueBuildInterrupt(input: {
  sender: WebContents
  meetingId: string
  text: string
  mode: 'queue' | 'immediate'
}): Promise<MeetingSummary> {
  const detail = getMeetingDetail(input.meetingId)
  if (detail.meeting.mode !== 'build') {
    throw new AppError('MEETING_MODE_INVALID', 'Interrupts are available in Build meetings.')
  }
  const message = appendMeetingMessage({
    meetingId: input.meetingId,
    senderType: 'boss',
    senderAgentId: null,
    senderName: 'Boss',
    targetAgentId: null,
    kind: 'interrupt',
    content: input.text.trim(),
    metadata: { phase: 'interrupt', round: 0, status: 'done' }
  })
  emit(input.sender, {
    type: 'message',
    meetingId: input.meetingId,
    message,
    meeting: meetingSummary(input.meetingId)
  })
  if (input.mode === 'immediate') {
    const active = activeBuilds.get(input.meetingId)
    if (active) {
      active.stopReason = 'paused'
      active.controller.abort()
      cancelApprovalsForSession(meetingSessionId(input.meetingId))
    }
  }
  await delay(0)
  return meetingSummary(input.meetingId)
}
