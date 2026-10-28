import { randomUUID } from 'node:crypto'
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
  type MeetingEvent,
  type MeetingFinalReport,
  type MeetingMessage,
  type MeetingMessageMetadata,
  type MeetingPlan,
  type MeetingReportTask,
  type MeetingStatus,
  type MeetingSummary,
  type MeetingTask,
  type MeetingTaskStatus,
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
import { listChanges } from '../changes/changeService'
import { stopManagedProcess } from '../commands/commandRunner'
import {
  activeMeetingClaims,
  appendMeetingMessage,
  approvalSummaryForSession,
  assertTaskWriteAllowed,
  beginMeetingMessage,
  clearMeetingFinalReport,
  coordinatorAgent,
  createTaskClaims,
  getMeetingDetail,
  markMeetingDeliveriesProcessed,
  meetingParticipants,
  meetingSessionId,
  meetingSummary,
  meetingTitle,
  recordMeetingTurn,
  recordMeetingUsage,
  releaseAllActiveClaims,
  releaseTaskClaims,
  setMeetingBuildState,
  setMeetingFinalReport,
  setMeetingStatus,
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
}

type TurnResult = {
  message: MeetingMessage
  text: string
  usage: ChatUsage
  cancelled: boolean
  toolTraces: ChatToolTrace[]
  durationMs: number
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

function toolBundleFor(input: {
  agent: AgentConfig
  root: string
  sessionId: string
  meetingId: string
  taskId: string | null
  turnId: string
  sender: WebContents
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
        turnId,
        sender: context.sender
      })
    : { tools: {}, definitions: [], names: [], warnings: [] }
  const toolsAvailable = withTools && toolBundle.names.length > 0
  const allMessages = getMeetingDetail(context.meetingId).messages
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
        maxReviewCycles: 2
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
      maxOutputTokens: phase === 'report' ? 2_500 : phase === 'review' ? 1_500 : 4_000,
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
    const content = fullText.trim() || (context.controller.signal.aborted ? 'Stopped.' : 'No response.')
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
      durationMs
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
        durationMs
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

function orderTasks(tasks: MeetingTask[]): MeetingTask[] {
  const byTitle = new Map(tasks.map((task) => [task.title, task]))
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const remaining = new Set(tasks.map((task) => task.id))
  const ordered: MeetingTask[] = []
  let guard = 0
  while (remaining.size > 0 && guard < tasks.length * 3) {
    guard += 1
    let progressed = false
    for (const task of tasks) {
      if (!remaining.has(task.id)) {
        continue
      }
      const dependencies = task.dependsOn
        .map((dependency) => byTitle.get(dependency) ?? byId.get(dependency))
        .filter((dependency): dependency is MeetingTask => Boolean(dependency))
      const ready = dependencies.every(
        (dependency) => dependency.status === 'done' || !remaining.has(dependency.id)
      )
      if (ready) {
        ordered.push(task)
        remaining.delete(task.id)
        progressed = true
      }
    }
    if (!progressed) {
      break
    }
  }
  for (const task of tasks) {
    if (remaining.has(task.id)) {
      ordered.push(task)
    }
  }
  return ordered
}

function emitTask(context: BuildContext, task: MeetingTask): void {
  emit(context.sender, {
    type: 'task',
    meetingId: context.meetingId,
    task,
    meeting: meetingSummary(context.meetingId)
  })
}

function transition(
  context: BuildContext,
  task: MeetingTask,
  status: MeetingTaskStatus,
  input: { agentId?: string | null; note?: string; type?: string; incrementReview?: boolean } = {}
): MeetingTask {
  const updated = transitionMeetingTask({
    taskId: task.id,
    status,
    agentId: input.agentId,
    note: input.note,
    type: input.type,
    incrementReview: input.incrementReview
  })
  context.tasks = context.tasks.map((entry) => (entry.id === updated.id ? updated : entry))
  emitTask(context, updated)
  return updated
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
      log.warn('Could not stop a Build background process', {
        meetingId: context.meetingId,
        processId,
        error
      })
    }
  }
  context.processIds.clear()
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

