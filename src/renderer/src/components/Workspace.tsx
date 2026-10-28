import { useEffect, useState } from 'react'
import type { AgentSummary, AppInfo, AppSettings, ProjectInfo } from '@shared/types'
import { AgentChat } from './AgentChat'
import { Brand } from './Brand'
import { BuildRoom } from './BuildRoom'
import { FileTree } from './FileTree'
import { Icon } from './Icon'
import { MeetingRoom } from './MeetingRoom'
import { ProjectOverview } from './ProjectOverview'
import { agentModelLabel, shortPath } from '../lib/format'

type WorkspaceProps = {
  project: ProjectInfo
  appInfo: AppInfo
  settings: AppSettings
  busy: string | null
  onCloseProject: () => void
  onOpenSettings: () => void
  onRevealProject: () => void
  onError: (message: string) => void
}

type WorkspaceView = 'chat' | 'meeting' | 'build' | 'project'

function defaultAgent(project: ProjectInfo): AgentSummary {
  return (
    project.agents.find((agent) => agent.enabled && agent.modelLabel) ??
    project.agents.find((agent) => agent.enabled) ??
    project.agents[0]
  )
}

export function Workspace({
  project,
  appInfo,
  settings,
  busy,
  onCloseProject,
  onOpenSettings,
  onRevealProject,
  onError
}: WorkspaceProps) {
  const disabled = Boolean(busy)
  const [view, setView] = useState<WorkspaceView>('chat')
  const [treeRevision, setTreeRevision] = useState(0)
  const [buildMeetingId, setBuildMeetingId] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState(() => defaultAgent(project).id)
  const selectedAgent =
    project.agents.find((agent) => agent.id === selectedAgentId) ?? defaultAgent(project)
  const enabledAgents = project.agents.filter((agent) => agent.enabled)
  const chatAgents = enabledAgents.length > 0 ? enabledAgents : project.agents

  useEffect(() => {
    if (!project.agents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId(defaultAgent(project).id)
    }
  }, [project.agents, selectedAgentId])

  function selectAgent(agentId: string): void {
    setSelectedAgentId(agentId)
    setView('chat')
  }

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="sidebar-brand-row">
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
            disabled={disabled}
            aria-label="Reveal project folder"
            title="Reveal project folder"
          >
            <Icon name="external" size={15} />
          </button>
        </div>

        <div className="boss-line">
          <span className="status-dot" />
          Working for <strong>{settings.bossName}</strong>
        </div>

        <div className="sidebar-scroll">
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
              <span className="side-label-meta">
                {project.agents.filter((agent) => agent.modelLabel).length} ready
              </span>
            </div>
            <div className="team-list">
              {project.agents.map((agent) => (
                <button
                  className={
                    agent.id === selectedAgent.id
                      ? 'team-row team-row-button selected'
                      : 'team-row team-row-button'
                  }
                  key={agent.id}
                  type="button"
                  title={agent.tagline}
                  onClick={() => selectAgent(agent.id)}
                >
                  <span className="agent-dot" style={{ backgroundColor: agent.color }} />
                  <div className="team-row-copy">
                    <strong>{agent.name}</strong>
                    <span>{agentModelLabel(settings, agent) ?? 'No model assigned'}</span>
                  </div>
                  <span
                    className={
                      agent.enabled && agent.modelLabel
                        ? 'agent-state on'
                        : agent.enabled
                          ? 'agent-state'
                          : 'agent-state off'
                    }
                  >
                    {agent.enabled ? (agent.modelLabel ? 'Ready' : 'Set up') : 'Off'}
                  </span>
                </button>
              ))}
            </div>
            <p className="sidebar-hint">
              Open Chat to talk to the whole team, or use Plan room for a structured meeting.
            </p>
          </section>
        </div>

        <div className="sidebar-footer">
          <button
            className="btn btn-quiet btn-small"
            type="button"
            onClick={onCloseProject}
            disabled={disabled}
          >
            <Icon name="close" size={15} />
            Close project
          </button>
          <button className="icon-button" type="button" onClick={onOpenSettings} aria-label="Settings">
            <Icon name="settings" size={16} />
          </button>
        </div>
      </aside>

      <main className="main-pane">
        <header className="main-topbar">
          <div className="topbar-left">
            <div className="breadcrumb">
              <span>Workspace</span>
              <Icon name="chevron" size={13} />
              <strong>{project.name}</strong>
            </div>
            <nav className="view-tabs" aria-label="Workspace view">
              <button
                className={view === 'chat' ? 'view-tab active' : 'view-tab'}
                type="button"
                onClick={() => setView('chat')}
              >
                <Icon name="chat" size={14} />
                Chat
              </button>
              <button
                className={view === 'meeting' ? 'view-tab active' : 'view-tab'}
                type="button"
                onClick={() => setView('meeting')}
              >
                <Icon name="users" size={14} />
                Plan room
              </button>
              <button
                className={view === 'build' ? 'view-tab active' : 'view-tab'}
                type="button"
                onClick={() => setView('build')}
              >
                <Icon name="shield" size={14} />
                Build room
              </button>
              <button
                className={view === 'project' ? 'view-tab active' : 'view-tab'}
                type="button"
                onClick={() => setView('project')}
              >
                <Icon name="panel" size={14} />
                Project
              </button>
            </nav>
          </div>
          <div className="topbar-chips">
            {project.detection.gitBranch && (
              <span className="soft-chip">
                <Icon name="branch" size={14} />
                {project.detection.gitBranch}
              </span>
            )}
            <span className="soft-chip">
              <Icon name="shield" size={14} />
              Local tools
            </span>
            <button
              className="btn btn-quiet btn-small"
              type="button"
              onClick={onRevealProject}
              disabled={disabled}
            >
              <Icon name="external" size={14} />
              Reveal
            </button>
          </div>
        </header>

        {view === 'chat' ? (
          <AgentChat
            key={project.id}
            project={project}
            settings={settings}
            agent={selectedAgent}
            agents={chatAgents}
            onSelectAgent={selectAgent}
            onOpenSettings={onOpenSettings}
            onFilesChanged={() => setTreeRevision((value) => value + 1)}
            onError={onError}
          />
        ) : view === 'meeting' ? (
          <MeetingRoom
            key={project.id}
            project={project}
            settings={settings}
            agents={project.agents}
            onOpenSettings={onOpenSettings}
            onStartBuild={(meetingId) => {
              setBuildMeetingId(meetingId)
              setView('build')
            }}
            onError={onError}
            onFilesChanged={() => setTreeRevision((value) => value + 1)}
          />
        ) : view === 'build' ? (
          <BuildRoom
            key={project.id}
            project={project}
            agents={project.agents}
            initialMeetingId={buildMeetingId}
            onOpenSettings={onOpenSettings}
            onBackToPlan={() => setView('meeting')}
            onError={onError}
            onFilesChanged={() => setTreeRevision((value) => value + 1)}
          />
        ) : (
          <div className="main-scroll">
            <ProjectOverview
              project={project}
              settings={settings}
              busy={busy}
              onOpenSettings={onOpenSettings}
              onRevealProject={onRevealProject}
              onOpenChat={() => setView('chat')}
            />
          </div>
        )}
      </main>
    </div>
  )
}




