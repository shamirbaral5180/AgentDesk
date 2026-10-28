import { useEffect, useRef, useState } from 'react'
import type {
  AgentSummary,
  AppSettings,
  ChatAttachment,
  ChatEvent,
  ChatMessage,
  ChatMode,
  ChatSessionDetail,
  ChatSessionSummary,
  ChatToolTrace,
  ProjectInfo
} from '@shared/types'
import { formatRelativeTime } from '../lib/format'
import { ChatMessageView } from './ChatMessageView'
import { ChangesDialog } from './ChangesDialog'
import { ContextInspectorDialog } from './ContextInspectorDialog'
import { Icon } from './Icon'

type AgentChatProps = {
  project: ProjectInfo
  settings: AppSettings
  agent: AgentSummary
  agents: AgentSummary[]
  onSelectAgent: (agentId: string) => void
  onOpenSettings: () => void
  onFilesChanged: () => void
  onError: (message: string) => void
}

function mergeSession(
  sessions: ChatSessionSummary[],
  session: ChatSessionSummary
): ChatSessionSummary[] {
  return [session, ...sessions.filter((entry) => entry.id !== session.id)].sort(
    (a, b) => b.lastOpenedAt - a.lastOpenedAt
  )
}

function updateAssistant(
  current: ChatSessionDetail | null,
  assistantMessageId: string,
  updater: (message: ChatMessage) => ChatMessage
): ChatSessionDetail | null {
  if (!current) {
    return current
  }
  return {
    ...current,
    messages: current.messages.map((message) =>
      message.id === assistantMessageId ? updater(message) : message
    )
  }
}

function mergeToolTrace(message: ChatMessage, tool: ChatToolTrace): ChatMessage {
  const toolCalls = message.metadata?.toolCalls ?? []
  const existing = toolCalls.find((entry) => entry.toolCallId === tool.toolCallId)
  return {
    ...message,
    metadata: {
      ...message.metadata,
      toolCalls: existing
        ? toolCalls.map((entry) =>
            entry.toolCallId === tool.toolCallId ? { ...entry, ...tool } : entry
          )
        : [...toolCalls, tool]
    }
  }
}

