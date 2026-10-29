import { useEffect, useRef, useState } from 'react'
import type {
  AgentSummary,
  AppInfo,
  AppSettings,
  MeetingDetail,
  MeetingEvent,
  MeetingMessage,
  MeetingMode,
  MeetingSummary,
  MeetingTask,
  ProjectInfo
} from '@shared/types'
import { Brand } from './Brand'
import { FileTree } from './FileTree'
import { Icon } from './Icon'
import { MessageText } from './MessageText'
import { shortPath } from '../lib/format'

type ProjectDeskProps = {
  project: ProjectInfo
  appInfo: AppInfo
  settings: AppSettings
  busy: string | null
  onCloseProject: () => void
  onOpenSettings: () => void
  onRevealProject: () => void
  onError: (message: string) => void
}

const ACTIVE_STATUSES = new Set([
  'intake',
  'discussion',
  'planning',
  'building',
  'reviewing',
  'reporting'
])

function isRunning(meeting: MeetingSummary | undefined): boolean {
  return Boolean(meeting && ACTIVE_STATUSES.has(meeting.status))
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
      : [...detail.messages, message]
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
      : [...detail.tasks, task]
  }
}

function cleanChatText(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let structured = false
    try {
      const parsed = JSON.parse(trimmed) as unknown
      structured = typeof parsed === 'object' && parsed !== null
    } catch {
      structured = /"(understanding|concerns|summary|tasks|status|issues)"\s*:/.test(trimmed)
    }
    if (structured) {
      return 'Structured details hidden from chat. See the plan card, task board, and live activity for the English summary.'
    }
  }
  return text.replace(/```[\s\S]*?```/g, (block) =>
    block.length > 700 ? '\n[code omitted from chat - see the project files]\n' : block
  )
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

function agentStatus(
  agent: AgentSummary,
  detail: MeetingDetail | null
): { label: string; tone: string } {
  if (!agent.enabled) {
    return { label: 'Off', tone: 'off' }
  }
  if (!agent.modelLabel) {
    return { label: 'Set up', tone: 'warn' }
  }
  if (!detail) {
    return { label: 'Ready', tone: 'ready' }
  }
  const tasks = detail.tasks.filter((task) => task.assigneeAgentId === agent.id)
  if (tasks.some((task) => task.status === 'review')) {
    return { label: 'Reviewing', tone: 'busy' }
  }
  if (tasks.some((task) => task.status === 'in_progress')) {
    return { label: 'Working', tone: 'busy' }
  }
  if (tasks.some((task) => task.status === 'changes_requested')) {
    return { label: 'Fixing', tone: 'busy' }
  }
  if (tasks.some((task) => task.status === 'waiting')) {
    return { label: 'Waiting', tone: 'idle' }
  }
  if (tasks.some((task) => task.status === 'blocked')) {
    return { label: 'Blocked', tone: 'error' }
  }
  const messages = detail.messages.filter((message) => message.senderAgentId === agent.id)
  const last = messages[messages.length - 1]
  if (last?.metadata?.status === 'streaming') {
    return { label: 'Writing', tone: 'busy' }
  }
  const runningTool = last?.metadata?.toolCalls?.find((tool) => tool.status === 'running')
  if (runningTool) {
    const name = runningTool.toolName.toLowerCase()
    if (name.includes('read') || name.includes('search') || name.includes('list')) {
      return { label: 'Reading', tone: 'busy' }
    }
    if (name.includes('write') || name.includes('patch') || name.includes('create')) {
      return { label: 'Writing', tone: 'busy' }
    }
    if (name.includes('delete') || name.includes('move') || name.includes('revert')) {
      return { label: 'Modifying', tone: 'busy' }
    }
    if (name.includes('command') || name.includes('process')) {
      return { label: 'Testing', tone: 'busy' }
    }
    return { label: 'Working', tone: 'busy' }
  }
  if (last && Date.now() - last.createdAt < 120_000) {
    return { label: isRunning(detail.meeting) ? 'Waiting' : 'Waiting', tone: 'idle' }
  }
  return { label: 'Ready', tone: 'ready' }
}

function statusLabel(status: MeetingSummary['status']): string {
  switch (status) {
    case 'draft':
      return 'Ready'
    case 'intake':
      return 'Intake'
    case 'discussion':
      return 'Discussing'
    case 'planning':
      return 'Planning'
    case 'building':
      return 'Building'
    case 'reviewing':
      return 'Reviewing'
    case 'reporting':
      return 'Reporting'
    case 'completed':
      return 'Completed'
    case 'stopped':
      return 'Stopped'
    case 'failed':
      return 'Failed'
    default:
      return status
  }
}

