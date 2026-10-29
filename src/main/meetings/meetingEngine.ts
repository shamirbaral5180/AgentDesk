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
  type MeetingIntakeCard,
  type MeetingCheckpoint,
  type MeetingMessage,
  type MeetingMessageMetadata,
  type MeetingParticipant,
  type MeetingPlan,
  type MeetingPlanDecision,
  type MeetingPlanFileClaim,
  type MeetingPlanTask,
  type MeetingSummary,
  type MeetingUsage,
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
import { agentCanUseTools, compileMeetingPrompt } from '../chat/promptCompiler'
import { createAgentTools, type AgentToolBundle } from '../chat/projectTools'
import { buildMcpToolBundle, mergeToolBundles } from '../mcp/mcpAgentTools'
import { retrieveMemoryContext } from '../memory/memoryService'
import {
  createRunLease,
  finishRunLease,
  heartbeatRunLease,
  meetingCheckpoint,
  resumableLease
} from '../recovery/runLeaseService'
import {
  appendMeetingMessage,
  beginMeetingMessage,
  coordinatorAgent,
  getMeetingDetail,
  markMeetingDeliveriesProcessed,
  meetingParticipants,
  meetingPlan,
  meetingSessionId,
  meetingSummary,
  persistPlan,
  recordMeetingTurn,
  recordMeetingUsage,
  setMeetingPlan,
  setMeetingRound,
  setMeetingStatus,
  updateMeetingMessage,
  updateMeetingUsage
} from './meetingStore'

const log = createLogger('meeting')

type ActiveMeeting = {
  controller: AbortController
  sender: WebContents
  stopReason: 'user' | 'paused' | null
}

const activeMeetings = new Map<string, ActiveMeeting>()

type TurnResult = {
  message: MeetingMessage
  text: string
  usage: ChatUsage
  cancelled: boolean
  toolTraces: ChatToolTrace[]
  durationMs: number
}

type MeetingContext = {
  meetingId: string
  sessionId: string
  goal: string
  sender: WebContents
  controller: AbortController
  budget: MeetingSummary['budget']
  startedAt: number
  usage: MeetingUsage
  lastText: string
  emptyTurns: number
  stopSignalReason: () => 'user' | 'paused'
  leaseId: string
  checkpoint: MeetingCheckpoint
}