async function runBuild(context: BuildContext): Promise<void> {
  const agents = meetingParticipants(context.meetingId)
  const coordinator = coordinatorAgent(context.meetingId)
  const reviewer = qaAgent(agents, coordinator)
  const planTasks = orderTasks(context.tasks)

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
    appendMeetingMessage({
      meetingId: context.meetingId,
      senderType: 'agent',
      senderAgentId: coordinator.id,
      senderName: coordinator.name,
      targetAgentId: null,
      kind: 'dispatch',
      content: [
        `Build dispatched with ${planTasks.length} tasks and ${context.budget.maxReviewCycles} review cycles.`,
        'Tasks run one at a time. Each task gets an active file claim before execution.'
      ].join(' '),
      metadata: { phase: 'build', round: 1, status: 'done' }
    })

    let taskIndex = 0
    for (const queued of planTasks) {
      if (context.controller.signal.aborted) {
        stopCurrentBuild(context, context.stopSignalReason())
        return
      }
      const current = context.tasks.find((task) => task.id === queued.id) ?? queued
      if (current.status === 'done' || current.status === 'blocked') {
        continue
      }
      const dependencies = current.dependsOn
        .map((dependency) =>
          context.tasks.find(
            (task) => task.title === dependency || task.id === dependency
          )
        )
        .filter((task): task is MeetingTask => Boolean(task))
      const blockedDependency = dependencies.find((task) => task.status !== 'done')
      if (blockedDependency) {
        transition(
          context,
          current,
          'blocked',
          {
            note: `Blocked by ${blockedDependency.title} (${blockedDependency.status}).`,
            type: 'blocked'
          }
        )
        continue
      }

      taskIndex += 1
      const implementer = agentForTask(agents, current, coordinator)
      let working = transition(context, current, 'in_progress', {
        agentId: implementer.id,
        note: `${implementer.name} started the task.`,
        type: 'start'
      })
      setMeetingBuildState(context.meetingId, {
        taskId: working.id,
        phase: 'build',
        taskIndex
      })

      let review: ReviewResult | null = null
      let approved = false
      let reviewCycle = 0

      try {
        createTaskClaims({
          meetingId: context.meetingId,
          task: working,
          agent: implementer
        })
        const buildTurn = await runBuildTurn({
          context,
          agent: implementer,
          phase: 'build',
          round: 1,
          kind: 'build',
          task: working,
          withTools: true,
          userText: `Implement this Build task. Stay inside the active claim.\n\nTask: ${working.title}\n${working.description}\n\nAcceptance: ${working.acceptanceCriteria ?? 'not supplied'}`
        })
        addUsage(context, buildTurn, 1)
        if (buildTurn.cancelled) {
          stopCurrentBuild(context, context.stopSignalReason())
          return
        }
        if (budgetExceeded(context)) {
          finishBuild({
            context,
            status: 'stopped',
            stopReason: 'budget',
            summary: 'Build stopped because a meeting budget limit was reached. Partial work is recorded.',
            partial: true
          })
          return
        }
      } catch (error) {
        releaseTaskClaims(context.meetingId, working.id)
        transition(context, working, 'blocked', {
          agentId: implementer.id,
          note: error instanceof Error ? error.message : String(error),
          type: 'failed'
        })
        continue
      }

      releaseTaskClaims(context.meetingId, working.id)
      working = transition(context, working, 'review', {
        agentId: reviewer.id,
        note: `${reviewer.name} is reviewing the task.`,
        type: 'review-start'
      })

      while (!approved && reviewCycle < context.budget.maxReviewCycles) {
        reviewCycle += 1
        if (context.controller.signal.aborted) {
          stopCurrentBuild(context, context.stopSignalReason())
          return
        }
        try {
          createTaskClaims({
            meetingId: context.meetingId,
            task: working,
            agent: reviewer,
            globs: reviewer.permissions.writeGlobs
          })
          const reviewTurn = await runBuildTurn({
            context,
            agent: reviewer,
            phase: 'review',
            round: 2 + reviewCycle,
            kind: 'review',
            task: working,
            withTools: true,
            reviewRound: reviewCycle,
            userText: `Review this completed task and return the required JSON review.\n\nTask: ${working.title}\n${working.description}\n\nAcceptance: ${working.acceptanceCriteria ?? 'not supplied'}`
          })
          addUsage(context, reviewTurn, 2 + reviewCycle)
          if (reviewTurn.cancelled) {
            stopCurrentBuild(context, context.stopSignalReason())
            return
          }
          review = reviewResult(reviewTurn.text)
        } catch (error) {
          review = {
            status: 'changes_requested',
            summary: error instanceof Error ? error.message : String(error),
            issues: ['The QA review could not complete.'],
            testsRun: [],
            testsPassed: false
          }
        } finally {
          releaseTaskClaims(context.meetingId, working.id)
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
        if (review.status === 'approved') {
          approved = true
          transition(context, working, 'done', {
            agentId: reviewer.id,
            note: review.summary,
            type: 'approved'
          })
          break
        }

        if (reviewCycle >= context.budget.maxReviewCycles) {
          transition(context, working, 'blocked', {
            agentId: reviewer.id,
            note: `Review limit reached. ${review.summary}`,
            type: 'blocked'
          })
          break
        }

        working = transition(context, working, 'changes_requested', {
          agentId: implementer.id,
          note: review.issues.join('; ') || review.summary,
          type: 'changes-requested',
          incrementReview: true
        })
        if (context.controller.signal.aborted) {
          stopCurrentBuild(context, context.stopSignalReason())
          return
        }
        try {
          createTaskClaims({
            meetingId: context.meetingId,
            task: working,
            agent: implementer
          })
          const fixTurn = await runBuildTurn({
            context,
            agent: implementer,
            phase: 'build',
            round: 2 + reviewCycle,
            kind: 'build',
            task: working,
            withTools: true,
            userText: `QA requested changes. Fix only these issues inside the active claim.\n\nTask: ${working.title}\n${review.issues.map((issue) => `- ${issue}`).join('\n') || review.summary}`
          })
          addUsage(context, fixTurn, 2 + reviewCycle)
          if (fixTurn.cancelled) {
            stopCurrentBuild(context, context.stopSignalReason())
            return
          }
          if (budgetExceeded(context)) {
            finishBuild({
              context,
              status: 'stopped',
              stopReason: 'budget',
              summary: 'Build stopped because a meeting budget limit was reached.',
              partial: true
            })
            return
          }
        } catch (error) {
          transition(context, working, 'blocked', {
            agentId: implementer.id,
            note: error instanceof Error ? error.message : String(error),
            type: 'failed'
          })
          break
        } finally {
          releaseTaskClaims(context.meetingId, working.id)
        }
        working = transition(context, working, 'review', {
          agentId: reviewer.id,
          note: `Review cycle ${reviewCycle + 1}.`,
          type: 'review-start'
        })
      }

      if (!approved) {
        const latest = context.tasks.find((task) => task.id === working.id)
        if (latest?.status !== 'blocked') {
          transition(context, latest ?? working, 'blocked', {
            agentId: reviewer.id,
            note: 'The task did not receive an approved review.',
            type: 'blocked'
          })
        }
      }
      if (budgetExceeded(context)) {
        finishBuild({
          context,
          status: 'stopped',
          stopReason: 'budget',
          summary: 'Build stopped because a meeting budget limit was reached.',
          partial: true
        })
        return
      }
    }

    if (context.controller.signal.aborted) {
      stopCurrentBuild(context, context.stopSignalReason())
      return
    }

    setMeetingStatus({ meetingId: context.meetingId, status: 'reporting' })
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
        userText: 'Write the final Build report for the Boss from the task board, change log, approvals, and reviews.'
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

export function startBuildEngine(sender: WebContents, meetingId: string): MeetingSummary {
  if (activeBuilds.has(meetingId)) {
    throw new AppError('MEETING_ACTIVE', 'This Build meeting is already running.')
  }
  const meeting = meetingSummary(meetingId)
  if (meeting.mode !== 'build') {
    throw new AppError('MEETING_MODE_INVALID', 'This is not a Build meeting.')
  }
  if (meeting.status !== 'draft' && !(meeting.status === 'stopped' && meeting.stopReason === 'paused')) {
    throw new AppError('MEETING_NOT_READY', 'This Build meeting has already run.')
  }
  releaseAllActiveClaims(meetingId)
  clearMeetingFinalReport(meetingId)
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
    reviewResults: [],
    processIds: new Set<string>(),
    stopSignalReason: () => (active.stopReason ? active.stopReason : 'user')
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