function taskStatusLabel(status: MeetingTask['status']): string {
  switch (status) {
    case 'proposed':
      return 'Proposed'
    case 'queued':
      return 'Queued'
    case 'in_progress':
      return 'Working'
    case 'review':
      return 'Review'
    case 'changes_requested':
      return 'Changes'
    case 'done':
      return 'Done'
    case 'waiting':
      return 'Waiting'
    case 'blocked':
      return 'Blocked'
    default:
      return status
  }
}

export function ProjectDesk({
  project,
  appInfo,
  settings,
  busy,
  onCloseProject,
  onOpenSettings,
  onRevealProject,
  onError
}: ProjectDeskProps) {
  const [mode, setMode] = useState<MeetingMode>('plan')
  const [detail, setDetail] = useState<MeetingDetail | null>(null)
  const [meetings, setMeetings] = useState<MeetingSummary[]>([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [sending, setSending] = useState(false)
  const [approving, setApproving] = useState(false)
  const [inlineError, setInlineError] = useState('')
  const [treeRevision, setTreeRevision] = useState(0)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [sessionBusy, setSessionBusy] = useState<string | null>(null)
  const [answeringQuestion, setAnsweringQuestion] = useState(false)
  const [rightTab, setRightTab] = useState<'activity' | 'team' | 'tasks' | 'flows'>(
    'activity'
  )
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const coordinator =
    project.agents.find((agent) => agent.roleKey === 'coordinator') ?? project.agents[0]
  const enabledAgents = project.agents.filter((agent) => agent.enabled)
  const coordinatorId = coordinator?.id ?? ''
  const runningMeeting = isRunning(detail?.meeting)
  const isBusy = running || runningMeeting

  useEffect(() => {
    let cancelled = false
    setLoading(true)
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
        setMeetings(result.data)
        const latest = result.data[0]
        if (!latest) {
          return
        }
        const loaded = await window.agentdesk.getMeeting(latest.id)
        if (cancelled) {
          return
        }
        if (loaded.ok) {
          setDetail(loaded.data)
          setMode(loaded.data.meeting.mode)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setInlineError(
            error instanceof Error ? error.message : 'Could not load the project desk.'
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
        setDetail((current) =>
          !current || current.meeting.id === event.meetingId ? event.meeting : current
        )
        setMeetings((current) => mergeMeeting(current, event.meeting.meeting))
        setRunning(false)
        setSending(false)
        setTreeRevision((value) => value + 1)
        return
      }
      if (event.type === 'error') {
        setRunning(false)
        setSending(false)
        setInlineError(event.message)
        onError(event.message)
        if (event.meeting) {
          setDetail((current) =>
            !current || current.meeting.id === event.meetingId ? event.meeting : current
          )
          setMeetings((current) => mergeMeeting(current, event.meeting!.meeting))
        }
        return
      }
      if (event.type === 'meeting-start' || event.type === 'meeting-update') {
        setRunning(
          ['intake', 'discussion', 'planning', 'building', 'reviewing', 'reporting'].includes(
            event.meeting.status
          )
        )
        setMeetings((current) => mergeMeeting(current, event.meeting))
        setDetail((current) =>
          !current || current.meeting.id !== event.meeting.id
            ? current
            : { ...current, meeting: event.meeting }
        )
        return
      }
      if (event.type === 'turn-start') {
        setDetail((current) =>
          !current || current.meeting.id !== event.meetingId
            ? current
            : mergeMessage({ ...current, meeting: event.meeting }, event.message)
        )
        return
      }
      if (event.type === 'delta') {
        setDetail((current) =>
          !current || current.meeting.id !== event.meetingId
            ? current
            : appendDelta(current, event.turnId, event.text)
        )
        return
      }
      if (event.type === 'message') {
        setDetail((current) =>
          !current || current.meeting.id !== event.meetingId
            ? current
            : mergeMessage({ ...current, meeting: event.meeting }, event.message)
        )
        setMeetings((current) => mergeMeeting(current, event.meeting))
        if (event.message.kind === 'build' || event.message.kind === 'review') {
          setTreeRevision((value) => value + 1)
        }
        return
      }
      if (event.type === 'plan') {
        setDetail((current) =>
          !current || current.meeting.id !== event.meetingId
            ? current
            : { ...current, plan: event.plan, meeting: event.meeting }
        )
        return
      }
      if (event.type === 'task') {
        setDetail((current) =>
          !current || current.meeting.id !== event.meetingId
            ? current
            : mergeTask({ ...current, meeting: event.meeting }, event.task)
        )
        return
      }
      if (event.type === 'question' || event.type === 'question-answered') {
        setDetail((current) => {
          if (!current || current.meeting.id !== event.meetingId) {
            return current
          }
          const exists = current.questions.some(
            (question) => question.id === event.question.id
          )
          return {
            ...current,
            meeting: event.meeting,
            questions: exists
              ? current.questions.map((question) =>
                  question.id === event.question.id ? event.question : question
                )
              : [...current.questions, event.question]
          }
        })
        return
      }
      if (event.type === 'todo') {
        setDetail((current) => {
          if (!current || current.meeting.id !== event.meetingId) {
            return current
          }
          return {
            ...current,
            meeting: event.meeting,
            todos: [
              ...current.todos.filter((todo) => todo.agentId !== event.agentId),
              ...event.todos
            ]
          }
        })
        return
      }
      if (event.type === 'report') {
        setDetail((current) =>
          !current || current.meeting.id !== event.meetingId
            ? current
            : { ...current, finalReport: event.report, meeting: event.meeting }
        )
      }
    })
    return unsubscribe
  }, [onError])

  useEffect(() => {
    const node = scrollRef.current
    if (node) {
      node.scrollTop = node.scrollHeight
    }
  }, [detail?.messages.length, detail?.meeting.status])

  const centerMessages = (detail?.messages ?? []).filter(
    (message) =>
      message.senderType === 'boss' ||
      (message.senderType === 'agent' &&
        message.senderAgentId === coordinatorId &&
        message.metadata?.phase !== 'intake' &&
        message.metadata?.phase !== 'discussion' &&
        !['message', 'request', 'notify'].includes(message.kind))
  )
  const teamMessages = (detail?.messages ?? []).filter(
    (message) =>
      message.senderType === 'agent' &&
      message.senderAgentId &&
      (message.senderAgentId !== coordinatorId ||
        message.metadata?.phase === 'intake' ||
        message.metadata?.phase === 'discussion' ||
        ['message', 'request', 'notify'].includes(message.kind))
  )
  const activeTasks = detail?.tasks.filter((task) => task.status !== 'done') ?? []
  const totalTasks = detail?.tasks.length ?? 0
  const doneTasks = detail?.tasks.filter((task) => task.status === 'done').length ?? 0
  const latestApprovedPlan = meetings.find(
    (meeting) =>
      meeting.mode === 'plan' &&
      meeting.status === 'completed' &&
      Boolean(meeting.planApprovedAt)
  )

  async function loadMeeting(meetingId: string): Promise<void> {
    const loaded = await window.agentdesk.getMeeting(meetingId)
    if (!loaded.ok) {
      setInlineError(loaded.error.message)
      return
    }
    setDetail(loaded.data)
    setMode(loaded.data.meeting.mode)
    setInlineError('')
    setRunning(isRunning(loaded.data.meeting))
    setTreeRevision((value) => value + 1)
  }

  async function renameSession(meetingId: string): Promise<void> {
    const title = renameDraft.trim()
    if (!title) {
      setRenamingId(null)
      return
    }
    setSessionBusy(meetingId)
    try {
      const result = await window.agentdesk.renameMeeting(meetingId, title)
      if (!result.ok) {
        setInlineError(result.error.message)
        return
      }
      setMeetings((current) =>
        current.map((entry) => (entry.id === meetingId ? result.data : entry))
      )
      setRenamingId(null)
    } finally {
      setSessionBusy(null)
    }
  }

  async function deleteSession(meetingId: string): Promise<void> {
    if (!window.confirm('Delete this session and its messages, tasks, and todos?')) {
      return
    }
    setSessionBusy(meetingId)
    try {
      const result = await window.agentdesk.deleteMeeting(meetingId)
      if (!result.ok) {
        setInlineError(result.error.message)
        return
      }
      setMeetings((current) => current.filter((entry) => entry.id !== meetingId))
      if (detail?.meeting.id === meetingId) {
        setDetail(null)
        setMode('plan')
      }
    } finally {
      setSessionBusy(null)
    }
  }

  async function startPlan(goal: string): Promise<void> {
    const created = await window.agentdesk.createMeeting({
      goal,
      agentIds: enabledAgents.map((agent) => agent.id),
      mode: 'plan'
    })
    if (!created.ok) {
      setInlineError(created.error.message)
      return
    }
    setMeetings((current) => mergeMeeting(current, created.data.meeting))
    setDetail(created.data)
    setMode('plan')
    const started = await window.agentdesk.startMeeting(created.data.meeting.id)
    if (!started.ok) {
      setInlineError(started.error.message)
      return
    }
    setRunning(true)
    setTreeRevision((value) => value + 1)
  }

  async function startBuild(planMeetingId: string): Promise<void> {
    const created = await window.agentdesk.createBuildMeeting({ planMeetingId })
    if (!created.ok) {
      setInlineError(created.error.message)
      return
    }
    setMeetings((current) => mergeMeeting(current, created.data.meeting))
    setDetail(created.data)
    setMode('build')
    const started = await window.agentdesk.startMeeting(created.data.meeting.id)
    if (!started.ok) {
      setInlineError(started.error.message)
      return
    }
    setRunning(true)
  }

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text || sending) {
      return
    }
    setInlineError('')
    setSending(true)
    try {
      if (!detail) {
        if (mode === 'plan') {
          await startPlan(text)
        } else if (latestApprovedPlan) {
          await startBuild(latestApprovedPlan.id)
        } else {
          setInlineError('Approve a plan in Plan mode before starting Build.')
        }
        setDraft('')
        return
      }
      if (detail.meeting.mode === 'build' && mode === 'plan' && !runningMeeting) {
        await startPlan(text)
        setDraft('')
        return
      }
      if (runningMeeting) {
        if (detail.meeting.mode === 'build') {
          const result = await window.agentdesk.queueMeetingInterrupt({
            meetingId: detail.meeting.id,
            text,
            mode: 'queue'
          })
          if (!result.ok) {
            setInlineError(result.error.message)
            return
          }
          setDraft('')
          return
        }
        setInlineError('The team is working. Wait for this turn or stop the meeting.')
        return
      }
      if (mode === 'build') {
        if (detail.meeting.mode === 'build') {
          const result = await window.agentdesk.sendMeetingDirectMessage({
            meetingId: detail.meeting.id,
            agentId: coordinatorId,
            text
          })
          if (!result.ok) {
            setInlineError(result.error.message)
            return
          }
          setDraft('')
          await loadMeeting(detail.meeting.id)
          return
        }
        if (detail.meeting.planApprovedAt) {
          await startBuild(detail.meeting.id)
          setDraft('')
          return
        }
        setInlineError('Approve this plan before switching to Build.')
        return
      }
      const result = await window.agentdesk.sendMeetingDirectMessage({
        meetingId: detail.meeting.id,
        agentId: coordinatorId,
        text
      })
      if (!result.ok) {
        setInlineError(result.error.message)
        return
      }
      setDraft('')
      await loadMeeting(detail.meeting.id)
    } catch (error) {
      setInlineError(
        error instanceof Error ? error.message : 'The message could not be sent.'
      )
    } finally {
      setSending(false)
    }
  }

  async function approvePlan(): Promise<void> {
    if (!detail || approving) {
      return
    }
    setApproving(true)
    setInlineError('')
    try {
      const result = await window.agentdesk.approveMeetingPlan(detail.meeting.id)
      if (!result.ok) {
        setInlineError(result.error.message)
        return
      }
      setDetail(result.data)
      setMeetings((current) => mergeMeeting(current, result.data.meeting))
      setMode('build')
    } catch (error) {
      setInlineError(
        error instanceof Error ? error.message : 'The plan could not be approved.'
      )
    } finally {
      setApproving(false)
    }
  }

  async function stop(): Promise<void> {
    if (!detail) {
      return
    }
    const result = await window.agentdesk.stopMeeting(detail.meeting.id)
    if (!result.ok) {
      setInlineError(result.error.message)
      return
    }
    setRunning(false)
    await loadMeeting(detail.meeting.id)
  }

  const pendingQuestion =
    detail?.questions.find((question) => question.status === 'pending') ?? null

  async function answerQuestion(answer: string): Promise<void> {
    if (!detail || !pendingQuestion || answeringQuestion) {
      return
    }
    setAnsweringQuestion(true)
    try {
      const result = await window.agentdesk.answerMeetingQuestion({
        meetingId: detail.meeting.id,
        questionId: pendingQuestion.id,
        answer
      })
      if (!result.ok) {
        setInlineError(result.error.message)
        return
      }
      setDetail((current) =>
        current
          ? {
              ...current,
              questions: current.questions.map((question) =>
                question.id === result.data.id ? result.data : question
              )
            }
          : current
      )
    } finally {
      setAnsweringQuestion(false)
    }
  }

  const canSend =
    Boolean(draft.trim()) &&
    !sending &&
    !loading &&
    !(isBusy && detail?.meeting.mode !== 'build')

  return (
    <div className="project-desk">
      <aside className="desk-sidebar">
        <div className="desk-brand-row">
          <Brand compact version={appInfo.version} />
          <button
            className="icon-button"
            type="button"
            onClick={onOpenSettings}
            aria-label="Open settings"
            title="Settings"
          >
            <Icon name="settings" size={17} />
          </button>
        </div>

        <div className="project-card">
          <span className="project-card-icon">
            <Icon name="folder" size={18} />
          </span>
          <div className="project-card-copy">
            <strong>{project.name}</strong>
            <span title={project.path}>{shortPath(project.path, 34)}</span>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onRevealProject}
            disabled={Boolean(busy)}
            aria-label="Reveal project folder"
            title="Reveal project folder"
          >
            <Icon name="external" size={14} />
          </button>
        </div>

        <div className="boss-line">
          <span className="status-dot" />
          Working for <strong>{settings.bossName}</strong>
        </div>

        <div className="desk-sidebar-scroll">
          <section className="side-section">
            <div className="side-label">
              <span>Sessions</span>
              <span className="side-label-meta">{meetings.length}</span>
            </div>
            <div className="desk-session-list">
              {meetings.length === 0 && (
                <p className="sidebar-hint">Start a Plan or Build to create a session.</p>
              )}
              {meetings.slice(0, 30).map((entry) => {
                const active = detail?.meeting.id === entry.id
                return (
                  <div
                    className={active ? 'desk-session-row active' : 'desk-session-row'}
                    key={entry.id}
                  >
                    {renamingId === entry.id ? (
                      <input
                        className="desk-session-rename"
                        value={renameDraft}
                        autoFocus
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onBlur={() => void renameSession(entry.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            void renameSession(entry.id)
                          }
                          if (event.key === 'Escape') {
                            setRenamingId(null)
                          }
                        }}
                      />
                    ) : (
                      <button
                        className="desk-session-main"
                        type="button"
                        onClick={() => void loadMeeting(entry.id)}
                        disabled={sessionBusy === entry.id}
                      >
                        <strong>{entry.title}</strong>
                        <span>
                          {entry.mode === 'build' ? 'Build' : 'Plan'} -{' '}
                          {statusLabel(entry.status)}
                        </span>
                      </button>
                    )}
                    <div className="desk-session-actions">
                      <button
                        className="icon-button tiny"
                        type="button"
                        title="Rename session"
                        onClick={() => {
                          setRenamingId(entry.id)
                          setRenameDraft(entry.title)
                        }}
                      >
                        <Icon name="edit" size={12} />
                      </button>
                      <button
                        className="icon-button tiny danger"
                        type="button"
                        title="Delete session"
                        onClick={() => void deleteSession(entry.id)}
                        disabled={sessionBusy === entry.id}
                      >
                        <Icon name="trash" size={12} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="side-section">
            <div className="side-label">
              <span>Explorer</span>
              <span className="side-label-meta">{project.detection.fileCount} files</span>
            </div>
            <FileTree key={treeRevision} projectPath={project.path} onError={onError} />
          </section>

          <section className="side-section team-side-section">
            <div className="side-label">
              <span>Team</span>
              <span className="side-label-meta">{project.agents.length} agents</span>
            </div>
            <div className="team-list">
              {project.agents.map((agent) => {
                const status = agentStatus(agent, detail)
                return (
                  <div className="team-row" key={agent.id} title={agent.tagline}>
                    <span className="agent-dot" style={{ backgroundColor: agent.color }} />
                    <div className="team-row-copy">
                      <strong>{agent.name}</strong>
                      <span>{agent.roleKey}</span>
                    </div>
                    <span className={`agent-state desk-status ${status.tone}`}>
                      {status.label}
                    </span>
                  </div>
                )
              })}
            </div>
            <p className="sidebar-hint">
              Agents work in {shortPath(project.path, 30)}. The .agentdesk folder only
              stores team memory, tasks, and snapshots.
            </p>
          </section>
        </div>

        <div className="sidebar-footer">
          <button
            className="btn btn-quiet btn-small"
            type="button"
            onClick={onCloseProject}
            disabled={Boolean(busy)}
          >
            <Icon name="close" size={15} />
            Close project
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={onOpenSettings}
            aria-label="Settings"
          >
            <Icon name="settings" size={16} />
          </button>
        </div>
      </aside>

      <main className="desk-main">
        <header className="desk-topbar">
          <div className="breadcrumb">
            <span>Project desk</span>
            <Icon name="chevron" size={13} />
            <strong>{project.name}</strong>
          </div>
          <div className="topbar-chips">
            {detail && (
              <span className={runningMeeting ? 'soft-chip warning' : 'soft-chip'}>
                {statusLabel(detail.meeting.status)}
              </span>
            )}
            {runningMeeting && detail?.meeting.mode === 'build' && (
              <button className="btn btn-quiet btn-small" type="button" onClick={() => void stop()}>
                <Icon name="stop" size={12} />
                Stop
              </button>
            )}
            <button
              className="btn btn-quiet btn-small"
              type="button"
              onClick={() => {
                setDetail(null)
                setMode('plan')
                setDraft('')
                setInlineError('')
              }}
            >
              <Icon name="plus" size={12} />
              New
            </button>
          </div>
        </header>

        <div className="desk-panes">
          <section className="desk-center">
            <header className="desk-pane-header">
              <div>
                <span className="eyebrow">Coordinator & Architect</span>
                <strong>Main chat</strong>
              </div>
              <span className="soft-chip">
                {mode === 'build' ? 'Build mode' : 'Plan mode'}
              </span>
            </header>

            <div className="desk-chat-scroll main-scroll" ref={scrollRef}>
              {loading ? (
                <div className="desk-empty">Loading the project desk...</div>
              ) : centerMessages.length === 0 ? (
                <div className="desk-empty">
                  <h2>Talk to the Coordinator.</h2>
                  <p>
                    Tell the team what you want. The Coordinator will plan or build it with
                    the team, and every agent can see this conversation.
                  </p>
                  <div className="desk-suggestions">
                    <button type="button" onClick={() => setDraft('Plan a small first feature for this project.')}>
                      Plan a feature
                    </button>
                    <button type="button" onClick={() => setDraft('Build the approved plan and show me the files.')}>
                      Build the plan
                    </button>
                    <button type="button" onClick={() => setDraft('Review the project and suggest the next steps.')}>
                      Review project
                    </button>
                  </div>
                </div>
              ) : (
                centerMessages.map((message) => (
                  <article
                    key={message.id}
                    className={
                      message.senderType === 'boss'
                        ? 'desk-message boss'
                        : 'desk-message coordinator'
                    }
                  >
                    <div className="desk-message-head">
                      <span className="desk-avatar">
                        {message.senderType === 'boss'
                          ? initials(settings.bossName)
                          : initials(coordinator?.name ?? 'Coordinator')}
                      </span>
                      <strong>{message.senderName}</strong>
                      <span className="desk-message-meta">
                        {message.metadata?.phase ?? message.kind}
                      </span>
                    </div>
                    <div className="desk-message-body">
                      <MessageText content={cleanChatText(message.content)} />
                    </div>
                  </article>
                ))
              )}

              {detail?.plan && (
                <div className="desk-plan-card">
                  <div>
                    <span className="eyebrow">Plan</span>
                    <strong>{detail.plan.summary}</strong>
                    <p>{detail.plan.tasks.length} tasks proposed by the Coordinator.</p>
                  </div>
                  {!detail.meeting.planApprovedAt ? (
                    <button
                      className="btn btn-primary btn-small"
                      type="button"
                      onClick={() => void approvePlan()}
                      disabled={approving}
                    >
                      <Icon name="check" size={13} />
                      {approving ? 'Approving...' : 'Approve plan'}
                    </button>
                  ) : (
                    <span className="soft-chip success">Plan approved</span>
                  )}
                </div>
              )}

              {detail?.finalReport && (
                <div className="desk-plan-card">
                  <div>
                    <span className="eyebrow">Build report</span>
                    <strong>{detail.finalReport.summary.slice(0, 260)}</strong>
                    <p>
                      {detail.finalReport.filesChanged.length} files,{' '}
                      {detail.finalReport.commands.length} commands.
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="desk-composer">
              {inlineError && <div className="desk-inline-error">{inlineError}</div>}
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void send()
                  }
                }}
                placeholder={
                  runningMeeting
                    ? 'The team is working. Queue a build update...'
                    : mode === 'build'
                      ? 'Tell the team what to build or change...'
                      : 'Tell the Coordinator what you want to plan...'
                }
                rows={2}
              />
              <div className="desk-composer-bottom">
                <div className="desk-mode-buttons">
                  <button
                    className={mode === 'plan' ? 'composer-mode active' : 'composer-mode'}
                    type="button"
                    onClick={() => setMode('plan')}
                    disabled={sending}
                  >
                    <Icon name="lock" size={11} />
                    Plan
                  </button>
                  <button
                    className={mode === 'build' ? 'composer-mode build active' : 'composer-mode build'}
                    type="button"
                    onClick={() => setMode('build')}
                    disabled={sending}
                  >
                    <Icon name="shield" size={11} />
                    Build
                  </button>
                </div>
                <div className="desk-composer-actions">
                  {runningMeeting && detail?.meeting.mode === 'build' && (
                    <button className="btn btn-quiet btn-small" type="button" onClick={() => void stop()}>
                      Stop
                    </button>
                  )}
                  <button
                    className="btn btn-primary btn-small"
                    type="button"
                    onClick={() => void send()}
                    disabled={!canSend}
                  >
                    <Icon name="send" size={13} />
                    Send
                  </button>
                </div>
              </div>
            </div>
          </section>

          <aside className="desk-right">
            <header className="desk-pane-header">
              <div>
                <span className="eyebrow">Team</span>
                <strong>Agent discussion</strong>
              </div>
              <span className="soft-chip">
                {totalTasks > 0 ? `${doneTasks}/${totalTasks} done` : 'Ready'}
              </span>
            </header>
            <div className="desk-right-tabs">
              <button
                className={rightTab === 'activity' ? 'active' : ''}
                type="button"
                onClick={() => setRightTab('activity')}
              >
                Activity
              </button>
              <button
                className={rightTab === 'team' ? 'active' : ''}
                type="button"
                onClick={() => setRightTab('team')}
              >
                Team
              </button>
              <button
                className={rightTab === 'tasks' ? 'active' : ''}
                type="button"
                onClick={() => setRightTab('tasks')}
              >
                Tasks
              </button>
              <button
                className={rightTab === 'flows' ? 'active' : ''}
                type="button"
                onClick={() => setRightTab('flows')}
              >
                Flows
              </button>
            </div>
            <div className="desk-activity-scroll">
              {detail?.meeting && (
                <div className="desk-activity-group">
                  <span className="desk-activity-label">{statusLabel(detail.meeting.status)}</span>
                  <p className="desk-goal">{detail.meeting.goal.slice(0, 220)}</p>
                </div>
              )}
              {rightTab === 'activity' && detail && (
                <div className="desk-task-section">
                  <span className="desk-activity-label">Live agent activity</span>
                  {project.agents
                    .filter((agent) => agent.enabled)
                    .map((agent) => {
                      const status = agentStatus(agent, detail)
                      const tasks = detail.tasks.filter(
                        (task) => task.assigneeAgentId === agent.id
                      )
                      const current =
                        tasks.find((task) =>
                          ['in_progress', 'review', 'changes_requested', 'waiting'].includes(
                            task.status
                          )
                        ) ??
                        tasks.find((task) => task.status === 'blocked') ??
                        null
                      const messages = detail.messages.filter(
                        (message) => message.senderAgentId === agent.id
                      )
                      const latest = messages[messages.length - 1]
                      const traces = latest?.metadata?.toolCalls ?? []
                      const trace = traces[traces.length - 1]
                      const latestEvent = current
                        ? [...detail.activity]
                            .reverse()
                            .find((event) => event.taskId === current.id)
                        : null
                      return (
                        <div className="desk-agent-activity" key={agent.id}>
                          <div className="desk-agent-activity-head">
                            <strong>{agent.name}</strong>
                            <span className={`desk-status ${status.tone}`}>{status.label}</span>
                          </div>
                          {current && (
                            <span className="desk-agent-activity-task">
                              {taskStatusLabel(current.status)}: {current.title}
                              {current.waitingOnTaskIds.length > 0
                                ? ` - waiting on ${current.waitingOnTaskIds.length} task`
                                : ''}
                            </span>
                          )}
                          {trace && (
                            <span className="desk-agent-activity-tool">
                              {trace.status === 'running' ? 'Running' : 'Last tool'}:{' '}
                              {trace.toolName}
                            </span>
                          )}
                          {current &&
                            (current.status === 'blocked' || current.status === 'waiting') &&
                            latestEvent?.note && (
                              <span className="desk-agent-activity-blocker">
                                {latestEvent.note}
                              </span>
                            )}
                        </div>
                      )
                    })}
                </div>
              )}

              {rightTab === 'team' && (teamMessages.length === 0 ? (
                <div className="desk-empty small">
                  Agent-to-agent updates appear here once the team starts working.
                </div>
              ) : (
                teamMessages.map((message) => {
                  const agent = project.agents.find(
                    (entry) => entry.id === message.senderAgentId
                  )
                  return (
                    <article
                      className={
                        message.kind === 'request'
                          ? 'desk-team-message request'
                          : message.kind === 'notify'
                            ? 'desk-team-message notify'
                            : 'desk-team-message'
                      }
                      key={message.id}
                    >
                      <div className="desk-message-head">
                        <span
                          className="desk-avatar"
                          style={{ backgroundColor: agent?.color ?? '#4c94f5' }}
                        >
                          {initials(agent?.name ?? message.senderName)}
                        </span>
                        <strong>{message.senderName}</strong>
                        <span className="desk-message-meta">
                          {message.metadata?.phase ?? message.kind}
                        </span>
                      </div>
                      <div className="desk-message-body small">
                        <MessageText content={cleanChatText(message.content)} />
                      </div>
                    </article>
                  )
                })
              ))}

              {rightTab === 'flows' && (detail?.todos ?? []).length > 0 && (
                <div className="desk-task-section">
                  <span className="desk-activity-label">Agent flows</span>
                  {project.agents.map((agent) => {
                    const todos = (detail?.todos ?? []).filter(
                      (todo) => todo.agentId === agent.id
                    )
                    if (todos.length === 0) {
                      return null
                    }
                    return (
                      <div className="desk-todo-group" key={agent.id}>
                        <strong>{agent.name}</strong>
                        {todos.map((todo) => (
                          <div className={`desk-todo-row ${todo.status}`} key={todo.id}>
                            <span className="desk-todo-dot" />
                            <span>{todo.content}</span>
                          </div>
                        ))}
                      </div>
                    )
                  })}
                </div>
              )}

              {rightTab === 'tasks' && activeTasks.length > 0 && (
                <div className="desk-task-section">
                  <span className="desk-activity-label">Tasks & claims</span>
                  {activeTasks.map((task) => {
                    const agent = project.agents.find(
                      (entry) => entry.id === task.assigneeAgentId
                    )
                    return (
                      <div className="desk-task-row" key={task.id}>
                        <div>
                          <strong>{task.title}</strong>
                          <span>
                            {agent?.name ?? 'Unassigned'} - {taskStatusLabel(task.status)}
                            {task.requestedByAgentId
                              ? ` - requested by ${task.requestedByAgentId}`
                              : ''}
                          </span>
                          {task.waitingOnTaskIds.length > 0 && (
                            <span className="desk-task-blocker">
                              Waiting for {task.waitingOnTaskIds.length} task
                              {task.waitingOnTaskIds.length === 1 ? '' : 's'} to finish
                            </span>
                          )}
                          {task.fileGlobs.length > 0 && (
                            <code>{task.fileGlobs.join(', ')}</code>
                          )}
                        </div>
                        <span className={`desk-task-status ${task.status}`}>
                          {taskStatusLabel(task.status)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}

              {rightTab === 'tasks' &&
                (detail?.fileClaims ?? []).filter((claim) => claim.status === 'active').length >
                  0 && (
                <div className="desk-task-section">
                  <span className="desk-activity-label">Active file claims</span>
                  {(detail?.fileClaims ?? [])
                    .filter((claim) => claim.status === 'active')
                    .map((claim) => (
                      <div className="desk-claim-row" key={claim.id}>
                        <code>{claim.pathPrefix}</code>
                        <span>{claim.agentId}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </aside>
        </div>
      </main>

      {pendingQuestion && (
        <div className="modal-backdrop question-backdrop" role="presentation">
          <div className="modal question-modal" role="dialog" aria-modal="true">
            <header className="question-header">
              <span className="question-icon">
                <Icon name="chat" size={18} />
              </span>
              <div>
                <span className="eyebrow">Coordinator needs your decision</span>
                <h2>{pendingQuestion.question}</h2>
                <p>{pendingQuestion.agentName} is asking on behalf of the team.</p>
              </div>
            </header>
            <div className="question-options">
              {pendingQuestion.options.map((option, index) => (
                <button
                  key={option}
                  className="question-option"
                  type="button"
                  disabled={answeringQuestion}
                  onClick={() => void answerQuestion(option)}
                >
                  <span>{option}</span>
                  <kbd>{index + 1}</kbd>
                </button>
              ))}
            </div>
            <p className="question-hint">
              The team is waiting. Nothing is blocked permanently; your answer directs the next step.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