function defaultCheckpoint(): MeetingCheckpoint {
  return {
    phase: 'intake',
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

function saveCheckpoint(context: MeetingContext): void {
  context.checkpoint = { ...context.checkpoint, updatedAt: Date.now() }
  heartbeatRunLease(context.leaseId, context.checkpoint)
}

function emit(sender: WebContents, event: MeetingEvent): void {
  if (!sender.isDestroyed()) {
    sender.send(IPC_CHANNELS.meetingEvent, event)
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
  if (!provider) {
    throw new AppError(
      'PROVIDER_NOT_FOUND',
      `The provider for ${agent.name} no longer exists.`
    )
  }
  if (!provider.enabled) {
    throw new AppError(
      'PROVIDER_DISABLED',
      `Enable ${provider.name} before running a meeting.`
    )
  }
  return { model, provider }
}

function modelLabelFor(agent: AgentConfig): string {
  return agent.model
    ? `${agent.model.providerType} / ${agent.model.modelId}`
    : 'No model assigned'
}

function participantFor(
  participants: MeetingParticipant[],
  agentId: string
): MeetingParticipant | null {
  return participants.find((participant) => participant.agentId === agentId) ?? null
}

function transcript(
  messages: MeetingMessage[],
  maxChars = 24_000,
  includeBoss = true
): string {
  const relevant = messages.filter(
    (message) =>
      message.content.trim() &&
      message.metadata?.status !== 'streaming' &&
      (includeBoss || message.senderType !== 'boss')
  )
  const parts: string[] = []
  let used = 0
  for (const message of relevant) {
    const header = `[${message.metadata?.phase ?? message.kind} r${message.metadata?.round ?? 0}] ${message.senderName}:`
    const body = clampText(message.content.trim(), 3_200)
    const piece = `${header}\n${body}`
    if (used + piece.length > maxChars) {
      parts.push('[Older transcript omitted]')
      break
    }
    used += piece.length
    parts.push(piece)
  }
  return parts.join('\n\n')
}

function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('No JSON object found in the response')
  }
  return JSON.parse(candidate.slice(start, end + 1)) as unknown
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
}

function intakeCardFromText(text: string): MeetingIntakeCard {
  try {
    const parsed = extractJsonObject(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Intake card was not an object')
    }
    const raw = parsed as Record<string, unknown>
    return {
      understanding: stringValue(raw.understanding, clampText(text.trim(), 1_500)),
      concerns: stringArray(raw.concerns),
      files: stringArray(raw.files),
      risks: stringArray(raw.risks),
      approach: stringValue(raw.approach, 'Inspect the relevant files and validate the approach.')
    }
  } catch {
    return {
      understanding: clampText(text.trim() || 'No intake response was produced.', 1_500),
      concerns: [],
      files: [],
      risks: [],
      approach: 'The agent did not return a structured intake card.'
    }
  }
}

function participantIds(participants: MeetingParticipant[]): Set<string> {
  return new Set(participants.map((participant) => participant.agentId))
}

function normalizePlan(input: {
  text: string
  participants: MeetingParticipant[]
  coordinatorId: string
  goal: string
}): MeetingPlan {
  const { text, participants, coordinatorId, goal } = input
  const ids = participantIds(participants)
  const raw = extractJsonObject(text)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Plan was not an object')
  }
  const value = raw as Record<string, unknown>
  const rawTasks = Array.isArray(value.tasks) ? value.tasks : []
  const tasks: MeetingPlanTask[] = []
  for (const entry of rawTasks) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue
    }
    const task = entry as Record<string, unknown>
    const title = stringValue(task.title)
    if (!title) {
      continue
    }
    const requestedAssignee =
      stringValue(task.assigneeAgentId) ||
      stringValue(task.assignee) ||
      stringValue(task.owner) ||
      coordinatorId
    const assigneeAgentId = ids.has(requestedAssignee) ? requestedAssignee : coordinatorId
    const fileGlobs = stringArray(task.fileGlobs)
    const files = stringArray(task.files)
    const dependsOn = stringArray(task.dependsOn)
    tasks.push({
      title,
      description:
        stringValue(task.description) ||
        'Deliver the change described by the Coordinator plan.',
      assigneeAgentId,
      acceptanceCriteria:
        stringValue(task.acceptanceCriteria) ||
        'The Boss can verify the requested behavior and the repository checks pass.',
      fileGlobs: fileGlobs.length > 0 ? fileGlobs : files,
      dependsOn,
      priority:
        typeof task.priority === 'number' ? Math.min(Math.max(task.priority, 1), 3) : 2
    })
  }
  if (tasks.length === 0) {
    throw new Error('Plan contained no tasks')
  }

  const rawDecisions = Array.isArray(value.decisions) ? value.decisions : []
  const decisions: MeetingPlanDecision[] = rawDecisions
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return null
      }
      const decision = entry as Record<string, unknown>
      const title = stringValue(decision.title)
      const chosen = stringValue(decision.decision)
      if (!title || !chosen) {
        return null
      }
      return {
        title,
        context: stringValue(decision.context, goal),
        decision: chosen,
        rationale: stringValue(decision.rationale)
      }
    })
    .filter((entry): entry is MeetingPlanDecision => Boolean(entry))

  const rawClaims = Array.isArray(value.fileClaims) ? value.fileClaims : []
  const fileClaims: MeetingPlanFileClaim[] = rawClaims
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return null
      }
      const claim = entry as Record<string, unknown>
      const requestedAgent = stringValue(claim.agentId) || stringValue(claim.agent)
      const pathPrefix = stringValue(claim.pathPrefix) || stringValue(claim.path)
      if (!pathPrefix) {
        return null
      }
      return {
        agentId: ids.has(requestedAgent) ? requestedAgent : coordinatorId,
        pathPrefix,
        scope: stringValue(claim.scope, 'proposed') || 'explicit'
      }
    })
    .filter((entry): entry is MeetingPlanFileClaim => Boolean(entry))

  return {
    summary: stringValue(value.summary, goal),
    approach: stringValue(value.approach, 'Execute the tasks in dependency order.'),
    tasks,
    decisions,
    fileClaims,
    risks: stringArray(value.risks),
    acceptanceCriteria: stringArray(value.acceptanceCriteria),
    generatedAt: Date.now(),
    fallback: false
  }
}

