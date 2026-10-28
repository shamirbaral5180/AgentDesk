import type { AgentSummary, ChatMessage } from '@shared/types'
import { formatRelativeTime } from '../lib/format'
import { Icon } from './Icon'
import { MessageText } from './MessageText'

type ChatMessageViewProps = {
  message: ChatMessage
  agent: AgentSummary
  streaming: boolean
  onOpenContext: (message: ChatMessage) => void
  onRetry?: (message: ChatMessage) => void
}

function initials(name: string): string {
  return name
    .split(' ')
    .filter((part) => part !== '&')
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
}

function toolSummary(message: ChatMessage): string {
  const tools = message.metadata?.toolCalls ?? []
  if (tools.length === 0) {
    return ''
  }
  const done = tools.filter((tool) => tool.status === 'done').length
  const failed = tools.filter((tool) => tool.status === 'error').length
  const running = tools.filter((tool) => tool.status === 'running').length
  if (running > 0) {
    return `Inspecting the repository  -  ${done + failed}/${tools.length} finished`
  }
  if (failed > 0) {
    return `${done} tool${done === 1 ? '' : 's'} completed  -  ${failed} failed`
  }
  return `Inspected ${done} tool${done === 1 ? '' : 's'}`
}

function toolInput(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function ChatMessageView({
  message,
  agent,
  streaming,
  onOpenContext,
  onRetry
}: ChatMessageViewProps) {
  const isUser = message.role === 'user'
  const toolCalls = message.metadata?.toolCalls ?? []
  const context = message.metadata?.context
  const usage = context?.usage ?? message.metadata?.usage
  const tokens =
    usage?.inputTokens !== undefined || usage?.outputTokens !== undefined
      ? `${(usage.inputTokens ?? 0).toLocaleString()} in  -  ${(
          usage.outputTokens ?? 0
        ).toLocaleString()} out`
      : null

  return (
    <article className={isUser ? 'chat-message user' : 'chat-message assistant'}>
      <div
        className={isUser ? 'chat-avatar user-avatar' : 'chat-avatar'}
        style={isUser ? undefined : { backgroundColor: agent.color }}
      >
        {isUser ? 'You' : initials(agent.name)}
      </div>

      <div className="chat-message-body">
        <div className="chat-message-head">
          <strong>{isUser ? message.senderName : message.senderName || agent.name}</strong>
          {!isUser && context && (
            <span className="chat-model-chip">
              <Icon name="sparkles" size={11} />
              {context.model.displayName}
            </span>
          )}
          <span className="chat-time">{formatRelativeTime(message.createdAt)}</span>
          {streaming && <span className="streaming-pill">Streaming</span>}
        </div>

        {message.attachments.length > 0 && (
          <div className="chat-attachments">
            {message.attachments.map((attachment) => (
              <a
                className="chat-attachment"
                key={attachment.id}
                href={attachment.dataUrl}
                onClick={(event) => {
                  if (!attachment.dataUrl) {
                    event.preventDefault()
                  }
                }}
                title={attachment.name}
              >
                {attachment.dataUrl ? (
                  <img src={attachment.dataUrl} alt={attachment.name} />
                ) : (
                  <span className="chat-attachment-missing">
                    <Icon name="image" size={18} />
                  </span>
                )}
              </a>
            ))}
          </div>
        )}

        {toolCalls.length > 0 && (
          <details className="tool-trace" open={streaming}>
            <summary>
              <span className="tool-trace-icon">
                <Icon name="terminal" size={14} />
              </span>
              <span>{toolSummary(message)}</span>
              <span className="tool-trace-count">{toolCalls.length}</span>
            </summary>
            <div className="tool-trace-list">
              {toolCalls.map((tool) => (
                <details className="tool-trace-item" key={tool.toolCallId}>
                  <summary>
                    <code>{tool.toolName}</code>
                    <span className={`tool-status ${tool.status}`}>
                      {tool.status === 'running'
                        ? 'running'
                        : tool.status === 'error'
                          ? 'failed'
                          : `${tool.durationMs ?? 0} ms`}
                    </span>
                  </summary>
                  <div className="tool-trace-detail">
                    <span>Input</span>
                    <pre>{toolInput(tool.input)}</pre>
                    {tool.output !== undefined && (
                      <>
                        <span>Output</span>
                        <pre>
                          {(() => {
                            const value =
                              typeof tool.output === 'string'
                                ? tool.output
                                : JSON.stringify(tool.output, null, 2)
                            return value.length > 5000
                              ? `${value.slice(0, 5000)}\n...`
                              : value
                          })()}
                        </pre>
                      </>
                    )}
                    {tool.error && <p className="tool-error">{tool.error}</p>}
                  </div>
                </details>
              ))}
            </div>
          </details>
        )}

        {message.content.trim() ? (
          <MessageText content={message.content} />
        ) : streaming ? (
          <div className="thinking-line">
            <span className="thinking-dot" />
            <span className="thinking-dot" />
            <span className="thinking-dot" />
            <span>Thinking through the project...</span>
          </div>
        ) : (
          <p className="message-empty">No text response.</p>
        )}

        {message.metadata?.status === 'error' && message.metadata.error && (
          <div className="message-error">
            <Icon name="alert" size={14} />
            <span>{message.metadata.error}</span>
            {message.metadata.retryable && onRetry && (
              <button
                className="btn btn-quiet btn-small"
                type="button"
                onClick={() => onRetry(message)}
              >
                Retry
              </button>
            )}
          </div>
        )}

        {message.metadata?.status === 'interrupted' && (
          <div className="message-error interrupted">
            <Icon name="alert" size={14} />
            <span>
              {message.metadata.error ??
                'This response was interrupted when AgentDesk stopped. Retry manually.'}
            </span>
            {onRetry && (
              <button
                className="btn btn-quiet btn-small"
                type="button"
                onClick={() => onRetry(message)}
              >
                Retry
              </button>
            )}
          </div>
        )}

        {!isUser && (
          <div className="chat-message-foot">
            {tokens && (
              <span className="chat-token-chip">
                <Icon name="database" size={12} />
                {tokens}
              </span>
            )}
            {message.metadata?.cancelled && (
              <span className="chat-token-chip">Stopped by Boss</span>
            )}
            <div className="chat-message-actions">
              {context && (
                <button
                  className="btn btn-quiet btn-small message-context-button"
                  type="button"
                  onClick={() => onOpenContext(message)}
                >
                  <Icon name="panel" size={13} />
                  Context
                </button>
              )}
              <button
                className="icon-button chat-copy"
                type="button"
                title="Copy answer"
                aria-label="Copy answer"
                onClick={() => {
                  void navigator.clipboard.writeText(message.content).catch(() => undefined)
                }}
              >
                <Icon name="copy" size={13} />
              </button>
            </div>
          </div>
        )}
      </div>
    </article>
  )
}


