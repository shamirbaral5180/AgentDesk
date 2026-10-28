import type { AppSettings, ProjectInfo } from '@shared/types'
import { agentModelLabel, commandOrFallback, shortPath } from '../lib/format'
import { Icon } from './Icon'

type ProjectOverviewProps = {
  project: ProjectInfo
  settings: AppSettings
  busy: string | null
  onOpenSettings: () => void
  onRevealProject: () => void
  onOpenChat: () => void
}

const commandRows = [
  ['build', 'Build'],
  ['test', 'Test'],
  ['dev', 'Dev'],
  ['install', 'Install']
] as const

export function ProjectOverview({
  project,
  settings,
  busy,
  onOpenSettings,
  onRevealProject,
  onOpenChat
}: ProjectOverviewProps) {
  const disabled = Boolean(busy)
  const stackLabel = project.detection.stacks.length
    ? project.detection.stacks.slice(0, 2).join(' + ')
    : 'Unknown stack'
  const providerCount = settings.providers.length
  const modelCount = settings.models.length
  const assignedCount = project.agents.filter((agent) => Boolean(agent.modelLabel)).length
  const readyAgents = project.agents.filter(
    (agent) => agent.enabled && Boolean(agent.modelLabel)
  ).length

  return (
    <>
      <section className="workspace-hero">
        <div>
          <span className="eyebrow">Phase 5 - build loop with memory</span>
          <h1>
            {modelCount === 0
              ? 'Connect a model.'
              : readyAgents === 0
                ? 'Assign a model.'
                : 'The studio is awake.'}
          </h1>
          <p>
            {modelCount === 0
              ? 'Add a provider in Settings, discover its models, and assign one to the agent you want to talk to.'
              : readyAgents === 0
                ? 'The catalog is ready. Open Settings, Team and assign a model to at least one agent.'
                : `Chat with one agent in Plan or Build mode. ${assignedCount} of ${project.agents.length} agents have models. The agent can inspect, edit, and run commands with approval gates, snapshots, and a change log.`}
          </p>
          <div className="hero-path" title={project.path}>
            <Icon name="folder" size={15} />
            <code>{project.path}</code>
          </div>
        </div>
        <div className={modelCount === 0 ? 'workspace-hero-badge idle' : 'workspace-hero-badge'}>
          <span className="pulse-ring" />
          <div>
            <strong>
              {modelCount === 0
                ? 'Gateway offline'
                : readyAgents > 0
                  ? 'Chat ready'
                  : 'Gateway online'}
            </strong>
            <span>
              {providerCount === 0
                ? 'No providers connected'
                : `${providerCount} providers  -  ${modelCount} models  -  ${assignedCount} assigned`}
            </span>
          </div>
        </div>
      </section>

      <section className="stat-grid">
        <div className="stat-card">
          <span className="stat-icon">
            <Icon name="panel" size={17} />
          </span>
          <div>
            <span className="stat-label">Detected stack</span>
            <strong>{stackLabel}</strong>
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-icon">
            <Icon name="file" size={17} />
          </span>
          <div>
            <span className="stat-label">Source files</span>
            <strong>{project.detection.fileCount.toLocaleString()}</strong>
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-icon">
            <Icon name="users" size={17} />
          </span>
          <div>
            <span className="stat-label">Team assembled</span>
            <strong>{project.agents.length} specialists</strong>
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-icon">
            <Icon name="sparkles" size={17} />
          </span>
          <div>
            <span className="stat-label">Agent runtime</span>
            <strong>{readyAgents > 0 ? 'Build loop ready' : 'Needs a model'}</strong>
          </div>
        </div>
      </section>

      <section className="content-grid">
        <div className="card detection-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Environment</span>
              <h2>Detected project</h2>
            </div>
            <span className="soft-chip">
              <Icon name="sparkles" size={14} />
              Auto-detected
            </span>
          </div>

          <div className="stack-chips">
            {project.detection.stacks.length > 0 ? (
              project.detection.stacks.map((stack) => (
                <span className="stack-chip" key={stack}>
                  {stack}
                </span>
              ))
            ) : (
              <span className="stack-chip muted">No known stack</span>
            )}
          </div>

          <div className="command-list">
            {commandRows.map(([key, label]) => (
              <div className="command-row" key={key}>
                <span>{label}</span>
                <code>{commandOrFallback(project.detection.commands[key])}</code>
              </div>
            ))}
          </div>

          {project.detection.entryPoints.length > 0 && (
            <div className="entry-row">
              <span>Entry points</span>
              <div>
                {project.detection.entryPoints.map((entry) => (
                  <code key={entry}>{entry}</code>
                ))}
              </div>
            </div>
          )}

          {project.detection.notes.length > 0 && (
            <ul className="detection-notes">
              {project.detection.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="card memory-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Storage</span>
              <h2>Project memory</h2>
            </div>
            <span className="soft-chip success">
              <Icon name="check" size={14} />
              SQLite ready
            </span>
          </div>

          <p className="card-copy">
            Chats, tool traces, token usage, context snapshots, and memory live inside the repository.
            Move the folder and the workspace moves with it.
          </p>

          <div className="path-list">
            <div className="path-row">
              <span>Workspace</span>
              <code title={project.dataDir}>{shortPath(project.dataDir, 42)}</code>
            </div>
            <div className="path-row">
              <span>Database</span>
              <code title={project.dbPath}>{shortPath(project.dbPath, 42)}</code>
            </div>
            <div className="path-row">
              <span>Team</span>
              <code title={project.teamPath}>{shortPath(project.teamPath, 42)}</code>
            </div>
          </div>

          <div className="memory-foot">
            <span className="mini-status">
              <Icon name="database" size={14} />
              Schema v4 applied
            </span>
            <button
              className="btn btn-quiet btn-small"
              type="button"
              onClick={onRevealProject}
              disabled={disabled}
            >
              <Icon name="external" size={14} />
              Open workspace
            </button>
          </div>
        </div>
      </section>

      <section className="team-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">The roster</span>
            <h2>Team assembled</h2>
          </div>
          <span className="section-count">
            {assignedCount > 0
              ? `${assignedCount}/${project.agents.length} models assigned`
              : 'Roles and write scopes saved'}
          </span>
        </div>
        <div className="agent-grid">
          {project.agents.map((agent) => (
            <article className="agent-card" key={agent.id}>
              <div className="agent-card-top">
                <span className="agent-avatar" style={{ backgroundColor: agent.color }}>
                  {agent.name
                    .split(' ')
                    .filter((part) => part !== '&')
                    .slice(0, 2)
                    .map((part) => part[0])
                    .join('')}
                </span>
                <div>
                  <strong>{agent.name}</strong>
                  <span>{agent.roleKey}</span>
                </div>
                <span className={agent.modelLabel ? 'agent-state on' : 'agent-state'}>
                  {agent.modelLabel ? 'Ready' : 'No model'}
                </span>
              </div>
              <p>{agent.tagline}</p>
              <div className="agent-card-foot">
                <span className="model-chip">
                  <Icon name="sparkles" size={13} />
                  {agentModelLabel(settings, agent) ?? 'No model assigned'}
                </span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="next-step-banner">
        <div className="next-step-icon">
          <Icon name="chat" size={20} />
        </div>
        <div>
          <strong>
            {modelCount === 0
              ? 'Next step: connect a provider'
              : readyAgents > 0
                ? 'Build mode and cross-session memory are live'
                : 'Next step: assign models'}
          </strong>
          <p>
            {modelCount === 0
              ? 'Add OpenAI, Gemini, Ollama, or a custom endpoint in Settings, then discover its models.'
              : readyAgents > 0
                ? 'Open the chat, pick an agent, and build. Memory carries prior work across sessions, while approvals and snapshots keep changes safe.'
                : 'Open Settings and switch to Team to choose a model for at least one role.'}
          </p>
        </div>
        {readyAgents > 0 ? (
          <button className="btn btn-primary btn-small" type="button" onClick={onOpenChat}>
            <Icon name="chat" size={14} />
            Open chat
          </button>
        ) : (
          <button className="btn btn-ghost btn-small" type="button" onClick={onOpenSettings}>
            <Icon name="settings" size={14} />
            Open settings
          </button>
        )}
        <span className="phase-badge">Phase 9</span>
      </section>
    </>
  )
}