function fallbackPlan(input: {
  goal: string
  participants: MeetingParticipant[]
  coordinatorId: string
  intakeCards: Map<string, MeetingIntakeCard>
}): MeetingPlan {
  const { goal, participants, coordinatorId, intakeCards } = input
  const tasks: MeetingPlanTask[] = []
  const claims: MeetingPlanFileClaim[] = []
  for (const participant of participants) {
    if (participant.agentId === coordinatorId) {
      continue
    }
    const card = intakeCards.get(participant.agentId)
    tasks.push({
      title: `Apply ${participant.roleKey} findings`,
      description: card
        ? `${card.understanding}\n\nApproach: ${card.approach}`
        : `Deliver the ${participant.roleKey} portion of the plan.`,
      assigneeAgentId: participant.agentId,
      acceptanceCriteria: card?.concerns.length
        ? `Address: ${card.concerns.join('; ')}`
        : 'The assigned work is implemented and reviewed.',
      fileGlobs: card?.files ?? [],
      dependsOn: [],
      priority: 2
    })
    for (const file of card?.files ?? []) {
      claims.push({
        agentId: participant.agentId,
        pathPrefix: file,
        scope: 'proposed'
      })
    }
  }
  if (tasks.length === 0) {
    tasks.push({
      title: 'Deliver the requested change',
      description: goal,
      assigneeAgentId: coordinatorId,
      acceptanceCriteria: 'The Boss can verify the requested behavior.',
      fileGlobs: [],
      dependsOn: [],
      priority: 2
    })
  }
  return {
    summary: `Plan for: ${goal}`,
    approach:
      'Proceed sequentially, inspect the claimed files first, implement small changes, then run the relevant checks.',
    tasks,
    decisions: [
      {
        title: 'Use a sequential, read-first plan',
        context: goal,
        decision: 'Start with repository inspection and one owner per task.',
        rationale: 'The meeting did not return a valid structured plan, so the deterministic fallback is used.'
      }
    ],
    fileClaims: claims,
    risks: ['The Coordinator response could not be parsed as a structured plan.'],
    acceptanceCriteria: ['The requested work is implemented and the Boss can review it.'],
    generatedAt: Date.now(),
    fallback: true
  }
}

function turnMetadata(input: {
  phase: MeetingMessageMetadata['phase']
  round: number
  turnId: string
  status: MeetingMessageMetadata['status']
  usage?: ChatUsage
  durationMs?: number
  toolCalls?: ChatToolTrace[]
  card?: MeetingIntakeCard
  error?: string
}): MeetingMessageMetadata {
  return {
    phase: input.phase,
    round: input.round,
    turnId: input.turnId,
    status: input.status,
    usage: input.usage,
    durationMs: input.durationMs,
    toolCalls: input.toolCalls,
    card: input.card,
    error: input.error
  }
}

function toolBundleFor(input: {
  agent: AgentConfig
  root: string
  sessionId: string
  runId: string
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
    mode: 'plan' as const,
    sessionId: input.sessionId,
    runId: input.runId,
    agentId: input.agent.id,
    requestApproval: async () => {
      throw new Error('Approvals are unavailable in a read-only Plan meeting.')
    },
    emitOutput: () => {
      return
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
      mode: 'plan'
    })
  )
}

