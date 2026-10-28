import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import {
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
  type UserContent
} from 'ai'
import {
  IPC_CHANNELS,
  type AgentConfig,
  type ChatAttachment,
  type ChatContextHistoryItem,
  type ChatContextSnapshot,
  type ChatEvent,
  type ChatMessage,
  type ChatMessageMetadata,
  type ChatMode,
  type ChatSendRequest,
  type ChatSessionDetail,
  type ChatToolTrace,
  type ChatUsage,
  type ModelRecord,
  type ProviderConfig,
  type TeamConfig
} from '@shared/types'
import { createLogger } from '../config/logger'
import { loadSettings } from '../config/settings'
import { AppError } from '../errors'
import {
  getCurrentProject,
  getCurrentTeamConfig
} from '../project/projectService'
import { createLanguageModel } from '../providers/modelGateway'
import { formatProviderError } from '../providers/providerErrors'
import {
  cancelAllApprovals,
  cancelApprovalsForRun,
  requestApproval as requestBossApproval
} from '../approvals/approvalService'
import {
  bindAttachmentsToMessage,
  getAttachmentRecords,
  getImagePartsForMessages,
  readImagePart
} from './attachments'
import {
  agentCanUseTools,
  assignmentWarnings,
  compileChatPrompt,
  estimateTokens
} from './promptCompiler'
import { createAgentTools, type AgentToolBundle } from './projectTools'
import {
  buildMcpToolBundle,
  mergeToolBundles
} from '../mcp/mcpAgentTools'
import { recordTurnMemories, retrieveMemoryContext } from '../memory/memoryService'
import { assertMonthlyBudgetAvailable } from '../data/dataService'
import {
  appendChatMessage,
  createChatSession,
  deleteChatMessage,
  finishToolCall,
  getChatMessage,
  getChatMessages,
  getChatSessionSummary,
  markChatMessageInterrupted,
  recordToolCall,
  recordUsage,
  setChatSessionMode,
  setChatSessionTitle,
  touchChatSession,
  updateChatMessage
} from './sessionService'

const log = createLogger('chat')

const MAX_HISTORY_MESSAGES = 30
const MAX_HISTORY_CHARS = 70_000
const MAX_HISTORY_IMAGES = 4

type ActiveRun = {
  controller: AbortController
  sender: WebContents
  sessionId: string
  assistantMessageId: string
}

const activeRuns = new Map<string, ActiveRun>()

function sendChatEvent(sender: WebContents, event: ChatEvent): void {
  if (!sender.isDestroyed()) {
    sender.send(IPC_CHANNELS.chatEvent, event)
  }
}

function findAgent(team: TeamConfig, agentId: string): AgentConfig {
  const agent = team.agents.find((entry) => entry.id === agentId)
  if (!agent) {
    throw new AppError('AGENT_NOT_FOUND', 'The selected agent does not exist.')
  }
  if (!agent.enabled) {
    throw new AppError(
      'AGENT_DISABLED',
      'This agent is disabled. Enable it in Settings, Team before chatting.'
    )
  }
  return agent
}

function findModel(
  agent: AgentConfig,
  settings: ReturnType<typeof loadSettings>
): { model: ModelRecord; provider: ProviderConfig } {
  if (!agent.model) {
    throw new AppError(
      'AGENT_MODEL_MISSING',
      'Assign a model to this agent in Settings, Team before chatting.'
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
      'The model assigned to this agent is no longer in the catalog.'
    )
  }
  const provider = settings.providers.find((entry) => entry.id === model.providerId)
  if (!provider) {
    throw new AppError(
      'PROVIDER_NOT_FOUND',
      'The provider for this agent\'s model no longer exists.'
    )
  }
  if (!provider.enabled) {
    throw new AppError(
      'PROVIDER_DISABLED',
      `Enable ${provider.name} before chatting with this agent.`
    )
  }
  return { model, provider }
}

