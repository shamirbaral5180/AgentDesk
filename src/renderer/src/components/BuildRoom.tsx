import { useEffect, useRef, useState } from 'react'
import type {
  AgentSummary,
  ChatToolTrace,
  MeetingDetail,
  MeetingEvent,
  MeetingFinalReport,
  MeetingMessage,
  MeetingSummary,
  MeetingTask,
  ProjectInfo
} from '@shared/types'
import { formatRelativeTime } from '../lib/format'
import { ChangesDialog } from './ChangesDialog'
import { Icon } from './Icon'
import { MessageText } from './MessageText'

type BuildRoomProps = {
  project: ProjectInfo
  agents: AgentSummary[]
  initialMeetingId: string | null
  onOpenSettings: () => void
  onBackToPlan: () => void
  onError: (message: string) => void
  onFilesChanged: () => void
}

function buildStatusLabel(status: MeetingSummary['status']): string {
  if (status === 'draft') return 'Ready'
  if (status === 'building') return 'Building'
  if (status === 'reviewing') return 'Reviewing'
  if (status === 'reporting') return 'Reporting'
  if (status === 'completed') return 'Completed'
  if (status === 'stopped') return 'Stopped'
  return 'Failed'
}

function taskStatusLabel(status: MeetingTask['status']): string {
  if (status === 'proposed') return 'Proposed'
  if (status === 'queued') return 'Queued'
  if (status === 'in_progress') return 'In progress'
  if (status === 'review') return 'Review'
  if (status === 'changes_requested') return 'Changes requested'
  if (status === 'done') return 'Done'
  return 'Blocked'
}

function phaseLabel(phase: string | undefined): string {
  if (phase === 'build') return 'Build'
  if (phase === 'review') return 'QA review'
  if (phase === 'report') return 'Report'
  if (phase === 'interrupt') return 'Boss interrupt'
  if (phase === 'boss') return 'Boss'
  return 'Activity'
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '$0.00'
  }
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

function mergeMeeting(
  meetings: MeetingSummary[],
  meeting: MeetingSummary
): MeetingSummary[] {
  return [meeting, ...meetings.filter((entry) => entry.id !== meeting.id)].sort(
    (a, b) => b.updatedAt - a.updatedAt
  )
}

function mergeMessage(detail: MeetingDetail, message: MeetingMessage): MeetingDetail {
  const exists = detail.messages.some((entry) => entry.id === message.id)
  return {
    ...detail,
    messages: exists
      ? detail.messages.map((entry) => (entry.id === message.id ? message : entry))
      : [...detail.messages, message],
    meeting: {
      ...detail.meeting,
      messageCount: exists ? detail.meeting.messageCount : detail.meeting.messageCount + 1
    }
  }
}

function appendDelta(detail: MeetingDetail, turnId: string, text: string): MeetingDetail {
  return {
    ...detail,
    messages: detail.messages.map((message) =>
      message.metadata?.turnId === turnId
        ? { ...message, content: `${message.content}${text}` }
        : message
    )
  }
}

function mergeTask(detail: MeetingDetail, task: MeetingTask): MeetingDetail {
  const exists = detail.tasks.some((entry) => entry.id === task.id)
  return {
    ...detail,
    tasks: exists
      ? detail.tasks.map((entry) => (entry.id === task.id ? task : entry))
      : [...detail.tasks, task],
    meeting: {
      ...detail.meeting,
      taskCount: exists ? detail.meeting.taskCount : detail.meeting.taskCount + 1
    }
  }
}

function toolOutputText(tool: ChatToolTrace): string {
  if (typeof tool.output === 'string') {
    return tool.output
  }
  if (tool.output && typeof tool.output === 'object') {
    const value = tool.output as Record<string, unknown>
    const stdout = typeof value.stdout === 'string' ? value.stdout : ''
    const stderr = typeof value.stderr === 'string' ? value.stderr : ''
    return [stdout, stderr].filter(Boolean).join('\n')
  }
  return ''
}

