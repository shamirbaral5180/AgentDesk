import { useEffect, useRef, useState } from 'react'
import type {
  AgentSummary,
  AppSettings,
  MeetingDetail,
  MeetingEvent,
  MeetingMessage,
  MeetingPlan,
  MeetingSummary,
  ProjectInfo
} from '@shared/types'
import { agentModelLabel, formatRelativeTime } from '../lib/format'
import { Icon } from './Icon'
import { MessageText } from './MessageText'

type MeetingRoomProps = {
  project: ProjectInfo
  settings: AppSettings
  agents: AgentSummary[]
  onOpenSettings: () => void
  onStartBuild: (buildMeetingId: string) => void
  onError: (message: string) => void
  onFilesChanged: () => void
}

function statusLabel(status: MeetingSummary['status']): string {
  if (status === 'draft') return 'Ready'
  if (status === 'intake') return 'Intake'
  if (status === 'discussion') return 'Discussion'
  if (status === 'planning') return 'Planning'
  if (status === 'completed') return 'Completed'
  if (status === 'stopped') return 'Stopped'
  return 'Failed'
}

function phaseLabel(phase: string | undefined): string {
  if (phase === 'intake') return 'Intake'
  if (phase === 'discussion') return 'Discussion'
  if (phase === 'planning') return 'Plan'
  if (phase === 'direct') return 'Direct'
  if (phase === 'boss') return 'Boss'
  return 'Meeting'
}