function usageToChat(usage: LanguageModelUsage | null | undefined, model: ModelRecord): ChatUsage {
  const inputTokens = usage?.inputTokens ?? undefined
  const outputTokens = usage?.outputTokens ?? undefined
  const totalTokens = usage?.totalTokens ?? undefined
  const cachedTokens = usage?.inputTokenDetails?.cacheReadTokens ?? undefined
  const inputPrice = model.inputPricePerMillion
  const outputPrice = model.outputPricePerMillion
  const costUsd =
    inputPrice !== undefined || outputPrice !== undefined
      ? ((inputTokens ?? 0) * (inputPrice ?? 0) +
          (outputTokens ?? 0) * (outputPrice ?? 0)) /
        1_000_000
      : undefined
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedTokens,
    costUsd
  }
}

function serializableModelMessages(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown
  } catch {
    return undefined
  }
}

function modelMessagesFromMetadata(metadata: ChatMessageMetadata | undefined): ModelMessage[] {
  if (!metadata || !Array.isArray(metadata.modelMessages)) {
    return []
  }
  return metadata.modelMessages as ModelMessage[]
}

type PreparedHistory = {
  messages: ModelMessage[]
  included: ChatMessage[]
  omitted: number
  imagesOmitted: boolean
  warnings: string[]
  imageCount: number
}

function buildHistory(input: {
  previous: ChatMessage[]
  current: ChatMessage
  currentImages: Array<{ mediaType: string; data: Uint8Array }>
  toolsAvailable: boolean
  supportsVision: boolean
}): PreparedHistory {
  const { previous, current, currentImages, toolsAvailable, supportsVision } = input
  const warnings: string[] = []
  const selected: ChatMessage[] = []
  let chars = 0
  let omitted = 0

  for (let index = previous.length - 1; index >= 0; index -= 1) {
    const message = previous[index]
    const metadataSize = message.metadata?.modelMessages
      ? JSON.stringify(message.metadata.modelMessages).length
      : 0
    const cost = message.content.length + metadataSize
    if (
      selected.length >= 2 &&
      (selected.length >= MAX_HISTORY_MESSAGES || chars + cost > MAX_HISTORY_CHARS)
    ) {
      omitted = index + 1
      break
    }
    selected.unshift(message)
    chars += cost
  }

  if (omitted > 0) {
    warnings.push(
      `Older conversation history was omitted to fit the context budget (${omitted} message${
        omitted === 1 ? '' : 's'
      }).`
    )
  }

  const previousImageMessages = selected
    .filter((message) => message.role === 'user' && message.attachments.length > 0)
    .slice(-2)
  const allowedImageMessageIds = new Set(previousImageMessages.map((message) => message.id))
  const imagePartsByMessage = supportsVision
    ? getImagePartsForMessages([...allowedImageMessageIds])
    : new Map<string, Array<{ mediaType: string; data: Uint8Array }>>()
  let imagesOmitted = false
  let imageCount = 0
  const imageAllowance = new Map<string, number>()

  for (const message of selected) {
    if (message.role !== 'user' || message.attachments.length === 0) {
      continue
    }
    if (!supportsVision || !allowedImageMessageIds.has(message.id)) {
      imagesOmitted = true
      continue
    }
    const remaining = Math.max(MAX_HISTORY_IMAGES - imageCount, 0)
    if (remaining === 0) {
      imagesOmitted = true
      continue
    }
    const parts = imagePartsByMessage.get(message.id) ?? []
    const allowed = Math.min(remaining, parts.length)
    imageAllowance.set(message.id, allowed)
    imageCount += allowed
    if (allowed < parts.length) {
      imagesOmitted = true
    }
  }

  if (imagesOmitted) {
    warnings.push(
      supportsVision
        ? 'Some older images were not resent to stay within the image budget.'
        : 'Previous images were not resent because this model is not marked vision-capable.'
    )
  }

  const messages: ModelMessage[] = []
  for (const message of selected) {
    if (message.role === 'user') {
      const content: UserContent = []
      if (message.content.trim()) {
        content.push({ type: 'text', text: message.content })
      }
      const allowed = imageAllowance.get(message.id) ?? 0
      const parts = imagePartsByMessage.get(message.id) ?? []
      for (const part of parts.slice(0, allowed)) {
        content.push({
          type: 'file',
          data: part.data,
          mediaType: part.mediaType
        })
      }
      if (content.length === 0) {
        continue
      }
      messages.push({
        role: 'user',
        content:
          content.length === 1 && content[0].type === 'text' ? content[0].text : content
      })
      continue
    }

    const stored = modelMessagesFromMetadata(message.metadata)
    if (toolsAvailable && stored.length > 0) {
      messages.push(...stored)
    } else if (message.content.trim()) {
      messages.push({ role: 'assistant', content: message.content })
    }
  }

  const currentContent: UserContent = []
  if (current.content.trim()) {
    currentContent.push({ type: 'text', text: current.content })
  }
  for (const image of currentImages) {
    currentContent.push({
      type: 'file',
      data: image.data,
      mediaType: image.mediaType
    })
  }
  if (currentContent.length === 0) {
    currentContent.push({ type: 'text', text: 'Please review the attached image.' })
  }
  messages.push({
    role: 'user',
    content:
      currentContent.length === 1 && currentContent[0].type === 'text'
        ? currentContent[0].text
        : currentContent
  })

  return {
    messages,
    included: [...selected, current],
    omitted,
    imagesOmitted,
    warnings,
    imageCount: imageCount + currentImages.length
  }
}