export function AgentChat({
  project,
  settings,
  agent,
  agents,
  onSelectAgent,
  onOpenSettings,
  onFilesChanged,
  onError
}: AgentChatProps) {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([])
  const [active, setActive] = useState<ChatSessionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [mode, setMode] = useState<ChatMode>('plan')
  const [draft, setDraft] = useState('')
  const [pendingImages, setPendingImages] = useState<ChatAttachment[]>([])
  const [contextMessage, setContextMessage] = useState<ChatMessage | null>(null)
  const [changesOpen, setChangesOpen] = useState(false)
  const [inlineError, setInlineError] = useState('')
  const [runId, setRunId] = useState<string | null>(null)
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)

  const activeRunRef = useRef<string | null>(null)
  const streamingMessageIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const modelRecord = agent.model
    ? settings.models.find(
        (entry) =>
          entry.providerId === agent.model?.providerConfigId &&
          entry.modelId === agent.model?.modelId
      ) ?? null
    : null
  const provider = modelRecord
    ? settings.providers.find((entry) => entry.id === modelRecord.providerId) ?? null
    : null
  const modelReady = Boolean(agent.model && modelRecord && provider)
  const supportsTools = modelRecord?.supportsTools ?? false
  const supportsVision = modelRecord?.supportsVision ?? false
  const imageWarning = pendingImages.length > 0 && !supportsVision
  const providerKeyMissing =
    Boolean(provider) &&
    (provider?.type === 'openai' || provider?.type === 'google') &&
    !provider?.hasKey
  const providerDisabled = Boolean(provider && !provider.enabled)
  const modelLabel = modelRecord?.displayName ?? agent.modelLabel ?? 'No model assigned'

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setActive(null)
    setSessions([])
    setInlineError('')
    setDraft('')
    setMode('plan')
    setPendingImages([])
    setStreamingMessageId(null)
    streamingMessageIdRef.current = null
    activeRunRef.current = null
    setRunId(null)
    setSending(false)

    window.agentdesk
      .listChatSessions(agent.id)
      .then(async (result) => {
        if (cancelled) {
          return
        }
        if (!result.ok) {
          setInlineError(result.error.message)
          return
        }
        setSessions(result.data)
        const latest = result.data[0]
        if (!latest) {
          return
        }
        const detail = await window.agentdesk.getChatSession(latest.id)
        if (cancelled) {
          return
        }
        if (!detail.ok) {
          setInlineError(detail.error.message)
          return
        }
        setActive(detail.data)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setInlineError(
            error instanceof Error ? error.message : 'Could not load the conversation.'
          )
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [project.id, agent.id])

  useEffect(() => {
    if (active) {
      setMode(active.session.mode)
    }
  }, [active?.session.id, active?.session.mode])

  useEffect(() => {
    const unsubscribe = window.agentdesk.onChatEvent((event: ChatEvent) => {
      if (event.type !== 'start' && event.runId !== activeRunRef.current) {
        return
      }
      if (event.type === 'start') {
        if (event.agentId !== agent.id) {
          return
        }
        activeRunRef.current = event.runId
        streamingMessageIdRef.current = event.assistantMessage.id
        setRunId(event.runId)
        setSending(true)
        setStreamingMessageId(event.assistantMessage.id)
        setSessions((current) => mergeSession(current, event.session))
        setActive((current) => {
          const existing =
            current && current.session.id === event.session.id ? current.messages : []
          return {
            session: event.session,
            messages: [...existing, event.userMessage, event.assistantMessage]
          }
        })
        return
      }

      if (event.type === 'delta') {
        const assistantMessageId = streamingMessageIdRef.current
        if (!assistantMessageId) {
          return
        }
        setActive((current) =>
          updateAssistant(current, assistantMessageId, (message) => ({
            ...message,
            content: message.content + event.text
          }))
        )
        return
      }

      if (event.type === 'tool' || event.type === 'tool-result') {
        const assistantMessageId = streamingMessageIdRef.current
        if (!assistantMessageId) {
          return
        }
        setActive((current) =>
          updateAssistant(current, assistantMessageId, (message) =>
            mergeToolTrace(message, event.tool)
          )
        )
        return
      }

      if (event.type === 'tool-output') {
        const assistantMessageId = streamingMessageIdRef.current
        if (!assistantMessageId) {
          return
        }
        setActive((current) =>
          updateAssistant(current, assistantMessageId, (message) => {
            const toolCalls = message.metadata?.toolCalls ?? []
            return {
              ...message,
              metadata: {
                ...message.metadata,
                toolCalls: toolCalls.map((tool) =>
                  tool.toolCallId === event.toolCallId
                    ? {
                        ...tool,
                        output: `${typeof tool.output === 'string' ? tool.output : ''}${event.text}`
                      }
                    : tool
                )
              }
            }
          })
        )
        return
      }

      if (event.type === 'done') {
        const assistantMessageId = streamingMessageIdRef.current
        if (assistantMessageId) {
          setActive((current) =>
            updateAssistant(current, assistantMessageId, () => event.message)
          )
        }
        setSessions((current) => mergeSession(current, event.session))
        setActive((current) =>
          current ? { ...current, session: event.session } : current
        )
        activeRunRef.current = null
        streamingMessageIdRef.current = null
        setRunId(null)
        setStreamingMessageId(null)
        setSending(false)
        if ((event.message.metadata?.toolCalls?.length ?? 0) > 0) {
          onFilesChanged()
        }
        return
      }

      if (event.type === 'cancelled') {
        const assistantMessageId = streamingMessageIdRef.current
        if (assistantMessageId) {
          setActive((current) =>
            updateAssistant(current, assistantMessageId, () => event.message)
          )
        }
        setSessions((current) => mergeSession(current, event.session))
        setActive((current) =>
          current ? { ...current, session: event.session } : current
        )
        activeRunRef.current = null
        streamingMessageIdRef.current = null
        setRunId(null)
        setStreamingMessageId(null)
        setSending(false)
        return
      }

      const assistantMessageId = streamingMessageIdRef.current
      if (event.assistantMessage && assistantMessageId) {
        setActive((current) =>
          updateAssistant(current, assistantMessageId, () => event.assistantMessage!)
        )
      } else if (assistantMessageId) {
        setActive((current) =>
          current
            ? {
                ...current,
                messages: current.messages.filter(
                  (message) => message.id !== assistantMessageId
                )
              }
            : current
        )
      }
      if (event.session) {
        setSessions((current) => mergeSession(current, event.session!))
        setActive((current) =>
          current ? { ...current, session: event.session! } : current
        )
      }
      activeRunRef.current = null
      streamingMessageIdRef.current = null
      setRunId(null)
      setStreamingMessageId(null)
      setSending(false)
      setInlineError(event.message)
      onError(event.message)
    })

    return unsubscribe
  }, [agent.id, onError])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    element.scrollTo({
      top: element.scrollHeight,
      behavior: sending ? 'smooth' : 'auto'
    })
  }, [active?.messages, sending])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
  }, [draft])

  async function loadSession(sessionId: string): Promise<void> {
    if (!sessionId || sending) {
      return
    }
    setInlineError('')
    try {
      const result = await window.agentdesk.getChatSession(sessionId)
      if (!result.ok) {
        setInlineError(result.error.message)
        return
      }
      setActive(result.data)
    } catch (error) {
      setInlineError(
        error instanceof Error ? error.message : 'Could not open the conversation.'
      )
    }
  }

  async function newChat(): Promise<void> {
    if (sending) {
      return
    }
    setInlineError('')
    try {
      const result = await window.agentdesk.createChatSession(agent.id, mode)
      if (!result.ok) {
        setInlineError(result.error.message)
        return
      }
      setActive(result.data)
      setSessions((current) => mergeSession(current, result.data.session))
      setDraft('')
      setPendingImages([])
      textareaRef.current?.focus()
    } catch (error) {
      setInlineError(
        error instanceof Error ? error.message : 'Could not start a new conversation.'
      )
    }
  }

  async function switchMode(nextMode: ChatMode): Promise<void> {
    if (sending || mode === nextMode) {
      return
    }
    const previous = mode
    setMode(nextMode)
    setInlineError('')
    if (!active) {
      return
    }
    try {
      const result = await window.agentdesk.setChatMode(active.session.id, nextMode)
      if (!result.ok) {
        setMode(previous)
        setInlineError(result.error.message)
        return
      }
      setActive(result.data)
      setSessions((current) => mergeSession(current, result.data.session))
    } catch (error) {
      setMode(previous)
      setInlineError(
        error instanceof Error ? error.message : 'The conversation mode could not be changed.'
      )
    }
  }

  async function pickImages(): Promise<void> {
    if (sending) {
      return
    }
    setInlineError('')
    try {
      const result = await window.agentdesk.pickChatImages()
      if (!result.ok) {
        setInlineError(result.error.message)
        return
      }
      if (result.data.length === 0) {
        return
      }
      setPendingImages((current) => {
        const seen = new Set(current.map((image) => image.id))
        const next = [...current]
        for (const image of result.data) {
          if (!seen.has(image.id) && next.length < 4) {
            next.push(image)
            seen.add(image.id)
          }
        }
        return next
      })
    } catch (error) {
      setInlineError(
        error instanceof Error ? error.message : 'Could not attach the image.'
      )
    }
  }

  async function send(override?: { text: string }): Promise<void> {
    if (sending || !modelReady) {
      return
    }
    const text = override ? override.text : draft.trim()
    if (!text && !override && pendingImages.length === 0) {
      return
    }
    setInlineError('')
    setSending(true)
    try {
      const result = await window.agentdesk.sendChatMessage({
        sessionId: active?.session.id ?? null,
        agentId: agent.id,
        text,
        attachmentIds: override ? [] : pendingImages.map((image) => image.id),
        mode
      })
      if (!result.ok) {
        setSending(false)
        setInlineError(result.error.message)
        return
      }
      activeRunRef.current = result.data.runId
      setRunId(result.data.runId)
      setDraft('')
      setPendingImages([])
    } catch (error) {
      setSending(false)
      setInlineError(
        error instanceof Error ? error.message : 'The message could not be sent.'
      )
    }
  }

  function retryMessage(message: ChatMessage): void {
    const index = messages.findIndex((entry) => entry.id === message.id)
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const previous = messages[cursor]
      if (previous.role === 'user' && previous.content.trim()) {
        void send({ text: previous.content })
        return
      }
    }
    setInlineError('The interrupted request is not in this conversation. Send it again.')
  }

  async function stop(): Promise<void> {
    if (!runId) {
      return
    }
    const result = await window.agentdesk.cancelChatRun(runId)
    if (!result.ok) {
      setInlineError(result.error.message)
    }
  }

  const messages = active?.messages ?? []
  const isEmpty = !loading && messages.length === 0
  const canSend =
    modelReady && !sending && (draft.trim().length > 0 || pendingImages.length > 0)

  return (
    <div className="agent-chat">
      <header className="chat-header">
        <div className="chat-agent-block">
          <span className="chat-agent-avatar" style={{ backgroundColor: agent.color }}>
            {agent.name
              .split(' ')
              .filter((part) => part !== '&')
              .slice(0, 2)
              .map((part) => part[0])
              .join('')}
          </span>
          <div className="chat-agent-copy">
            <div className="chat-agent-title-row">
              <select
                className="chat-agent-select"
                value={agent.id}
                onChange={(event) => onSelectAgent(event.target.value)}
                disabled={sending}
                aria-label="Select agent"
              >
                {agents.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
              <span className={mode === 'build' ? 'plan-pill build' : 'plan-pill'}>
                {mode === 'build' ? 'Build' : 'Plan'}
              </span>
              <span className="readonly-pill">
                <Icon name={mode === 'build' ? 'shield' : 'lock'} size={11} />
                {mode === 'build' ? 'Approval-aware' : 'Read-only'}
              </span>
            </div>
            <span className="chat-agent-meta">
              {modelLabel}
              {active ? ` - ${formatRelativeTime(active.session.updatedAt)}` : ''}
            </span>
          </div>
        </div>

        <div className="chat-header-actions">
          <span className="chat-session-label">Session</span>
          <select
            className="chat-session-select"
            value={active?.session.id ?? ''}
            onChange={(event) => void loadSession(event.target.value)}
            disabled={sending || sessions.length === 0}
            aria-label="Conversation"
          >
            {sessions.length === 0 && <option value="">No saved chats</option>}
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title}
              </option>
            ))}
          </select>
          <button
            className="btn btn-quiet btn-small changes-button"
            type="button"
            onClick={() => setChangesOpen(true)}
            disabled={!active}
            title="Changes and snapshots"
          >
            <Icon name="clock" size={13} />
            Changes
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => void newChat()}
            disabled={sending}
            title="New chat"
            aria-label="New chat"
          >
            <Icon name="plus" size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => {
              if (active) {
                void loadSession(active.session.id)
              }
            }}
            disabled={sending || !active}
            title="Reload conversation"
            aria-label="Reload conversation"
          >
            <Icon name="refresh" size={15} />
          </button>
        </div>
      </header>

      <div className="chat-scroll" ref={scrollRef}>
        {loading ? (
          <div className="chat-loading">
            <span />
            <span />
            <span />
          </div>
        ) : isEmpty ? (
          <div className="chat-empty">
            <div className="chat-empty-mark" style={{ borderColor: agent.color }}>
              <span style={{ backgroundColor: agent.color }}>
                {agent.name
                  .split(' ')
                  .filter((part) => part !== '&')
                  .slice(0, 2)
                  .map((part) => part[0])
                  .join('')}
              </span>
            </div>
            <span className="eyebrow">
              {mode === 'build' ? 'Build mode - approval-aware' : 'Plan mode - read-only'}
            </span>
            <h2>
              {mode === 'build'
                ? `Tell ${agent.name.split(' ')[0]} what to build.`
                : `Ask ${agent.name.split(' ')[0]} about this project.`}
            </h2>
            <p>
              {mode === 'build'
                ? 'This agent can read, edit, move, and delete files and run commands. File changes are snapshotted, and risky actions pause for your approval.'
                : 'This agent can list files, read source, and search the repository. It cannot write files or run commands in Plan mode.'}
            </p>
            <div className="chat-suggestions">
              {(mode === 'build'
                ? [
                    'Add a small feature and show me the files you changed.',
                    'Fix the most important bug you can find and run the tests.',
                    'Review the project and improve its developer experience.',
                    'Run the test suite and fix the first failure.'
                  ]
                : [
                    'Give me a tour of this codebase.',
                    'Where is the application entry point?',
                    'Review the project structure and suggest the next three steps.',
                    'Find the main configuration files and explain them.'
                  ]).map((suggestion) => (
                <button
                  className="chat-suggestion"
                  key={suggestion}
                  type="button"
                  onClick={() => {
                    setDraft(suggestion)
                    textareaRef.current?.focus()
                  }}
                >
                  <Icon name="sparkles" size={14} />
                  {suggestion}
                </button>
              ))}
            </div>
            {!modelReady && (
              <div className="chat-blocker">
                <Icon name="alert" size={16} />
                <div>
                  <strong>No model is ready for this agent.</strong>
                  <span>Open Settings, Team and assign a model before chatting.</span>
                </div>
                <button className="btn btn-ghost btn-small" type="button" onClick={onOpenSettings}>
                  Open settings
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="chat-thread">
            {messages.map((message) => (
              <ChatMessageView
                key={message.id}
                message={message}
                agent={agent}
                streaming={sending && streamingMessageId === message.id}
                onOpenContext={setContextMessage}
                onRetry={
                  message.metadata?.retryable || message.metadata?.interrupted
                    ? retryMessage
                    : undefined
                }
              />
            ))}
            {sending && !streamingMessageId && (
              <div className="chat-preparing">
                <span className="thinking-dot" />
                <span className="thinking-dot" />
                <span className="thinking-dot" />
                Preparing context...
              </div>
            )}
          </div>
        )}
      </div>

      <div className="chat-composer-dock">
        <div className={modelReady ? 'chat-composer' : 'chat-composer disabled'}>
          {(imageWarning || providerKeyMissing || providerDisabled || (modelRecord && !supportsTools)) && (
            <div className="composer-warnings">
              {providerDisabled && (
                <span className="composer-warning">
                  <Icon name="alert" size={12} />
                  {provider?.name} is disabled.
                </span>
              )}
              {providerKeyMissing && (
                <span className="composer-warning">
                  <Icon name="alert" size={12} />
                  Add an API key for {provider?.name}.
                </span>
              )}
              {modelRecord && !supportsTools && (
                <span className="composer-warning">
                  <Icon name="alert" size={12} />
                  Chat-only model: repository tools are unavailable.
                </span>
              )}
              {imageWarning && (
                <span className="composer-warning">
                  <Icon name="alert" size={12} />
                  This model is not marked vision-capable. Image input may fail.
                </span>
              )}
            </div>
          )}

          {pendingImages.length > 0 && (
            <div className="composer-attachments">
              {pendingImages.map((image) => (
                <div className="composer-attachment" key={image.id}>
                  {image.dataUrl && <img src={image.dataUrl} alt={image.name} />}
                  <button
                    className="composer-attachment-remove"
                    type="button"
                    onClick={() =>
                      setPendingImages((current) =>
                        current.filter((entry) => entry.id !== image.id)
                      )
                    }
                    aria-label={`Remove ${image.name}`}
                    title="Remove image"
                  >
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            className="chat-composer-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder={
              modelReady
                ? mode === 'build'
                  ? `Tell ${agent.name.split(' ')[0]} what to build or change...`
                  : `Ask ${agent.name.split(' ')[0]} about the codebase...`
                : 'Assign a model in Settings, Team to unlock the composer.'
            }
            rows={1}
            disabled={!modelReady || sending}
          />

          <div className="chat-composer-bottom">
            <div className="chat-composer-left">
              <button
                className="icon-button composer-attach"
                type="button"
                onClick={() => void pickImages()}
                disabled={!modelReady || sending || pendingImages.length >= 4}
                title="Attach images"
                aria-label="Attach images"
              >
                <Icon name="paperclip" size={16} />
              </button>
              <button
                className={mode === 'plan' ? 'composer-mode active' : 'composer-mode'}
                type="button"
                onClick={() => void switchMode('plan')}
                disabled={sending}
                title="Switch to read-only Plan mode"
              >
                <Icon name="lock" size={11} />
                Plan
              </button>
              <button
                className={mode === 'build' ? 'composer-mode build active' : 'composer-mode build'}
                type="button"
                onClick={() => void switchMode('build')}
                disabled={sending}
                title="Switch to Build mode"
              >
                <Icon name="shield" size={11} />
                Build
              </button>
            </div>
            <div className="chat-composer-right">
              <span className="composer-count">{draft.length > 0 ? `${draft.length}` : ''}</span>
              {sending ? (
                <button
                  className="btn btn-ghost btn-small"
                  type="button"
                  onClick={() => void stop()}
                  disabled={!runId}
                >
                  <Icon name="stop" size={13} />
                  Stop
                </button>
              ) : (
                <button
                  className="btn btn-primary btn-small"
                  type="button"
                  onClick={() => void send()}
                  disabled={!canSend}
                >
                  Send
                  <Icon name="send" size={14} />
                </button>
              )}
            </div>
          </div>
        </div>

        {inlineError && (
          <div className="composer-inline-error">
            <Icon name="alert" size={13} />
            {inlineError}
          </div>
        )}

        <div className="composer-footnote">
          <span>
            <Icon name="shield" size={11} />
            {mode === 'build'
              ? 'Build mode. File changes are snapshotted; risky actions ask for approval.'
              : 'Read-only tools. No writes, commands, or network in Plan mode.'}
          </span>
          {active && (
            <span>
              {active.session.messageCount} message
              {active.session.messageCount === 1 ? '' : 's'} saved
            </span>
          )}
        </div>
      </div>

      {changesOpen && active && (
        <ChangesDialog
          sessionId={active.session.id}
          onClose={() => setChangesOpen(false)}
          onFilesChanged={onFilesChanged}
        />
      )}

      <ContextInspectorDialog
        message={contextMessage}
        onClose={() => setContextMessage(null)}
      />
    </div>
  )
}