function UsageBar({ meeting }: { meeting: MeetingSummary }) {
  const totalTokens = meeting.usage.inputTokens + meeting.usage.outputTokens
  return (
    <div className="meeting-usage">
      <div className="meeting-usage-row">
        <span>Turns</span>
        <strong>
          {meeting.usage.turns} / {meeting.budget.maxTurns}
        </strong>
      </div>
      <div className="meeting-usage-row">
        <span>Tokens</span>
        <strong>
          {totalTokens.toLocaleString()} / {meeting.budget.maxTokens.toLocaleString()}
        </strong>
      </div>
      <div className="meeting-usage-row">
        <span>Cost</span>
        <strong>
          {formatCost(meeting.usage.costUsd)} / {formatCost(meeting.budget.maxCostUsd)}
        </strong>
      </div>
      <div className="meeting-usage-row">
        <span>Time</span>
        <strong>
          {Math.round(meeting.usage.elapsedMs / 1000)}s / {meeting.budget.maxMinutes}m
        </strong>
      </div>
      <div className="meeting-meter">
        <span
          style={{
            width: `${Math.min(
              100,
              Math.max(
                2,
                (totalTokens / Math.max(meeting.budget.maxTokens, 1)) * 100
              )
            )}%`
          }}
        />
      </div>
    </div>
  )
}