function contextHistory(
  included: ChatMessage[],
  current: ChatMessage
): ChatContextHistoryItem[] {
  return included.map((message) => {
    const toolNames =
      message.metadata?.toolCalls?.map((tool) => tool.toolName).filter(Boolean) ?? []
    const text = message.content.replace(/\s+/g, ' ').trim()
    return {
      role: message.role,
      label: message.role === 'user' ? 'Boss' : message.senderName,
      text:
        text.length > 320
          ? `${text.slice(0, 320)}â€¦`
          : text || (message.attachments.length > 0 ? '(image attachment)' : '(no text)'),
      imageCount:
        message.id === current.id ? current.attachments.length : message.attachments.length,
      toolNames
    }
  })
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.trim()))]
}

function chatTitle(text: string, hasImages: boolean): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized) {
    return normalized.length > 62 ? `${normalized.slice(0, 62)}â€¦` : normalized
  }
  return hasImages ? 'Image review' : 'New conversation'
}

async function executeRun(input: {
  runId: string
  sender: WebContents
  controller: AbortController
  sessionId: string
  sessionTitle: string
  userText: string
  mode: ChatMode
  agent: AgentConfig
  provider: ProviderConfig
  model: ModelRecord
  assistantMessageId: string
  prompt: ReturnType<typeof compileChatPrompt>
  history: PreparedHistory
  context: ChatContextSnapshot
  temperature: number
  toolBundle: AgentToolBundle
  team: TeamConfig
}): Promise<void> {
  const {
    runId,
    sender,
    controller,
    sessionId,
    sessionTitle,
    userText,
    mode,
    agent,
    provider,
    model,
    assistantMessageId,
    prompt,
    history,
    context,
    temperature,
    toolBundle,
    team
  } = input
  const startedAt = Date.now()
  let fullText = ''
  let usage: ChatUsage = {}
  let streamError: unknown = null
  const toolTraces: ChatToolTrace[] = []
  const toolStarts = new Map<string, number>()
  const auditIds = new Map<string, string>()
  let responseMessages: unknown

  try {
    const modelOptions = {
      model: createLanguageModel(provider, model),
      system: prompt.system,
      messages: history.messages,
      maxOutputTokens: Math.min(model.maxOutputTokens ?? 4096, 4096),
      temperature,
      maxRetries: 0,
      timeout: 120_000,
      abortSignal: controller.signal,
      ...(toolBundle.names.length > 0
        ? {
            tools: toolBundle.tools,
            stopWhen: stepCountIs(
              Math.min(Math.max(team.orchestration.maxToolStepsPerTurn, 1), 8)
            )
          }
        : {})
    }

    const result = streamText(modelOptions)

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        fullText += part.text
        sendChatEvent(sender, {
          runId,
          type: 'delta',
          text: part.text
        })
        continue
      }

      if (part.type === 'tool-call') {
        const trace: ChatToolTrace = {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
          status: 'running'
        }
        toolTraces.push(trace)
        toolStarts.set(part.toolCallId, Date.now())
        const auditId = randomUUID()
        auditIds.set(part.toolCallId, auditId)
        recordToolCall({
          id: auditId,
          sessionId,
          agentId: agent.id,
          tool: trace
        })
        sendChatEvent(sender, {
          runId,
          type: 'tool',
          tool: trace
        })
        continue
      }

      if (part.type === 'tool-result') {
        const trace = toolTraces.find((entry) => entry.toolCallId === part.toolCallId)
        if (trace) {
          trace.status = 'done'
          trace.output = part.output
          trace.durationMs = Date.now() - (toolStarts.get(part.toolCallId) ?? Date.now())
          const auditId = auditIds.get(part.toolCallId)
          if (auditId) {
            finishToolCall({ id: auditId, tool: trace })
          }
          sendChatEvent(sender, {
            runId,
            type: 'tool-result',
            tool: trace
          })
        }
        continue
      }

      if (part.type === 'tool-error') {
        const trace = toolTraces.find((entry) => entry.toolCallId === part.toolCallId)
        const message =
          part.error instanceof Error ? part.error.message : String(part.error)
        if (trace) {
          trace.status = 'error'
          trace.error = message
          trace.durationMs = Date.now() - (toolStarts.get(part.toolCallId) ?? Date.now())
          const auditId = auditIds.get(part.toolCallId)
          if (auditId) {
            finishToolCall({ id: auditId, tool: trace })
          }
          sendChatEvent(sender, {
            runId,
            type: 'tool-result',
            tool: trace
          })
        }
        continue
      }

      if (part.type === 'finish') {
        usage = usageToChat(part.totalUsage, model)
        continue
      }

      if (part.type === 'error') {
        streamError = part.error
      }
    }

    if (controller.signal.aborted) {
      cancelApprovalsForRun(runId)
      const durationMs = Date.now() - startedAt
      const content = fullText.trim() || 'Stopped before the model produced a response.'
      const metadata: ChatMessageMetadata = {
        status: 'cancelled',
        cancelled: true,
        context: { ...context, usage, durationMs },
        toolCalls: toolTraces,
        usage,
        durationMs
      }
      updateChatMessage({
        messageId: assistantMessageId,
        content,
        metadata
      })
      touchChatSession(sessionId)
      const message = getChatMessage(assistantMessageId, true)
      sendChatEvent(sender, {
        runId,
        type: 'cancelled',
        message,
        session: getChatSessionSummary(sessionId)
      })
      return
    }

    if (streamError) {
      throw streamError
    }

    try {
      responseMessages = serializableModelMessages(await result.responseMessages)
    } catch (error) {
      log.warn('Could not read response messages', {
        providerId: provider.id,
        modelId: model.modelId,
        error
      })
    }

    const durationMs = Date.now() - startedAt
    const content = fullText.trim() || 'The model finished without producing text.'
    const finalContext: ChatContextSnapshot = {
      ...context,
      usage,
      durationMs
    }
    const metadata: ChatMessageMetadata = {
      status: 'done',
      context: finalContext,
      toolCalls: toolTraces,
      modelMessages: responseMessages,
      usage,
      durationMs
    }
    updateChatMessage({
      messageId: assistantMessageId,
      content,
      metadata
    })
    touchChatSession(sessionId)
    if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
      recordUsage({
        sessionId,
        agentId: agent.id,
        providerId: provider.id,
        modelId: model.modelId,
        usage
      })
    }
    try {
      const memories = recordTurnMemories({
        sessionId,
        sessionTitle,
        agentId: agent.id,
        agentName: agent.name,
        mode,
        userText,
        assistantText: content,
        assistantMessageId,
        startedAt,
        toolTraces
      })
      log.info('Turn memories recorded', {
        sessionId,
        agentId: agent.id,
        entries: memories.entries.length,
        summaries: memories.summaries.length
      })
    } catch (error) {
      log.warn('Could not record turn memories', { sessionId, error })
    }
    const message = getChatMessage(assistantMessageId, true)
    const session = getChatSessionSummary(sessionId)
    sendChatEvent(sender, {
      runId,
      type: 'done',
      message,
      session
    })
    log.info('Chat run completed', {
      sessionId,
      agentId: agent.id,
      providerId: provider.id,
      modelId: model.modelId,
      durationMs,
      toolCalls: toolTraces.length,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens
    })
  } catch (error) {
    cancelApprovalsForRun(runId)
    if (!getCurrentProject()) {
      log.warn('Chat run stopped because the project closed', { sessionId })
      return
    }
    const message = formatProviderError(error, provider)
    const durationMs = Date.now() - startedAt
    log.error('Chat run failed', {
      sessionId,
      agentId: agent.id,
      providerId: provider.id,
      modelId: model.modelId,
      message
    })

    if (fullText.trim()) {
      const metadata: ChatMessageMetadata = {
        status: 'error',
        error: message,
        retryable: true,
        context: { ...context, usage, durationMs },
        toolCalls: toolTraces,
        usage,
        durationMs
      }
      updateChatMessage({
        messageId: assistantMessageId,
        content: fullText,
        metadata
      })
      touchChatSession(sessionId)
      sendChatEvent(sender, {
        runId,
        type: 'error',
        message,
        assistantMessage: getChatMessage(assistantMessageId, true),
        session: getChatSessionSummary(sessionId)
      })
      return
    }

    try {
      deleteChatMessage(assistantMessageId)
    } catch {
      log.warn('Could not remove failed assistant message', { assistantMessageId })
    }
    touchChatSession(sessionId)
    sendChatEvent(sender, {
      runId,
      type: 'error',
      message,
      session: getChatSessionSummary(sessionId)
    })
  } finally {
    activeRuns.delete(runId)
  }
}

