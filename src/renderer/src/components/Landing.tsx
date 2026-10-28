import type { AppInfo, AppSettings } from '@shared/types'
import { Brand } from './Brand'
import { Icon } from './Icon'
import { formatRelativeTime, shortPath } from '../lib/format'

type LandingProps = {
  appInfo: AppInfo
  settings: AppSettings
  busy: string | null
  onOpenProject: () => void
  onOpenRecent: (path: string) => void
  onRemoveRecent: (path: string) => void
  onOpenSettings: () => void
  onRevealData: () => void
}

function foundationFor(settings: AppSettings) {
  const hasProviders = settings.providers.length > 0
  const hasModels = settings.models.length > 0
  return [
    {
      title: 'Portable data layer',
      detail: 'Settings, cache, logs, and temp files stay beside the app.',
      ready: true
    },
    {
      title: 'Project memory scaffold',
      detail: 'Each repo gets .agentdesk with SQLite, team config, and context.',
      ready: true
    },
    {
      title: 'Six-agent roster',
      detail: 'Roles, write scopes, and orchestration limits are stored.',
      ready: true
    },
    {
      title: 'Model connections',
      detail: hasProviders
        ? `${settings.providers.length} providers, ${settings.models.length} models in the catalog.`
        : 'Next: add OpenAI, Gemini, Ollama, or a custom endpoint.',
      ready: hasModels
    },
    {
      title: 'Single-agent build loop',
      detail: 'Plan and Build chat, snapshots, approvals, file edits, commands, and a change log.',
      ready: hasModels
    },
    {
      title: 'Memory and continuity',
      detail: 'Turn reports, shared and personal memory, rolling summaries, recall, and a memory viewer.',
      ready: hasModels
    },
    {
      title: 'Team meetings and orchestration',
      detail: 'Plan room, Build room, file claims, QA review, pauses, interrupts, and approvals.',
      ready: hasModels
    },
    {
      title: 'MCP and external tools',
      detail: 'Global catalog, project policies, stdio/HTTP/SSE, approvals, logs, and audit.',
      ready: true
    }
  ]
}