function ReportCard({ report }: { report: MeetingFinalReport }) {
  return (
    <section className={report.partial ? 'build-report partial' : 'build-report'}>
      <div className="build-report-head">
        <div>
          <span className="eyebrow">Final build report</span>
          <h3>{report.summary}</h3>
        </div>
        <span className={report.partial ? 'soft-chip warning' : 'soft-chip success'}>
          {report.partial ? 'Partial' : 'Complete'}
        </span>
      </div>
      <div className="build-report-grid">
        <div>
          <span>Files changed</span>
          {report.filesChanged.length === 0 ? (
            <p>No file changes.</p>
          ) : (
            <ul>
              {report.filesChanged.map((file) => (
                <li key={`${file.type}-${file.path}-${file.taskId ?? 'none'}`}>
                  <code>{file.path}</code>
                  <em>{file.type}</em>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <span>Commands</span>
          {report.commands.length === 0 ? (
            <p>No commands.</p>
          ) : (
            <ul>
              {report.commands.map((command, index) => (
                <li key={`command-${index}`}>
                  <code>{command.command}</code>
                  <em>exit {command.exitCode ?? 'running'}</em>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <span>Tests</span>
          {report.tests.length === 0 ? <p>No test results recorded.</p> : <ul>{report.tests.map((test) => <li key={test}>{test}</li>)}</ul>}
        </div>
        <div>
          <span>Approvals</span>
          {report.approvals.length === 0 ? (
            <p>No approvals requested.</p>
          ) : (
            <ul>
              {report.approvals.map((approval) => (
                <li key={approval.id}>
                  {approval.actionType} - {approval.status} ({approval.risk})
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <span>Unresolved</span>
          {report.unresolved.length === 0 ? <p>Nothing unresolved.</p> : <ul>{report.unresolved.map((item) => <li key={item}>{item}</li>)}</ul>}
        </div>
        <div>
          <span>Revert</span>
          <ul>{report.revertInstructions.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      </div>
      <div className="build-report-tasks">
        {report.tasks.map((task) => (
          <span className={`build-task-pill status-${task.status}`} key={task.id}>
            {task.title}: {taskStatusLabel(task.status)}
          </span>
        ))}
      </div>
    </section>
  )
}

export function BuildRoom({
  project,
  agents,
  initialMeetingId,
  onOpenSettings,
  onBackToPlan,
  onError,
  onFilesChanged
}: BuildRoomProps) {
  const [meetings, setMeetings] = useState<MeetingSummary[]>([])
  const [active, setActive] = useState<MeetingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [inlineError, setInlineError] = useState('')
  const [changesOpen, setChangesOpen] = useState(false)
  const [interruptText, setInterruptText] = useState('')
  const [toolOutputs, setToolOutputs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const buildMeetings = meetings.filter((meeting) => meeting.mode === 'build')
  const coordinator = active?.meeting.participants.find(
    (participant) => participant.roleKey === 'coordinator'
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setInlineError('')
    window.agentdesk
      .listMeetings()
      .then(async (result) => {
        if (cancelled) {
          return
        }
        if (!result.ok) {
          setInlineError(result.error.message)
          return
        }
        const builds = result.data.filter((meeting) => meeting.mode === 'build')
        setMeetings(builds)
        const targetId =
          initialMeetingId && builds.some((meeting) => meeting.id === initialMeetingId)
            ? initialMeetingId
            : builds.find(
                (meeting) =>
                  meeting.status === 'building' ||
                  meeting.status === 'reviewing' ||
                  meeting.status === 'reporting'
              )?.id ?? builds[0]?.id
        if (!targetId) {
          setActive(null)
          return
        }
        const detail = await window.agentdesk.getMeeting(targetId)
        if (cancelled) {
          return
        }
        if (!detail.ok) {
          setInlineError(detail.error.message)
          return
        }
        setActive(detail.data)
        setRunning(
          detail.data.meeting.status === 'building' ||
            detail.data.meeting.status === 'reviewing' ||
            detail.data.meeting.status === 'reporting'
        )
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setInlineError(
            error instanceof Error ? error.message : 'Could not load Build meetings.'
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
  }, [project.id, initialMeetingId])

  useEffect(() => {
    const unsubscribe = window.agentdesk.onMeetingEvent((event: MeetingEvent) => {
      if (event.type === 'done' || event.type === 'cancelled') {
        setActive((current) =>
          !current || current.meeting.id === event.meetingId ? event.meeting : current
        )
        setMeetings((current) => mergeMeeting(current, event.meeting.meeting))
        setRunning(false)
        setBusy(false)
        onFilesChanged()
        return
      }
      if (event.type === 'error') {
        setRunning(false)
        setBusy(false)
        setInlineError(event.message)
        onError(event.message)
        if (event.meeting) {
          setActive((current) =>
            !current || current.meeting.id === event.meetingId ? event.meeting : current
          )
          setMeetings((current) => mergeMeeting(current, event.meeting!.meeting))
        }
        return
      }
      if (event.type === 'meeting-start' || event.type === 'meeting-update') {
        setRunning(
          event.meeting.status === 'building' ||
            event.meeting.status === 'reviewing' ||
            event.meeting.status === 'reporting'
        )
        setMeetings((current) => mergeMeeting(current, event.meeting))
        setActive((current) =>
          !current || current.meeting.id !== event.meeting.id
            ? current
            : { ...current, meeting: event.meeting }
        )
        return
      }
      if (event.type === 'turn-start') {
        setActive((current) => {
          if (!current || current.meeting.id !== event.meetingId) {
            return current
          }
          return mergeMessage({ ...current, meeting: event.meeting }, event.message)
        })
        return
      }
      if (event.type === 'delta') {
        setActive((current) =>
          !current || current.meeting.id !== event.meetingId
            ? current
            : appendDelta(current, event.turnId, event.text)
        )
        return
      }
      if (event.type === 'tool-output') {
        setToolOutputs((current) => ({
          ...current,
          [`${event.turnId}:${event.toolCallId}`]: `${
            current[`${event.turnId}:${event.toolCallId}`] ?? ''
          }${event.text}`
        }))
        return
      }
      if (event.type === 'message') {
        setActive((current) => {
          if (!current || current.meeting.id !== event.meetingId) {
            return current
          }
          return mergeMessage({ ...current, meeting: event.meeting }, event.message)
        })
        setMeetings((current) => mergeMeeting(current, event.meeting))
        if (event.message.kind === 'build' || event.message.kind === 'review') {
          onFilesChanged()
        }
        return
      }
      if (event.type === 'task') {
        setActive((current) =>
          !current || current.meeting.id !== event.meetingId
            ? current
            : mergeTask({ ...current, meeting: event.meeting }, event.task)
        )
        setMeetings((current) => mergeMeeting(current, event.meeting))
        return
      }
      if (event.type === 'report') {
        setActive((current) =>
          !current || current.meeting.id !== event.meetingId
            ? current
            : {
                ...current,
                meeting: event.meeting,
                finalReport: event.report
              }
        )
        setMeetings((current) => mergeMeeting(current, event.meeting))
      }
    })
    return unsubscribe
  }, [onError, onFilesChanged])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    element.scrollTo({
      top: element.scrollHeight,
      behavior: running ? 'smooth' : 'auto'
    })
  }, [active?.messages, active?.tasks, running])

  async function loadMeeting(meetingId: string): Promise<void> {
    if (!meetingId || running) {
      return
    }
    setInlineError('')
    const result = await window.agentdesk.getMeeting(meetingId)
    if (!result.ok) {
      setInlineError(result.error.message)
      return
    }
    setActive(result.data)
    setToolOutputs({})
  }

  async function startBuild(): Promise<void> {
    const resumable =
      active?.meeting.status === 'draft' ||
      (active?.meeting.status === 'stopped' && active.meeting.stopReason === 'paused')
    if (!active || running || !resumable) {
      return
    }
    setBusy(true)
    setInlineError('')
    try {
      const result = await window.agentdesk.startMeeting(active.meeting.id)
      if (!result.ok) {
        setInlineError(result.error.message)
        setBusy(false)
        return
      }
      setActive((current) =>
        current ? { ...current, meeting: result.data, finalReport: null } : current
      )
      setMeetings((current) => mergeMeeting(current, result.data))
      setRunning(true)
    } catch (error) {
      setBusy(false)
      setInlineError(
        error instanceof Error ? error.message : 'Could not start the Build meeting.'
      )
    }
  }

  async function stopBuild(): Promise<void> {
    if (!active || !running) {
      return
    }
    setBusy(true)
    const result = await window.agentdesk.stopMeeting(active.meeting.id)
    if (!result.ok) {
      setInlineError(result.error.message)
    } else {
      setMeetings((current) => mergeMeeting(current, result.data))
    }
    setBusy(false)
  }

  async function pauseBuild(): Promise<void> {
    if (!active || !running) {
      return
    }
    setBusy(true)
    const result = await window.agentdesk.pauseMeeting(active.meeting.id)
    if (!result.ok) {
      setInlineError(result.error.message)
    } else {
      setMeetings((current) => mergeMeeting(current, result.data))
    }
    setBusy(false)
  }

  async function sendInterrupt(mode: 'queue' | 'immediate'): Promise<void> {
    if (!active || !interruptText.trim()) {
      return
    }
    setBusy(true)
    setInlineError('')
    try {
      const result = await window.agentdesk.queueMeetingInterrupt({
        meetingId: active.meeting.id,
        text: interruptText.trim(),
        mode
      })
      if (!result.ok) {
        setInlineError(result.error.message)
        return
      }
      setInterruptText('')
      setMeetings((current) => mergeMeeting(current, result.data))
      if (mode === 'immediate') {
        setRunning(false)
      }
    } catch (error) {
      setInlineError(
        error instanceof Error ? error.message : 'Could not deliver the interrupt.'
      )
    } finally {
      setBusy(false)
    }
  }

  async function revertTask(task: MeetingTask): Promise<void> {
    if (!active || busy) {
      return
    }
    const confirmed = window.confirm(
      `Revert every file change recorded for "${task.title}"? This restores prior snapshots and records the revert.`
    )
    if (!confirmed) {
      return
    }
    setBusy(true)
    setInlineError('')
    try {
      const result = await window.agentdesk.revertTaskChanges({
        sessionId: active.meeting.sessionId,
        taskId: task.id
      })
      if (!result.ok) {
        setInlineError(result.error.message)
        return
      }
      onFilesChanged()
      const refreshed = await window.agentdesk.getMeeting(active.meeting.id)
      if (refreshed.ok) {
        setActive(refreshed.data)
      }
    } catch (error) {
      setInlineError(
        error instanceof Error ? error.message : 'Could not revert the task changes.'
      )
    } finally {
      setBusy(false)
    }
  }

  const messages = active?.messages ?? []
  const visibleMessages = messages.filter(
    (message) => message.kind !== 'report' && message.kind !== 'dispatch'
  )
  const tasks = active?.tasks ?? []

  return (
    <div className="build-room">
      <header className="meeting-header build-header">
        <div className="meeting-header-copy">
          <div className="meeting-title-row">
            <span className="meeting-mark build-mark">
              <Icon name="shield" size={17} />
            </span>
            <div>
              <div className="meeting-title-line">
                <h2>Build room</h2>
                <span className="plan-pill build">Build</span>
                <span className="readonly-pill">
                  <Icon name="shield" size={11} />
                  Approval-aware
                </span>
                {active && (
                  <span className={`meeting-status status-${active.meeting.status}`}>
                    {buildStatusLabel(active.meeting.status)}
                  </span>
                )}
              </div>
              <p>
                One writer at a time. File claims are enforced, every change is snapshotted, and QA
                reviews each task before it is marked done.
              </p>
            </div>
          </div>
        </div>
        <div className="meeting-header-actions">
          <span className="chat-session-label">Build</span>
          <select
            className="chat-session-select meeting-select"
            value={active?.meeting.id ?? ''}
            onChange={(event) => void loadMeeting(event.target.value)}
            disabled={running || buildMeetings.length === 0}
            aria-label="Build meeting"
          >
            {active?.meeting.id && !buildMeetings.some((meeting) => meeting.id === active.meeting.id) && (
              <option value={active.meeting.id}>{active.meeting.title}</option>
            )}
            {buildMeetings.length === 0 && <option value="">No Build meetings yet</option>}
            {buildMeetings.map((meeting) => (
              <option key={meeting.id} value={meeting.id}>
                {meeting.title}
              </option>
            ))}
          </select>
          <button className="btn btn-quiet btn-small" type="button" onClick={onBackToPlan} disabled={running}>
            <Icon name="arrow-right" size={13} />
            Plan room
          </button>
          {active && (
            <button
              className="btn btn-quiet btn-small"
              type="button"
              onClick={() => setChangesOpen(true)}
              disabled={running}
            >
              <Icon name="clock" size={13} />
              Changes
            </button>
          )}
          {active &&
            (active.meeting.status === 'draft' ||
              (active.meeting.status === 'stopped' && active.meeting.stopReason === 'paused')) && (
              <button
                className="btn btn-primary btn-small"
                type="button"
                onClick={() => void startBuild()}
                disabled={busy}
              >
                <Icon name="terminal" size={13} />
                {active.meeting.status === 'draft' ? 'Start Build' : 'Resume Build'}
              </button>
            )}
          {running && (
            <>
              <button className="btn btn-quiet btn-small" type="button" onClick={() => void pauseBuild()} disabled={busy}>
                <Icon name="clock" size={13} />
                Pause
              </button>
              <button className="btn btn-ghost btn-small" type="button" onClick={() => void stopBuild()} disabled={busy}>
                <Icon name="stop" size={13} />
                Stop
              </button>
            </>
          )}
        </div>
      </header>

      <div className="meeting-body build-body">
        <div className="meeting-scroll" ref={scrollRef}>
          {loading ? (
            <div className="chat-loading">
              <span />
              <span />
              <span />
            </div>
          ) : !active ? (
            <div className="build-empty">
              <span className="meeting-mark build-mark">
                <Icon name="shield" size={22} />
              </span>
              <h2>No approved plan is ready for Build.</h2>
              <p>
                Open the Plan room, run a team meeting, and approve the plan. The Build room then
                creates queued tasks with owners and file claims.
              </p>
              <div className="build-empty-actions">
                <button className="btn btn-primary" type="button" onClick={onBackToPlan}>
                  <Icon name="arrow-right" size={14} />
                  Go to Plan room
                </button>
                <button className="btn btn-quiet" type="button" onClick={onOpenSettings}>
                  <Icon name="settings" size={14} />
                  Team settings
                </button>
              </div>
              {inlineError && (
                <div className="composer-inline-error">
                  <Icon name="alert" size={13} />
                  {inlineError}
                </div>
              )}
            </div>
          ) : (
            <div className="build-thread">
              <div className="meeting-goal-card">
                <div>
                  <span className="eyebrow">Approved Build goal</span>
                  <h2>{active.meeting.goal}</h2>
                </div>
                <div className="meeting-goal-meta">
                  <span>{active.meeting.participants.length} participants</span>
                  <span>{formatRelativeTime(active.meeting.createdAt)}</span>
                  {active.meeting.stopReason && active.meeting.status !== 'completed' && (
                    <span className="meeting-stop-reason">
                      Stop: {active.meeting.stopReason}
                    </span>
                  )}
                </div>
              </div>

              {visibleMessages.length === 0 && !active.finalReport && (
                <div className="meeting-waiting">
                  <span className="thinking-dot" />
                  <span className="thinking-dot" />
                  <span className="thinking-dot" />
                  {active.meeting.status === 'draft'
                    ? 'Ready. Start Build to dispatch the first task.'
                    : 'Waiting for the first Build turn...'}
                </div>
              )}

              {visibleMessages.map((message) => {
                const isBoss = message.senderType === 'boss'
                const participant = active.meeting.participants.find(
                  (entry) => entry.agentId === message.senderAgentId
                )
                const streaming = message.metadata?.status === 'streaming'
                const toolCalls = message.metadata?.toolCalls ?? []
                return (
                  <article className={isBoss ? 'meeting-message boss' : 'meeting-message'} key={message.id}>
                    <div
                      className="meeting-message-avatar"
                      style={{
                        backgroundColor: isBoss
                          ? '#39485c'
                          : participant?.color ?? '#8ab7ff'
                      }}
                    >
                      {isBoss
                        ? 'B'
                        : message.senderName
                            .split(' ')
                            .filter((part) => part !== '&')
                            .slice(0, 2)
                            .map((part) => part[0])
                            .join('')}
                    </div>
                    <div className="meeting-message-main">
                      <div className="meeting-message-head">
                        <strong>{message.senderName}</strong>
                        <span className="meeting-phase-pill">
                          {phaseLabel(message.metadata?.phase ?? message.kind)}
                        </span>
                        {message.metadata?.round ? (
                          <span className="meeting-round">Round {message.metadata.round}</span>
                        ) : null}
                        <span className="meeting-time">{formatRelativeTime(message.createdAt)}</span>
                        {message.metadata?.usage && (
                          <span className="meeting-tokens">
                            {(
                              (message.metadata.usage.inputTokens ?? 0) +
                              (message.metadata.usage.outputTokens ?? 0)
                            ).toLocaleString()}{' '}
                            tokens
                          </span>
                        )}
                      </div>
                      <div className={streaming ? 'meeting-message-content streaming' : 'meeting-message-content'}>
                        {message.content.trim() ? (
                          <MessageText content={message.content} />
                        ) : streaming ? (
                          <div className="meeting-typing">
                            <span className="thinking-dot" />
                            <span className="thinking-dot" />
                            <span className="thinking-dot" />
                          </div>
                        ) : (
                          <p className="meeting-empty-turn">No response.</p>
                        )}
                        {message.metadata?.turnId &&
                          Object.entries(toolOutputs)
                            .filter(([key]) => key.startsWith(`${message.metadata!.turnId}:`))
                            .slice(-2)
                            .map(([key, text]) =>
                              text.trim() ? (
                                <pre className="build-command-live" key={key}>
                                  {text.slice(-4_000)}
                                </pre>
                              ) : null
                            )}
                        {toolCalls.length > 0 && (
                          <div className="build-tool-traces">
                            {toolCalls.map((tool) => (
                              <div className="build-tool-trace" key={tool.toolCallId}>
                                <span className="meeting-tool">
                                  <Icon name="terminal" size={10} />
                                  {tool.toolName}
                                  {tool.status === 'error' ? ' (error)' : ''}
                                </span>
                                {toolOutputText(tool) && (
                                  <pre>{toolOutputText(tool).slice(-4_000)}</pre>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </article>
                )
              })}

              {active.finalReport && <ReportCard report={active.finalReport} />}
            </div>
          )}
        </div>

        {active && (
          <aside className="meeting-side build-side">
            <section className="meeting-side-section">
              <div className="meeting-side-head">
                <span>Budget and safety</span>
                <Icon name="shield" size={13} />
              </div>
              <UsageBar meeting={active.meeting} />
              <div className="meeting-side-note">
                {active.meeting.status === 'completed'
                  ? 'Build completed. Review the final report and change log.'
                  : active.meeting.stopReason
                    ? `Stopped: ${active.meeting.stopReason}`
                    : 'Every write is claim-checked and snapshotted. Approvals pause the meeting.'}
              </div>
            </section>

            <section className="meeting-side-section">
              <div className="meeting-side-head">
                <span>Task board</span>
                <span className="meeting-side-count">{tasks.length}</span>
              </div>
              {tasks.length === 0 ? (
                <p className="meeting-side-empty">Tasks appear when Build starts.</p>
              ) : (
                <div className="build-task-list">
                  {tasks.map((task) => (
                    <div className={`build-task-card status-${task.status}`} key={task.id}>
                      <div className="build-task-head">
                        <strong>{task.title}</strong>
                        <span className={`build-task-status status-${task.status}`}>
                          {taskStatusLabel(task.status)}
                        </span>
                      </div>
                      <p>{task.description}</p>
                      <div className="build-task-meta">
                        <span>
                          {active.meeting.participants.find(
                            (entry) => entry.agentId === task.assigneeAgentId
                          )?.name ?? 'Unassigned'}
                        </span>
                        <span>P{task.priority}</span>
                        <span>Review {task.reviewCycles}</span>
                      </div>
                      {task.fileGlobs.length > 0 && (
                        <div className="meeting-side-files">
                          {task.fileGlobs.map((glob) => (
                            <code key={`${task.id}-${glob}`}>{glob}</code>
                          ))}
                        </div>
                      )}
                      {task.status !== 'done' && task.acceptanceCriteria && (
                        <span className="build-task-acceptance">{task.acceptanceCriteria}</span>
                      )}
                      {task.status === 'done' && (
                        <button
                          className="btn btn-quiet btn-small"
                          type="button"
                          onClick={() => void revertTask(task)}
                          disabled={busy || running}
                        >
                          <Icon name="refresh" size={12} />
                          Revert task
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="meeting-side-section">
              <div className="meeting-side-head">
                <span>Review loop</span>
                <Icon name="check" size={13} />
              </div>
              <p className="meeting-side-empty">
                QA reviews each task. Changes requested return the task to its owner for a focused
                fix, up to {active.meeting.budget.maxReviewCycles} cycles.
              </p>
            </section>

            <section className="meeting-side-section">
              <div className="meeting-side-head">
                <span>Handoff</span>
                <span className="meeting-side-count">
                  {active.meeting.parentMeetingId ? 'Plan' : 'Root'}
                </span>
              </div>
              <p className="meeting-side-empty">
                Coordinator: {coordinator?.name ?? 'missing'}. {agents.filter((agent) => agent.enabled).length} enabled roster agents.
                {active.meeting.parentMeetingId
                  ? ' This Build is linked to its approved Plan meeting.'
                  : ' No parent plan is linked.'}
              </p>
            </section>
          </aside>
        )}
      </div>

      {active && (
        <div className="meeting-composer-dock build-composer-dock">
          <div className="meeting-composer build-composer">
            <div className="meeting-composer-top">
              <span className="meeting-composer-mode-note">
                {running
                  ? 'Build is running. Queue an update for the next turn, or interrupt now to stop and report.'
                  : 'Build is not running. Interrupts are delivered to the next Build turn.'}
              </span>
            </div>
            <textarea
              className="chat-composer-input"
              value={interruptText}
              onChange={(event) => setInterruptText(event.target.value)}
              placeholder="Queue a Boss update for the next turn..."
              rows={1}
              disabled={busy}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void sendInterrupt('queue')
                }
              }}
            />
            <div className="meeting-composer-bottom">
              <span className="composer-footnote">
                <Icon name="shield" size={11} />
                Writes require an active task claim and are snapshotted.
              </span>
              <div className="chat-composer-right">
                {running && (
                  <button
                    className="btn btn-ghost btn-small"
                    type="button"
                    onClick={() => void sendInterrupt('immediate')}
                    disabled={busy || !interruptText.trim()}
                    title="Stop the current Build turn and produce a partial report."
                  >
                    <Icon name="stop" size={13} />
                    Interrupt now
                  </button>
                )}
                <button
                  className="btn btn-primary btn-small"
                  type="button"
                  onClick={() => void sendInterrupt('queue')}
                  disabled={busy || !interruptText.trim()}
                >
                  Queue update
                  <Icon name="send" size={13} />
                </button>
              </div>
            </div>
          </div>
          {inlineError && (
            <div className="composer-inline-error">
              <Icon name="alert" size={13} />
              {inlineError}
            </div>
          )}
        </div>
      )}

      {changesOpen && active && (
        <ChangesDialog
          sessionId={active.meeting.sessionId}
          onClose={() => setChangesOpen(false)}
          onFilesChanged={onFilesChanged}
        />
      )}
    </div>
  )
}