async function runTurn(input: {
  context: MeetingContext
  agent: AgentConfig
  participants: MeetingParticipant[]
  phase: MeetingMessageMetadata['phase']
  round: number
  kind: string
  userText: string
  withTools: boolean
}): Promise<TurnResult> {
  const { context, agent, participants, phase, round, kind, userText, withTools } = input
  const root = getCurrentProjectRoot()
  if (!root) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }
  const { model, provider } = resolveModel(agent)
  const settings = loadSettings()
  const memory = retrieveMemoryContext({
    agentId: agent.id,
    sessionId: context.sessionId,
    query: `${context.goal}\n${userText}`,
    limit: 5
  })
  const turnId = randomUUID()
  const toolBundle = withTools
    ? toolBundleFor({
        agent,
        root,
        sessionId: context.sessionId,
        runId: turnId,
        sender: context.sender
      })
    : { tools: {}, definitions: [], names: [], warnings: [] }
  const toolsAvailable = withTools && toolBundle.names.length > 0
  const allMessages = getMeetingDetail(context.meetingId).messages
  markMeetingDeliveriesProcessed(context.meetingId, agent.id)
  const prompt = compileMeetingPrompt({
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
    round,
    participants,
    historyText: transcript(allMessages, phase === 'intake' ? 8_000 : 24_000),
    memory,
    toolsAvailable,
    toolNames: toolBundle.names,
    modelLabel: modelLabelFor(agent)
  })

  const startedAt = Date.now()
  const streaming = beginMeetingMessage({
    meetingId: context.meetingId,
    senderType: 'agent',
    senderAgentId: agent.id,
    senderName: agent.name,
    targetAgentId: null,
    kind,
    metadata: turnMetadata({
      phase,
      round,
      turnId,
      status: 'streaming'
    })
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
      messages: [{ role: 'user', content: userText || `Proceed with the ${phase} turn.` }],
      maxOutputTokens:
        phase === 'planning' ? 4_000 : phase === 'intake' ? 1_200 : phase === 'discussion' ? 1_000 : 1_600,
      temperature: Math.min(Math.max(agent.model?.temperature ?? 0.2, 0), 2),
      maxRetries: 0,
      timeout: 120_000,
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
        emit(context.sender, {
          type: 'message',
          meetingId: context.meetingId,
          message: {
            ...streaming,
            metadata: turnMetadata({
              phase,
              round,
              turnId,
              status: 'streaming',
              toolCalls: [...toolTraces]
            })
          },
          meeting: meetingSummary(context.meetingId)
        })
        continue
      }
      if (part.type === 'tool-result') {
        const trace = toolTraces.find((entry) => entry.toolCallId === part.toolCallId)
        if (trace) {
          trace.status = 'done'
          trace.output = part.output
          trace.durationMs = Date.now() - (toolStarts.get(part.toolCallId) ?? Date.now())
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
      metadata: turnMetadata({
        phase,
        round,
        turnId,
        status: context.controller.signal.aborted ? 'cancelled' : 'done',
        usage,
        durationMs,
        toolCalls: toolTraces
      })
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
      metadata: turnMetadata({
        phase,
        round,
        turnId,
        status: cancelled ? 'cancelled' : 'error',
        usage,
        durationMs,
        toolCalls: toolTraces,
        error: message
      })
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

function addUsage(context: MeetingContext, turn: TurnResult, round: number): void {
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

function budgetStopReason(context: MeetingContext, round: number): 'budget' | null {
  const { usage, budget } = context
  const totalTokens = usage.inputTokens + usage.outputTokens
  if (
    round > budget.maxRounds ||
    usage.turns >= budget.maxTurns ||
    usage.messages >= budget.maxMessages ||
    totalTokens >= budget.maxTokens ||
    usage.costUsd >= budget.maxCostUsd ||
    usage.elapsedMs >= budget.maxMinutes * 60_000
  ) {
    return 'budget'
  }
  return null
}

function stopResult(
  context: MeetingContext,
  reason: 'user' | 'paused' | 'budget' | 'no-progress' | 'repetition'
): void {
  setMeetingStatus({
    meetingId: context.meetingId,
    status: 'stopped',
    stopReason: reason,
    ended: true
  })
  finishRunLease(context.leaseId, 'stopped')
  const detail = getMeetingDetail(context.meetingId)
  emit(context.sender, {
    type: 'cancelled',
    meetingId: context.meetingId,
    meeting: detail
  })
}

function finishResult(context: MeetingContext): void {
  setMeetingStatus({
    meetingId: context.meetingId,
    status: 'completed',
    stopReason: 'completed',
    ended: true
  })
  finishRunLease(context.leaseId, 'completed')
  const detail = getMeetingDetail(context.meetingId)
  emit(context.sender, {
    type: 'done',
    meetingId: context.meetingId,
    meeting: detail
  })
}

function failMeeting(context: MeetingContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  setMeetingStatus({
    meetingId: context.meetingId,
    status: 'failed',
    stopReason: 'error',
    error: message,
    ended: true
  })
  finishRunLease(context.leaseId, 'stopped')
  const detail = getMeetingDetail(context.meetingId)
  emit(context.sender, {
    type: 'error',
    meetingId: context.meetingId,
    message,
    meeting: detail
  })
}

function checkTurnProgress(context: MeetingContext, turn: TurnResult): void {
  const normalized = normalizeText(turn.text)
  if (!normalized) {
    context.emptyTurns += 1
  } else {
    context.emptyTurns = 0
  }
  if (context.emptyTurns >= 2) {
    throw new AppError('MEETING_NO_PROGRESS', 'The meeting stopped because two turns produced no output.')
  }
  if (normalized.length > 80 && normalized === context.lastText) {
    throw new AppError('MEETING_REPETITION', 'The meeting stopped because an agent repeated the previous turn.')
  }
  context.lastText = normalized
}

function cardsFromMessages(meetingId: string): Map<string, MeetingIntakeCard> {
  const cards = new Map<string, MeetingIntakeCard>()
  const messages = getMeetingDetail(meetingId).messages
  for (const message of messages) {
    if (
      message.senderAgentId &&
      message.metadata?.phase === 'intake' &&
      message.metadata.card
    ) {
      cards.set(message.senderAgentId, message.metadata.card)
    }
  }
  return cards
}

async function runMeeting(context: MeetingContext): Promise<void> {
  const meeting = meetingSummary(context.meetingId)
  const participants = meeting.participants
  const agents = meetingParticipants(context.meetingId)
  const coordinator = coordinatorAgent(context.meetingId)
  const intakeCards = cardsFromMessages(context.meetingId)
  const completedIntake = new Set(context.checkpoint.completedIntakeAgentIds)
  const completedDiscussion = new Set(context.checkpoint.completedDiscussionAgentIds)

  try {
    setMeetingStatus({
      meetingId: context.meetingId,
      status: 'intake',
      stopReason: null,
      started: true
    })
    emit(context.sender, {
      type: 'meeting-start',
      meeting: meetingSummary(context.meetingId)
    })

    setMeetingRound(context.meetingId, 1)
    for (const agent of agents) {
      if (completedIntake.has(agent.id)) {
        continue
      }
      if (context.controller.signal.aborted) {
        stopResult(context, context.stopSignalReason())
        return
      }
      const turn = await runTurn({
        context,
        agent,
        participants,
        phase: 'intake',
        round: 1,
        kind: 'intake',
        userText: 'Submit your structured intake card for this meeting.',
        withTools: agent.id !== coordinator.id
      })
      addUsage(context, turn, 1)
      if (turn.cancelled) {
        stopResult(context, context.stopSignalReason())
        return
      }
      const card = intakeCardFromText(turn.text)
      intakeCards.set(agent.id, card)
      context.checkpoint.phase = 'intake'
      context.checkpoint.round = 1
      context.checkpoint.completedIntakeAgentIds = [
        ...new Set([...context.checkpoint.completedIntakeAgentIds, agent.id])
      ]
      saveCheckpoint(context)
      updateMeetingMessage({
        messageId: turn.message.id,
        content: turn.text,
        metadata: turnMetadata({
          phase: 'intake',
          round: 1,
          turnId: turn.message.metadata?.turnId ?? turn.message.id,
          status: 'done',
          usage: turn.usage,
          durationMs: turn.durationMs,
          toolCalls: turn.toolTraces,
          card
        })
      })
      const budgetReason = budgetStopReason(context, 1)
      if (budgetReason) {
        stopResult(context, budgetReason)
        return
      }
      checkTurnProgress(context, turn)
    }

    setMeetingStatus({ meetingId: context.meetingId, status: 'discussion' })
    setMeetingRound(context.meetingId, 2)
    const discussionOrder = [
      coordinator,
      ...agents.filter((agent) => agent.id !== coordinator.id)
    ]
    context.checkpoint.phase = 'discussion'
    context.checkpoint.round = 2
    saveCheckpoint(context)
    for (const agent of discussionOrder) {
      if (completedDiscussion.has(agent.id)) {
        continue
      }
      if (context.controller.signal.aborted) {
        stopResult(context, context.stopSignalReason())
        return
      }
      const turn = await runTurn({
        context,
        agent,
        participants,
        phase: 'discussion',
        round: 2,
        kind: 'discussion',
        userText: agent.id === coordinator.id
          ? 'Open the discussion: synthesize the intake cards and identify the key tradeoffs.'
          : 'Respond to the intake cards and the discussion so far.',
        withTools: true
      })
      addUsage(context, turn, 2)
      if (turn.cancelled) {
        stopResult(context, context.stopSignalReason())
        return
      }
      context.checkpoint.completedDiscussionAgentIds = [
        ...new Set([...context.checkpoint.completedDiscussionAgentIds, agent.id])
      ]
      saveCheckpoint(context)
      const budgetReason = budgetStopReason(context, 2)
      if (budgetReason) {
        stopResult(context, budgetReason)
        return
      }
      checkTurnProgress(context, turn)
    }

    setMeetingStatus({ meetingId: context.meetingId, status: 'planning' })
    setMeetingRound(context.meetingId, 3)
    context.checkpoint.phase = 'planning'
    context.checkpoint.round = 3
    context.checkpoint.planningStarted = true
    saveCheckpoint(context)
    if (context.checkpoint.planProduced || meetingPlan(context.meetingId)) {
      context.checkpoint.phase = 'done'
      context.checkpoint.planProduced = true
      saveCheckpoint(context)
      finishResult(context)
      return
    }
    const planningTurn = await runTurn({
      context,
      agent: coordinator,
      participants,
      phase: 'planning',
      round: 3,
      kind: 'plan',
      userText: 'Produce the final structured plan as the JSON object requested in your instructions.',
      withTools: false
    })
    addUsage(context, planningTurn, 3)
    if (planningTurn.cancelled) {
      stopResult(context, context.stopSignalReason())
      return
    }
    const budgetReason = budgetStopReason(context, 3)
    if (budgetReason) {
      stopResult(context, budgetReason)
      return
    }

    let plan: MeetingPlan
    try {
      plan = normalizePlan({
        text: planningTurn.text,
        participants,
        coordinatorId: coordinator.id,
        goal: meeting.goal
      })
    } catch (error) {
      log.warn('Coordinator plan was invalid; using deterministic fallback', {
        meetingId: context.meetingId,
        error
      })
      plan = fallbackPlan({
        goal: meeting.goal,
        participants,
        coordinatorId: coordinator.id,
        intakeCards
      })
    }
    persistPlan({
      meetingId: context.meetingId,
      plan,
      taskIdsByTitle: new Map()
    })
    context.checkpoint.phase = 'done'
    context.checkpoint.planProduced = true
    saveCheckpoint(context)
    const updated = setMeetingPlan(context.meetingId, plan)
    emit(context.sender, {
      type: 'plan',
      meetingId: context.meetingId,
      plan,
      meeting: updated
    })
    finishResult(context)
    log.info('Plan meeting completed', {
      meetingId: context.meetingId,
      participants: participants.length,
      tasks: plan.tasks.length,
      turns: context.usage.turns,
      costUsd: context.usage.costUsd
    })
  } catch (error) {
    if (!getCurrentProject()) {
      log.info('Meeting stopped because the project closed', {
        meetingId: context.meetingId
      })
      return
    }
    if (error instanceof AppError && error.code === 'MEETING_NO_PROGRESS') {
      stopResult(context, 'no-progress')
      return
    }
    if (error instanceof AppError && error.code === 'MEETING_REPETITION') {
      stopResult(context, 'repetition')
      return
    }
    if (context.controller.signal.aborted) {
      stopResult(context, context.stopSignalReason())
      return
    }
    failMeeting(context, error)
  } finally {
    activeMeetings.delete(context.meetingId)
  }
}

function stopReasonForActive(active: ActiveMeeting): 'user' | 'paused' {
  return active.stopReason ?? 'user'
}

export function startMeetingEngine(
  sender: WebContents,
  meetingId: string,
  options: { resume?: boolean } = {}
): MeetingSummary {
  if (activeMeetings.has(meetingId)) {
    throw new AppError('MEETING_ACTIVE', 'This meeting is already running.')
  }
  const meeting = meetingSummary(meetingId)
  const interruptedStatus = ['intake', 'discussion', 'planning'].includes(meeting.status)
  if (
    !options.resume &&
    meeting.status !== 'draft' &&
    meeting.status !== 'failed' &&
    meeting.status !== 'stopped'
  ) {
    throw new AppError('MEETING_NOT_READY', 'This meeting has already run.')
  }
  if (options.resume && !interruptedStatus && meeting.status !== 'stopped' && meeting.status !== 'failed') {
    throw new AppError('MEETING_NOT_INTERRUPTED', 'This meeting has nothing to resume.')
  }
  const lease = resumableLease(meetingId)
  const checkpoint =
    options.resume
      ? lease?.checkpoint ?? meetingCheckpoint(meetingId) ?? defaultCheckpoint()
      : defaultCheckpoint()
  const leaseId = lease?.id ?? createRunLease({
    kind: 'plan',
    sessionId: meetingSessionId(meetingId),
    meetingId,
    checkpoint
  })
  const controller = new AbortController()
  const active: ActiveMeeting = {
    controller,
    sender,
    stopReason: null
  }
  activeMeetings.set(meetingId, active)
  const context: MeetingContext = {
    meetingId,
    sessionId: meetingSessionId(meetingId),
    goal: meeting.goal,
    sender,
    controller,
    budget: meeting.budget,
    startedAt: Date.now(),
    usage: meeting.usage,
    lastText: '',
    emptyTurns: 0,
    stopSignalReason: () => (active.stopReason ? stopReasonForActive(active) : 'user'),
    leaseId,
    checkpoint
  }
  void runMeeting(context)
  return meetingSummary(meetingId)
}

export function stopMeetingEngine(meetingId: string, reason: 'user' | 'paused'): MeetingSummary {
  const active = activeMeetings.get(meetingId)
  if (!active) {
    return meetingSummary(meetingId)
  }
  active.stopReason = reason
  active.controller.abort()
  return meetingSummary(meetingId)
}

export function cancelAllMeetingRuns(): void {
  for (const active of activeMeetings.values()) {
    active.stopReason = 'user'
    active.controller.abort()
  }
  activeMeetings.clear()
}

export function sendDirectEngine(
  sender: WebContents,
  input: { meetingId: string; agentId: string; text: string }
): MeetingSummary {
  if (activeMeetings.has(input.meetingId)) {
    throw new AppError('MEETING_ACTIVE', 'Wait for the current meeting turn to finish.')
  }
  const detail = getMeetingDetail(input.meetingId)
  const agent = meetingParticipants(input.meetingId).find((entry) => entry.id === input.agentId)
  if (!agent) {
    throw new AppError('AGENT_NOT_IN_MEETING', 'That agent is not a participant in this meeting.')
  }
  const participant = participantFor(detail.meeting.participants, agent.id)
  if (!participant) {
    throw new AppError('AGENT_NOT_IN_MEETING', 'That agent is not a participant in this meeting.')
  }

  const bossMessage = appendMeetingMessage({
    meetingId: input.meetingId,
    senderType: 'boss',
    senderAgentId: null,
    senderName: 'Boss',
    targetAgentId: agent.id,
    kind: 'direct',
    content: input.text.trim(),
    metadata: {
      phase: 'direct',
      round: detail.meeting.usage.rounds,
      status: 'done'
    }
  })
  const meeting = meetingSummary(input.meetingId)
  emit(sender, {
    type: 'message',
    meetingId: input.meetingId,
    message: bossMessage,
    meeting
  })

  const controller = new AbortController()
  const active: ActiveMeeting = {
    controller,
    sender,
    stopReason: null
  }
  activeMeetings.set(input.meetingId, active)
  const directLeaseId = createRunLease({
    kind: 'plan',
    sessionId: meetingSessionId(input.meetingId),
    meetingId: input.meetingId,
    checkpoint: defaultCheckpoint()
  })
  const context: MeetingContext = {
    meetingId: input.meetingId,
    sessionId: meetingSessionId(input.meetingId),
    goal: meeting.goal,
    sender,
    controller,
    budget: meeting.budget,
    startedAt: Date.now(),
    usage: meeting.usage,
    lastText: '',
    emptyTurns: 0,
    stopSignalReason: () => (active.stopReason ? stopReasonForActive(active) : 'user'),
    leaseId: directLeaseId,
    checkpoint: defaultCheckpoint()
  }

  void (async () => {
    try {
      const turn = await runTurn({
        context,
        agent,
        participants: meeting.participants,
        phase: 'direct',
        round: Math.max(1, meeting.usage.rounds),
        kind: 'direct',
        userText: input.text.trim(),
        withTools: true
      })
      addUsage(context, turn, Math.max(1, meeting.usage.rounds))
      if (turn.cancelled) {
        stopResult(context, context.stopSignalReason())
        return
      }
      emit(sender, {
        type: 'meeting-update',
        meeting: meetingSummary(input.meetingId)
      })
      const finalDetail = getMeetingDetail(input.meetingId)
      if (finalDetail.meeting.status === 'stopped') {
        emit(sender, {
          type: 'cancelled',
          meetingId: input.meetingId,
          meeting: finalDetail
        })
      } else {
        emit(sender, {
          type: 'done',
          meetingId: input.meetingId,
          meeting: finalDetail
        })
      }
    } catch (error) {
      if (!getCurrentProject()) {
        log.info('Direct meeting turn stopped because the project closed', {
          meetingId: input.meetingId
        })
      } else if (controller.signal.aborted) {
        stopResult(context, context.stopSignalReason())
      } else {
        failMeeting(context, error)
      }
    } finally {
      finishRunLease(directLeaseId, 'completed')
      activeMeetings.delete(input.meetingId)
    }
  })()

  return meetingSummary(input.meetingId)
}

export function isMeetingActive(meetingId: string): boolean {
  return activeMeetings.has(meetingId)
}

export function activeMeetingSummary(): MeetingSummary | null {
  const meetingId = activeMeetings.keys().next().value as string | undefined
  return meetingId ? meetingSummary(meetingId) : null
}