function attachmentChatView(
  records: ReturnType<typeof getAttachmentRecords>
): ChatAttachment[] {
  return records.map((record) => ({
    id: record.id,
    name: record.name,
    mime: record.mime,
    size: record.size,
    width: record.width ?? undefined,
    height: record.height ?? undefined
  }))
}

export function createSessionForAgent(
  agentId: string,
  mode: ChatMode = 'plan'
): ChatSessionDetail {
  const team = getCurrentTeamConfig()
  if (!team) {
    throw new AppError('NO_TEAM', 'The project team configuration could not be loaded.')
  }
  const agent = findAgent(team, agentId)
  return createChatSession(agent.id, mode)
}

export function setSessionMode(
  sessionId: string,
  mode: ChatMode
): ChatSessionDetail {
  if ([...activeRuns.values()].some((run) => run.sessionId === sessionId)) {
    throw new AppError(
      'CHAT_RUN_ACTIVE',
      'Stop the current run before changing the conversation mode.'
    )
  }
  return setChatSessionMode(sessionId, mode)
}

export function startChatRun(
  sender: WebContents,
  request: ChatSendRequest
): { runId: string; sessionId: string } {
  const project = getCurrentProject()
  if (!project) {
    throw new AppError('NO_PROJECT', 'Open a project before chatting.')
  }
  assertMonthlyBudgetAvailable()
  const team = getCurrentTeamConfig()
  if (!team) {
    throw new AppError('NO_TEAM', 'The project team configuration could not be loaded.')
  }
  const settings = loadSettings()
  const agent = findAgent(team, request.agentId)
  const { model, provider } = findModel(agent, settings)

  let session = request.sessionId
    ? getChatSessionSummary(request.sessionId)
    : createChatSession(agent.id, request.mode ?? 'plan').session
  // A team room is one shared transcript. The selected agent answers the
  // current message, while every agent sees the same conversation history.
  const mode = request.mode ?? session.mode
  if (session.mode !== mode) {
    setChatSessionMode(session.id, mode)
    session = getChatSessionSummary(session.id)
  }

  const text = request.text.trim()
  const uniqueAttachmentIds = [...new Set(request.attachmentIds)]
  if (!text && uniqueAttachmentIds.length === 0) {
    throw new AppError('EMPTY_MESSAGE', 'Write a message or attach an image first.')
  }
  if (uniqueAttachmentIds.length > 4) {
    throw new AppError('TOO_MANY_IMAGES', 'Attach at most four images per message.')
  }

  const attachmentRecords = getAttachmentRecords(uniqueAttachmentIds)
  const currentImages = attachmentRecords.map((record) => readImagePart(record))
  const temperature = Math.min(Math.max(agent.model?.temperature ?? 0.2, 0), 2)
  const runContext = {
    mode,
    sessionId: session.id,
    runId: '',
    agentId: agent.id,
    requestApproval: (approval: {
      actionType: Parameters<typeof requestBossApproval>[1]['actionType']
      actionKey: string
      risk: Parameters<typeof requestBossApproval>[1]['risk']
      reason: string
      payload: Record<string, unknown>
    }) =>
      requestBossApproval(sender, {
        sessionId: session.id,
        runId: runContext.runId,
        agentId: agent.id,
        ...approval
      }),
    emitOutput: (
      toolCallId: string,
      stream: 'stdout' | 'stderr' | 'system',
      text: string
    ) => {
      sendChatEvent(sender, {
        runId: runContext.runId,
        type: 'tool-output',
        toolCallId,
        stream,
        text
      })
    }
  }

  const toolsAvailable = model.supportsTools && agentCanUseTools(agent, settings)
  const baseToolBundle: AgentToolBundle = toolsAvailable
    ? createAgentTools({
        root: project.path,
        agent,
        runtime: runContext,
        permissions: team.permissions
      })
    : { tools: {}, definitions: [], names: [], warnings: [] }
  const toolBundle = mergeToolBundles(
    baseToolBundle,
    buildMcpToolBundle({
      team,
      agent,
      runtime: runContext,
      mode
    })
  )
  const memory = retrieveMemoryContext({
    agentId: agent.id,
    sessionId: session.id,
    query: text || 'recent project work',
    limit: 5
  })
  const prompt = compileChatPrompt({
    agent,
    team,
    project,
    settings,
    mode,
    memory,
    toolsAvailable: toolBundle.names.length > 0,
    toolNames: toolBundle.names
  })

  const previousMessages = getChatMessages(session.id, false).filter(
    (message) =>
      message.role === 'user' || message.content.trim() || message.metadata?.toolCalls
  )

  const warnings = dedupe([
    ...assignmentWarnings(agent, settings, currentImages.length > 0),
    ...prompt.warnings,
    ...toolBundle.warnings,
    ...(toolsAvailable
      ? []
      : [
          mode === 'build'
            ? 'No repository tools were offered for this run. The agent can only use the supplied context.'
            : 'Read-only tools were not offered for this run. The agent can only use the supplied context.'
        ]),
    ...(!agent.permissions.tools.includes('read') &&
    !agent.permissions.tools.includes('search') &&
    !agent.permissions.tools.includes('list')
      ? ['Repository read tools are disabled by this agent\'s permission settings.']
      : [])
  ])

  const userMessage = appendChatMessage({
    sessionId: session.id,
    agentId: agent.id,
    role: 'user',
    senderName: settings.bossName,
    content: text
  })
  bindAttachmentsToMessage(userMessage.id, uniqueAttachmentIds)
  userMessage.attachments = attachmentChatView(attachmentRecords)

  const history = buildHistory({
    previous: previousMessages,
    current: userMessage,
    currentImages,
    toolsAvailable: toolBundle.names.length > 0,
    supportsVision: model.supportsVision
  })
  warnings.push(...history.warnings)
  if (history.omitted > 0 && memory.summaries.some((summary) => summary.scope === 'session')) {
    warnings.push('Older messages were compacted into the session memory summary.')
  }
  const finalWarnings = dedupe(warnings)
  const estimatedPromptTokens =
    estimateTokens(prompt.system) +
    history.messages.reduce((total, message) => {
      if (typeof message.content === 'string') {
        return total + estimateTokens(message.content)
      }
      return (
        total +
        message.content.reduce((partTotal, part) => {
          if (part.type === 'text') {
            return partTotal + estimateTokens(part.text)
          }
          return partTotal + 800
        }, 0)
      )
    }, 0) +
    estimateTokens(
      toolBundle.definitions.map((definition) => definition.description).join('\n')
    )

  const context: ChatContextSnapshot = {
    mode,
    system: prompt.system,
    contextFiles: prompt.contextFiles,
    history: contextHistory(history.included, userMessage),
    memory,
    tools: toolBundle.definitions,
    model: {
      providerId: provider.id,
      providerName: provider.name,
      providerType: provider.type,
      modelId: model.modelId,
      displayName: model.displayName,
      temperature,
      supportsTools: model.supportsTools,
      supportsVision: model.supportsVision,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens
    },
    warnings: finalWarnings,
    estimatedPromptTokens,
    historyOmitted: history.omitted
  }

  if (session.title === 'New conversation') {
    setChatSessionTitle(session.id, chatTitle(text, currentImages.length > 0))
    session = getChatSessionSummary(session.id)
  }

  const assistantMessage = appendChatMessage({
    sessionId: session.id,
    agentId: agent.id,
    role: 'assistant',
    senderName: agent.name,
    content: '',
    metadata: {
      status: 'streaming',
      context,
      toolCalls: []
    }
  })

  const runId = randomUUID()
  const controller = new AbortController()
  runContext.runId = runId
  activeRuns.set(runId, {
    controller,
    sender,
    sessionId: session.id,
    assistantMessageId: assistantMessage.id
  })

  sendChatEvent(sender, {
    runId,
    type: 'start',
    agentId: agent.id,
    session,
    userMessage: getChatMessage(userMessage.id, true),
    assistantMessage: getChatMessage(assistantMessage.id, true)
  })

  void executeRun({
    runId,
    sender,
    controller,
    sessionId: session.id,
    sessionTitle: session.title,
    userText: text,
    mode,
    agent,
    provider,
    model,
    assistantMessageId: assistantMessage.id,
    prompt,
    history,
    context,
    temperature,
    toolBundle,
    team
  })

  return {
    runId,
    sessionId: session.id
  }
}

export function cancelChatRun(runId: string): void {
  const active = activeRuns.get(runId)
  if (active) {
    cancelApprovalsForRun(runId)
    active.controller.abort()
    activeRuns.delete(runId)
  }
}

export function cancelAllChatRuns(): void {
  cancelAllApprovals('The app is closing or the project is changing.')
  for (const active of activeRuns.values()) {
    try {
      markChatMessageInterrupted(active.assistantMessageId)
    } catch {
      // The project database may already be closed during shutdown.
    }
    active.controller.abort()
  }
  activeRuns.clear()
}