export function Landing({
  appInfo,
  settings,
  busy,
  onOpenProject,
  onOpenRecent,
  onRemoveRecent,
  onOpenSettings,
  onRevealData
}: LandingProps) {
  const disabled = Boolean(busy)
  const foundation = foundationFor(settings)

  return (
    <div className="landing-shell">
      <header className="landing-topbar">
        <Brand version={appInfo.version} />
        <div className="topbar-actions">
          <span className="local-chip">
            <span className="status-dot" />
            Local workspace
          </span>
          <button className="btn btn-ghost" type="button" onClick={onOpenSettings}>
            <Icon name="settings" size={16} />
            Settings
          </button>
        </div>
      </header>

      <main className="landing-main">
        <section className="hero-grid">
          <div className="hero-copy">
            <span className="eyebrow">Your team is on standby</span>
            <h1>
              You are the boss.
              <span> The team does the work.</span>
            </h1>
            <p className="hero-lede">
              Open a project folder. AgentDesk creates a private workspace inside it for your
              team, decisions, tasks, and memory. Nothing is installed on your PC.
            </p>
            <div className="hero-actions">
              <button
                className="btn btn-primary btn-large"
                type="button"
                onClick={onOpenProject}
                disabled={disabled}
              >
                <Icon name="folder" size={18} />
                {busy === 'open' ? 'Opening...' : 'Open project folder'}
                <Icon name="arrow-right" size={17} />
              </button>
              <button className="btn btn-quiet btn-large" type="button" onClick={onOpenSettings}>
                <Icon name="hard-drive" size={17} />
                Data locations
              </button>
            </div>
            <div className="hero-meta">
              <span>
                <Icon name="shield" size={15} />
                No telemetry
              </span>
              <span>
                <Icon name="database" size={15} />
                SQLite inside each repo
              </span>
              <span>
                <Icon name="lock" size={15} />
                Keys stay in the app folder
              </span>
            </div>
          </div>

          <aside className="foundation-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">Build status</span>
                <h2>Foundation</h2>
              </div>
              <span className="phase-badge">Phase 8</span>
            </div>
            <div className="foundation-list">
              {foundation.map((item) => (
                <div className={item.ready ? 'foundation-item ready' : 'foundation-item'} key={item.title}>
                  <span className="foundation-icon">
                    <Icon name={item.ready ? 'check' : 'clock'} size={15} />
                  </span>
                  <div>
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="foundation-foot">
              <Icon name="sparkles" size={16} />
              <span>Plan room, Build room, guarded builds, memory, and MCP are runnable now.</span>
            </div>
          </aside>
        </section>

        <section className="recent-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Workspaces</span>
              <h2>Recent projects</h2>
            </div>
            <span className="section-count">{settings.recentProjects.length} saved</span>
          </div>

          {settings.recentProjects.length === 0 ? (
            <div className="empty-projects">
              <div className="empty-icon">
                <Icon name="folder" size={26} />
              </div>
              <div>
                <h3>No project folders yet</h3>
                <p>
                  Open any code folder. AgentDesk will add a <code>.agentdesk</code> workspace
                  without touching your existing files.
                </p>
              </div>
              <button className="btn btn-ghost" type="button" onClick={onOpenProject} disabled={disabled}>
                <Icon name="plus" size={16} />
                Choose a folder
              </button>
            </div>
          ) : (
            <div className="recent-grid">
              {settings.recentProjects.map((project) => (
                <article className="recent-card" key={project.path}>
                  <button
                    className="recent-open"
                    type="button"
                    onClick={() => onOpenRecent(project.path)}
                    disabled={disabled}
                    title={project.path}
                  >
                    <span className="recent-icon">
                      <Icon name="folder" size={19} />
                    </span>
                    <span className="recent-copy">
                      <strong>{project.name}</strong>
                      <span className="recent-path">{shortPath(project.path)}</span>
                      <span className="recent-time">
                        <Icon name="clock" size={13} />
                        {formatRelativeTime(project.lastOpenedAt)}
                      </span>
                    </span>
                    <Icon name="arrow-right" size={17} className="recent-arrow" />
                  </button>
                  <button
                    className="icon-button recent-remove"
                    type="button"
                    onClick={() => onRemoveRecent(project.path)}
                    disabled={disabled}
                    aria-label={`Remove ${project.name} from recent projects`}
                    title="Remove from recent projects"
                  >
                    <Icon name="close" size={15} />
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="landing-notes">
          <div className="note-card">
            <span className="note-icon">
              <Icon name="database" size={19} />
            </span>
            <div>
              <strong>Project data travels with the repo</strong>
              <p>
                Chats, memory, tasks, and decisions live in <code>.agentdesk</code>. Delete the app
                and the repo keeps its history.
              </p>
            </div>
          </div>
          <div className="note-card">
            <span className="note-icon">
              <Icon name="users" size={19} />
            </span>
            <div>
              <strong>One boss, six specialists</strong>
              <p>
                Coordinator, frontend, backend, database, QA, and DevOps are configured with
                roles and write scopes.
              </p>
            </div>
          </div>
          <div className="note-card">
            <span className="note-icon">
              <Icon name="terminal" size={19} />
            </span>
            <div>
              <strong>No installer, no PC-wide database</strong>
              <p>
                The app runs from its folder. SQLite is embedded and every project gets its own
                database file.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="footer-path">
          <span className="footer-label">App data</span>
          <code title={appInfo.dataDir}>{shortPath(appInfo.dataDir, 72)}</code>
        </div>
        <button className="btn btn-quiet btn-small" type="button" onClick={onRevealData}>
          <Icon name="external" size={15} />
          Open folder
        </button>
      </footer>
    </div>
  )
}