function initials(name: string): string {
  return name
    .split(' ')
    .filter((part) => part !== '&')
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
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

function mergeMessage(
  detail: MeetingDetail,
  message: MeetingMessage
): MeetingDetail {
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

function appendDelta(
  detail: MeetingDetail,
  turnId: string,
  text: string
): MeetingDetail {
  return {
    ...detail,
    messages: detail.messages.map((message) =>
      message.metadata?.turnId === turnId
        ? { ...message, content: `${message.content}${text}` }
        : message
    )
  }
}

function UsageBar({ meeting }: { meeting: MeetingSummary }) {
  const totalTokens = meeting.usage.inputTokens + meeting.usage.outputTokens
  const tokenRatio =
    meeting.budget.maxTokens > 0 ? totalTokens / meeting.budget.maxTokens : 0
  const costRatio =
    meeting.budget.maxCostUsd > 0 ? meeting.usage.costUsd / meeting.budget.maxCostUsd : 0
  const turnRatio =
    meeting.budget.maxTurns > 0 ? meeting.usage.turns / meeting.budget.maxTurns : 0
  const highest = Math.min(Math.max(tokenRatio, costRatio, turnRatio), 1)
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
        <span style={{ width: `${Math.max(highest * 100, 2)}%` }} />
      </div>
    </div>
  )
}

function PlanCard({
  plan,
  meeting,
  approving,
  creatingBuild,
  onApprove,
  onStartBuild
}: {
  plan: MeetingPlan
  meeting: MeetingSummary
  approving: boolean
  creatingBuild: boolean
  onApprove: () => void
  onStartBuild: () => void
}) {
  const approved = Boolean(meeting.planApprovedAt)
  return (
    <section className={approved ? 'meeting-plan-card approved' : 'meeting-plan-card'}>
      <div className="meeting-plan-head">
        <div>
          <span className="eyebrow">Final plan</span>
          <h3>{plan.summary}</h3>
        </div>
        {plan.fallback && <span className="soft-chip warning">Fallback plan</span>}
        {approved && (
          <span className="soft-chip success">
            <Icon name="check" size={12} />
            Approved
          </span>
        )}
      </div>
      <p className="meeting-plan-approach">{plan.approach}</p>
      <div className="meeting-plan-stats">
        <span>{plan.tasks.length} tasks</span>
        <span>{plan.decisions.length} decisions</span>
        <span>{plan.fileClaims.length} file claims</span>
        <span>{plan.risks.length} risks</span>
      </div>
      <div className="meeting-plan-actions">
        <button
          className="btn btn-primary btn-small"
          type="button"
          onClick={onApprove}
          disabled={approved || approving}
        >
          <Icon name={approved ? 'check' : 'shield'} size={13} />
          {approved ? 'Plan approved' : approving ? 'Approving...' : 'Approve plan'}
        </button>
        <button
          className="btn btn-quiet btn-small"
          type="button"
          onClick={onStartBuild}
          disabled={!approved || creatingBuild}
          title={
            approved
              ? 'Create a Build meeting from this approved plan.'
              : 'Approve the plan before starting Build.'
          }
        >
          <Icon name="arrow-right" size={13} />
          {creatingBuild ? 'Creating Build...' : 'Start Build'}
        </button>
      </div>
    </section>
  )
}

export function MeetingRoom({
  project,
  settings,
  agents,
  onOpenSettings,
  onStartBuild,
  onError,
  onFilesChanged
}: MeetingRoomProps) {
  const [meetings, setMeetings] = useState<MeetingSummary[]>([])
  const [active, setActive] = useState<MeetingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [goal, setGoal] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [directMode, setDirectMode] = useState(false)
  const [directAgentId, setDirectAgentId] = useState('')
  const [draft, setDraft] = useState('')
  const [inlineError, setInlineError] = useState('')
  const [approving, setApproving] = useState(false)
  const [creatingBuild, setCreatingBuild] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const enabledAgents = agents.filter((agent) => agent.enabled)
  const readyAgents = enabledAgents.filter((agent) => Boolean(agentModelLabel(settings, agent)))
  const coordinator = enabledAgents.find((agent) => agent.roleKey === 'coordinator')
  const participantAgents = active?.meeting.participants ?? []
  const directCandidates =
    participantAgents.length > 0
      ? participantAgents.map((participant) => ({
          agentId: participant.agentId,
          name: participant.name
        }))
      : readyAgents.map((agent) => ({ agentId: agent.id, name: agent.name }))

  useEffect(() => {
    setSelectedIds(
      (readyAgents.length > 0 ? readyAgents : enabledAgents).map((agent) => agent.id)
    )
    setDirectAgentId('')
    setDirectMode(false)
  }, [project.id])

  useEffect(() => {
    if (!directAgentId && directCandidates.length > 0) {
      setDirectAgentId(directCandidates[0].agentId)
    }
  }, [directAgentId, directCandidates])

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
        const planMeetings = result.data.filter((meeting) => meeting.mode === 'plan')
        setMeetings(planMeetings)
        const latest = planMeetings.find(
          (meeting) =>
            meeting.status === 'intake' ||
            meeting.status === 'discussion' ||
            meeting.status === 'planning'
        ) ?? planMeetings[0]
        if (!latest) {
          setActive(null)
          return
        }
        const detail = await window.agentdesk.getMeeting(latest.id)
        if (cancelled) {
          return
        }
        if (!detail.ok) {
          setInlineError(detail.error.message)
          return
        }
        setActive(detail.data)
        setRunning(
          detail.data.meeting.status === 'intake' ||
            detail.data.meeting.status === 'discussion' ||
            detail.data.meeting.status === 'planning'
        )
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setInlineError(
            error instanceof Error ? error.message : 'Could not load plan meetings.'
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
  }, [project.id])

  useEffect(() => {
    const unsubscribe = window.agentdesk.onMeetingEvent((event: MeetingEvent) => {
      if (event.type === 'done' || event.type === 'cancelled') {
        setActive((current) =>
          !current || current.meeting.id === event.meetingId ? event.meeting : current
        )
        setMeetings((current) => mergeMeeting(current, event.meeting.meeting))
        setRunning(false)
        return
      }
      if (event.type === 'error') {
        setRunning(false)
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
        setRunning(event.meeting.status === 'intake' || event.meeting.status === 'discussion' || event.meeting.status === 'planning')
        setMeetings((current) => mergeMeeting(current, event.meeting))
        setActive((current) => {
          if (!current || current.meeting.id !== event.meeting.id) {
            return current
          }
          return { ...current, meeting: event.meeting }
        })
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

      if (event.type === 'message') {
        setActive((current) => {
          if (!current || current.meeting.id !== event.meetingId) {
            return current
          }
          return mergeMessage({ ...current, meeting: event.meeting }, event.message)
        })
        setMeetings((current) => mergeMeeting(current, event.meeting))
        if (
          event.message.kind === 'intake' ||
          event.message.kind === 'discussion' ||
          event.message.kind === 'plan'
        ) {
          onFilesChanged()
        }
        return
      }

      if (event.type === 'plan') {
        setActive((current) =>
          !current || current.meeting.id !== event.meetingId
            ? current
            : {
                ...current,
                meeting: event.meeting,
                plan: event.plan
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
  }, [active?.messages, running])

  useEffect(() => {
    const detail = active
    if (!detail || detail.meeting.planApprovedAt) {
      return
    }
    if (detail.meeting.status === 'completed') {
      setRunning(false)
    }
  }, [active?.meeting.status, active?.meeting.planApprovedAt])

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
    setDirectMode(false)
    setDraft('')
  }

  function toggleAgent(agentId: string): void {
    setSelectedIds((current) =>
      current.includes(agentId)
        ? current.filter((id) => id !== agentId)
        : [...current, agentId]
    )
  }

  async function createAndStart(): Promise<void> {
    if (running) {
      return
    }
    const trimmed = goal.trim()
    if (trimmed.length < 3) {
      setInlineError('Describe what the team should plan.')
      return
    }
    if (selectedIds.length === 0) {
      setInlineError('Select at least one agent for the meeting.')
      return
    }
    setInlineError('')
    setRunning(true)
    try {
      const created = await window.agentdesk.createMeeting({
        goal: trimmed,
        agentIds: selectedIds,
        mode: 'plan'
      })
      if (!created.ok) {
        setRunning(false)
        setInlineError(created.error.message)
        return
      }
      setActive(created.data)
      setMeetings((current) => mergeMeeting(current, created.data.meeting))
      const started = await window.agentdesk.startMeeting(created.data.meeting.id)
      if (!started.ok) {
        setRunning(false)
        setInlineError(started.error.message)
        return
      }
      setActive((current) =>
        current ? { ...current, meeting: started.data } : current
      )
      setMeetings((current) => mergeMeeting(current, started.data))
      setGoal('')
    } catch (error) {
      setRunning(false)
      setInlineError(
        error instanceof Error ? error.message : 'Could not start the meeting.'
      )
    }
  }

  async function stop(): Promise<void> {
    if (!active || !running) {
      return
    }
    const result = await window.agentdesk.stopMeeting(active.meeting.id)
    if (!result.ok) {
      setInlineError(result.error.message)
    }
  }

  async function approvePlan(): Promise<void> {
    if (!active || !active.plan || approving) {
      return
    }
    setApproving(true)
    setInlineError('')
    try {
      const result = await window.agentdesk.approveMeetingPlan(active.meeting.id)
      if (!result.ok) {
        setInlineError(result.error.message)
        return
      }
      setActive(result.data)
      setMeetings((current) => mergeMeeting(current, result.data.meeting))
    } finally {
      setApproving(false)
    }
  }

  async function startBuild(): Promise<void> {
    if (!active || !active.plan || !active.meeting.planApprovedAt || creatingBuild) {
      return
    }
    setCreatingBuild(true)
    setInlineError('')
    try {
      const result = await window.agentdesk.createBuildMeeting({
        planMeetingId: active.meeting.id
      })
      if (!result.ok) {
        setInlineError(result.error.message)
        return
      }
      onStartBuild(result.data.meeting.id)
    } catch (error) {
      setInlineError(
        error instanceof Error ? error.message : 'Could not create the Build meeting.'
      )
    } finally {
      setCreatingBuild(false)
    }
  }

  async function sendDirect(): Promise<void> {
    if (!active || running || !directAgentId) {
      return
    }
    const text = draft.trim()
    if (!text) {
      return
    }
    setInlineError('')
    setRunning(true)
    setDraft('')
    try {
      const result = await window.agentdesk.sendMeetingDirectMessage({
        meetingId: active.meeting.id,
        agentId: directAgentId,
        text
      })
      if (!result.ok) {
        setRunning(false)
        setInlineError(result.error.message)
        return
      }
      setActive((current) =>
        current ? { ...current, meeting: result.data } : current
      )
      setMeetings((current) => mergeMeeting(current, result.data))
    } catch (error) {
      setRunning(false)
      setInlineError(
        error instanceof Error ? error.message : 'Could not send the direct message.'
      )
    }
  }

  function newMeeting(): void {
    if (running) {
      return
    }
    setActive(null)
    setInlineError('')
    setDirectMode(false)
    setDraft('')
  }

  const selectedCount = selectedIds.length
  const canStart = goal.trim().length >= 3 && selectedCount > 0 && !running
  const messages = active?.messages ?? []
  const visibleMessages = messages.filter((message) => message.kind !== 'plan')

  return (
    <div className="meeting-room">
      <header className="meeting-header">
        <div className="meeting-header-copy">
          <div className="meeting-title-row">
            <span className="meeting-mark">
              <Icon name="users" size={17} />
            </span>
            <div>
              <div className="meeting-title-line">
                <h2>Plan room</h2>
                <span className="plan-pill">Plan</span>
                <span className="readonly-pill">
                  <Icon name="lock" size={11} />
                  Read-only
                </span>
                {active && (
                  <span className={`meeting-status status-${active.meeting.status}`}>
                    {statusLabel(active.meeting.status)}
                  </span>
                )}
              </div>
              <p>
                The team inspects the project, discusses the request, and returns an owned task
                plan without changing a single file.
              </p>
            </div>
          </div>
        </div>
        <div className="meeting-header-actions">
          <span className="chat-session-label">Meeting</span>
          <select
            className="chat-session-select meeting-select"
            value={active?.meeting.id ?? ''}
            onChange={(event) => void loadMeeting(event.target.value)}
            disabled={running || meetings.length === 0}
            aria-label="Plan meeting"
          >
            {active?.meeting.id && !meetings.some((meeting) => meeting.id === active.meeting.id) && (
              <option value={active.meeting.id}>{active.meeting.title}</option>
            )}
            {meetings.length === 0 && <option value="">No meetings yet</option>}
            {meetings.map((meeting) => (
              <option key={meeting.id} value={meeting.id}>
                {meeting.title}
              </option>
            ))}
          </select>
          <button
            className="btn btn-quiet btn-small"
            type="button"
            onClick={newMeeting}
            disabled={running}
          >
            <Icon name="plus" size={13} />
            New meeting
          </button>
          {running && (
            <button className="btn btn-ghost btn-small" type="button" onClick={() => void stop()}>
              <Icon name="stop" size={13} />
              Stop
            </button>
          )}
        </div>
      </header>

      <div className="meeting-body">
        <div className="meeting-scroll" ref={scrollRef}>
          {loading ? (
            <div className="chat-loading">
              <span />
              <span />
              <span />
            </div>
          ) : !active ? (
            <div className="meeting-new">
              <span className="eyebrow">New plan meeting</span>
              <h2>Give the team a goal. They will do the rest.</h2>
              <p>
                Every selected agent submits an intake card, the team discusses the tradeoffs, and
                the Coordinator returns a structured plan with owners, decisions, and proposed file
                claims.
              </p>
              <label className="field meeting-goal-field">
                <span>What should the team plan?</span>
                <textarea
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  rows={4}
                  maxLength={20_000}
                  placeholder="Example: Design the first-run onboarding flow and identify the files each specialist should own."
                />
              </label>
              <div className="meeting-roster-picker">
                <div className="meeting-roster-head">
                  <div>
                    <strong>Participants</strong>
                    <span>
                      {selectedCount} selected. {coordinator?.name ?? 'The Coordinator'} is always included.
                    </span>
                  </div>
                  <span className="soft-chip">{readyAgents.length} ready</span>
                </div>
                <div className="meeting-roster-grid">
                  {enabledAgents.map((agent) => {
                    const ready = Boolean(agentModelLabel(settings, agent))
                    const checked = selectedIds.includes(agent.id)
                    return (
                      <label
                        className={checked ? 'meeting-roster-card selected' : 'meeting-roster-card'}
                        key={agent.id}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleAgent(agent.id)}
                          disabled={running || !ready}
                        />
                        <span className="agent-dot" style={{ backgroundColor: agent.color }} />
                        <span className="meeting-roster-copy">
                          <strong>{agent.name}</strong>
                          <span>{ready ? agentModelLabel(settings, agent) : 'No model assigned'}</span>
                        </span>
                        {agent.roleKey === 'coordinator' && (
                          <span className="soft-chip">Lead</span>
                        )}
                      </label>
                    )
                  })}
                </div>
                <p className="meeting-roster-note">
                  Read-only tools only. No writes, commands, installs, or network access in this
                  meeting. Agents without a model are disabled.
                </p>
                {readyAgents.length === 0 && (
                  <div className="chat-blocker meeting-blocker">
                    <Icon name="alert" size={16} />
                    <div>
                      <strong>No participant has a model.</strong>
                      <span>Assign models in Settings, Team before starting a meeting.</span>
                    </div>
                    <button
                      className="btn btn-ghost btn-small"
                      type="button"
                      onClick={onOpenSettings}
                    >
                      Open settings
                    </button>
                  </div>
                )}
              </div>
              <div className="meeting-start-row">
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => void createAndStart()}
                  disabled={!canStart}
                >
                  <Icon name="sparkles" size={15} />
                  Start planning meeting
                </button>
                <span className="meeting-start-note">
                  Budget: {project.agents.length} agents, capped rounds, turns, tokens, cost, and time.
                </span>
              </div>
              {inlineError && (
                <div className="composer-inline-error">
                  <Icon name="alert" size={13} />
                  {inlineError}
                </div>
              )}
            </div>
          ) : (
            <div className="meeting-thread">
              <div className="meeting-goal-card">
                <div>
                  <span className="eyebrow">Boss goal</span>
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

              {visibleMessages.length === 0 && (
                <div className="meeting-waiting">
                  <span className="thinking-dot" />
                  <span className="thinking-dot" />
                  <span className="thinking-dot" />
                  Waiting for the first intake card...
                </div>
              )}

              {visibleMessages.map((message) => {
                const phase = message.metadata?.phase ?? message.kind
                const isBoss = message.senderType === 'boss'
                const participant = active.meeting.participants.find(
                  (entry) => entry.agentId === message.senderAgentId
                )
                const card = message.metadata?.card
                const toolCalls = message.metadata?.toolCalls ?? []
                const streaming = message.metadata?.status === 'streaming'
                return (
                  <article
                    className={isBoss ? 'meeting-message boss' : 'meeting-message'}
                    key={message.id}
                  >
                    <div className="meeting-message-avatar" style={{ backgroundColor: isBoss ? '#39485c' : participant?.color ?? '#8ab7ff' }}>
                      {isBoss ? 'B' : initials(message.senderName)}
                    </div>
                    <div className="meeting-message-main">
                      <div className="meeting-message-head">
                        <strong>{message.senderName}</strong>
                        <span className="meeting-phase-pill">{phaseLabel(phase)}</span>
                        {message.metadata?.round ? (
                          <span className="meeting-round">Round {message.metadata.round}</span>
                        ) : null}
                        {message.targetAgentId && (
                          <span className="meeting-target">
                            to {active.meeting.participants.find((entry) => entry.agentId === message.targetAgentId)?.name ?? 'agent'}
                          </span>
                        )}
                        <span className="meeting-time">{formatRelativeTime(message.createdAt)}</span>
                        {message.metadata?.usage && (
                          <span className="meeting-tokens">
                            {((message.metadata.usage.inputTokens ?? 0) + (message.metadata.usage.outputTokens ?? 0)).toLocaleString()} tokens
                          </span>
                        )}
                      </div>
                      <div className={streaming ? 'meeting-message-content streaming' : 'meeting-message-content'}>
                        {card ? (
                          <div className="meeting-intake-card">
                            <p>{card.understanding}</p>
                            {card.concerns.length > 0 && (
                              <div>
                                <span>Concerns</span>
                                <ul>
                                  {card.concerns.map((concern, index) => (
                                    <li key={`${message.id}-concern-${index}`}>{concern}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {card.files.length > 0 && (
                              <div className="meeting-intake-files">
                                <span>Files to inspect</span>
                                <div>
                                  {card.files.map((file) => (
                                    <code key={`${message.id}-file-${file}`}>{file}</code>
                                  ))}
                                </div>
                              </div>
                            )}
                            {card.risks.length > 0 && (
                              <div>
                                <span>Risks</span>
                                <ul>
                                  {card.risks.map((risk, index) => (
                                    <li key={`${message.id}-risk-${index}`}>{risk}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            <div className="meeting-intake-approach">
                              <span>Approach</span>
                              <p>{card.approach}</p>
                            </div>
                          </div>
                        ) : message.content.trim() ? (
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
                        {toolCalls.length > 0 && (
                          <div className="meeting-tool-row">
                            {toolCalls.map((tool) => (
                              <span
                                className={tool.status === 'error' ? 'meeting-tool error' : 'meeting-tool'}
                                key={tool.toolCallId}
                              >
                                <Icon name="terminal" size={10} />
                                {tool.toolName}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </article>
                )
              })}

              {active.plan && (
                <PlanCard
                  plan={active.plan}
                  meeting={active.meeting}
                  approving={approving}
                  creatingBuild={creatingBuild}
                  onApprove={() => void approvePlan()}
                  onStartBuild={() => void startBuild()}
                />
              )}
            </div>
          )}
        </div>

        {active && (
          <aside className="meeting-side">
            <section className="meeting-side-section">
              <div className="meeting-side-head">
                <span>Budget and safety</span>
                <Icon name="shield" size={13} />
              </div>
              <UsageBar meeting={active.meeting} />
              <div className="meeting-side-note">
                {active.meeting.planApprovedAt
                  ? 'Plan approved. Ready for the Phase 7 Build handoff.'
                  : active.meeting.stopReason
                    ? `Stopped: ${active.meeting.stopReason}`
                    : 'Hard caps are enforced by the runtime. No writes or commands are offered.'}
              </div>
            </section>

            <section className="meeting-side-section">
              <div className="meeting-side-head">
                <span>Tasks</span>
                <span className="meeting-side-count">{active.tasks.length}</span>
              </div>
              {active.tasks.length === 0 ? (
                <p className="meeting-side-empty">The Coordinator will propose owned tasks here.</p>
              ) : (
                <div className="meeting-side-list">
                  {active.tasks.map((task) => (
                    <div className="meeting-side-item" key={task.id}>
                      <div className="meeting-side-item-head">
                        <strong>{task.title}</strong>
                        <span className="soft-chip">P{task.priority}</span>
                      </div>
                      <p>{task.description}</p>
                      <span className="meeting-side-meta">
                        {active.meeting.participants.find((entry) => entry.agentId === task.assigneeAgentId)?.name ?? 'Unassigned'}
                      </span>
                      {task.fileGlobs.length > 0 && (
                        <div className="meeting-side-files">
                          {task.fileGlobs.map((glob) => (
                            <code key={`${task.id}-${glob}`}>{glob}</code>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="meeting-side-section">
              <div className="meeting-side-head">
                <span>Decisions</span>
                <span className="meeting-side-count">{active.decisions.length}</span>
              </div>
              {active.decisions.length === 0 ? (
                <p className="meeting-side-empty">Decisions and rationale will appear here.</p>
              ) : (
                <div className="meeting-side-list">
                  {active.decisions.map((decision) => (
                    <div className="meeting-side-item" key={decision.id}>
                      <strong>{decision.title}</strong>
                      <p>{decision.decision}</p>
                      {decision.rationale && <span className="meeting-side-meta">{decision.rationale}</span>}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="meeting-side-section">
              <div className="meeting-side-head">
                <span>File claims</span>
                <span className="meeting-side-count">{active.fileClaims.length}</span>
              </div>
              {active.fileClaims.length === 0 ? (
                <p className="meeting-side-empty">Proposed write scopes will appear here.</p>
              ) : (
                <div className="meeting-claim-list">
                  {active.fileClaims.map((claim) => (
                    <div className="meeting-claim" key={claim.id}>
                      <code>{claim.pathPrefix}</code>
                      <span>
                        {active.meeting.participants.find((entry) => entry.agentId === claim.agentId)?.name ?? claim.agentId}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {active.plan && active.plan.risks.length > 0 && (
              <section className="meeting-side-section">
                <div className="meeting-side-head">
                  <span>Risks</span>
                  <Icon name="alert" size={13} />
                </div>
                <ul className="meeting-risk-list">
                  {active.plan.risks.map((risk, index) => (
                    <li key={`risk-${index}`}>{risk}</li>
                  ))}
                </ul>
              </section>
            )}
          </aside>
        )}
      </div>

      {active && (
        <div className="meeting-composer-dock">
          <div className="meeting-composer">
            <div className="meeting-composer-top">
              <button
                className={!directMode ? 'composer-mode active' : 'composer-mode'}
                type="button"
                onClick={() => setDirectMode(false)}
                disabled={running}
              >
                <Icon name="users" size={11} />
                Meeting
              </button>
              <button
                className={directMode ? 'composer-mode active' : 'composer-mode'}
                type="button"
                onClick={() => setDirectMode(true)}
                disabled={running}
              >
                <Icon name="chat" size={11} />
                Direct
              </button>
              {directMode && (
                <select
                  className="meeting-direct-select"
                  value={directAgentId}
                  onChange={(event) => setDirectAgentId(event.target.value)}
                  disabled={running}
                >
                  {directCandidates.map((participant) => (
                    <option
                      key={participant.agentId}
                      value={participant.agentId}
                    >
                      {participant.name}
                    </option>
                  ))}
                </select>
              )}
              <span className="meeting-composer-mode-note">
                {directMode
                  ? 'One agent answers without rerunning the meeting.'
                  : 'Meeting turns are driven by the Coordinator. Use Direct for follow-ups.'}
              </span>
            </div>
            <textarea
              className="chat-composer-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={
                directMode
                  ? 'Ask one participant a focused follow-up...'
                  : 'Meeting mode is read-only. Switch to Direct to ask one agent a follow-up.'
              }
              rows={1}
              disabled={!directMode || running || !directAgentId}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void sendDirect()
                }
              }}
            />
            <div className="meeting-composer-bottom">
              <span className="composer-footnote">
                <Icon name="lock" size={11} />
                Read-only. No repository changes.
              </span>
              <div className="chat-composer-right">
                {running ? (
                  <button className="btn btn-ghost btn-small" type="button" onClick={() => void stop()}>
                    <Icon name="stop" size={13} />
                    Stop
                  </button>
                ) : (
                  <button
                    className="btn btn-primary btn-small"
                    type="button"
                    onClick={() => void sendDirect()}
                    disabled={!directMode || !directAgentId || !draft.trim()}
                  >
                    Send direct
                    <Icon name="send" size={13} />
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
        </div>
      )}
    </div>
  )
}
