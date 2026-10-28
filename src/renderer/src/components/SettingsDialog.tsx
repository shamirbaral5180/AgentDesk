import { useEffect, useState } from 'react'
import type { AppInfo, AppSettings, ProjectInfo } from '@shared/types'
import { Brand } from './Brand'
import { Icon } from './Icon'
import { shortPath } from '../lib/format'
import { ProvidersPanel } from './settings/ProvidersPanel'
import { TeamPanel } from './settings/TeamPanel'
import { MemoryPanel } from './settings/MemoryPanel'
import { McpPanel } from './settings/McpPanel'

type SettingsDialogProps = {
  open: boolean
  settings: AppSettings
  appInfo: AppInfo
  project: ProjectInfo | null
  busy: string | null
  onClose: () => void
  onSaveBossName: (name: string) => Promise<boolean>
  onRevealData: () => void
  onRevealProject: () => void
  onSettingsChanged: (settings: AppSettings) => void
  onProjectChanged: (project: ProjectInfo | null) => void
}

type SettingsTab = 'general' | 'providers' | 'team' | 'mcp' | 'memory' | 'data' | 'about'

export function SettingsDialog({
  open,
  settings,
  appInfo,
  project,
  busy,
  onClose,
  onSaveBossName,
  onRevealData,
  onRevealProject,
  onSettingsChanged,
  onProjectChanged
}: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>('general')
  const [bossName, setBossName] = useState(settings.bossName)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  useEffect(() => {
    if (!open) {
      return
    }
    setTab('general')
    setBossName(settings.bossName)
    setSaveState('idle')
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) {
    return null
  }

  const disabled = Boolean(busy)

  async function saveBossName(): Promise<void> {
    if (!bossName.trim()) {
      setSaveState('error')
      return
    }
    setSaveState('saving')
    const saved = await onSaveBossName(bossName.trim())
    setSaveState(saved ? 'saved' : 'error')
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div className="modal-title-group">
            <Brand compact />
            <div>
              <h2 id="settings-title">Settings</h2>
              <p>Local configuration for AgentDesk.</p>
            </div>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close settings">
            <Icon name="close" size={17} />
          </button>
        </header>

        <nav className="modal-tabs" aria-label="Settings sections">
          <button
            className={tab === 'general' ? 'modal-tab active' : 'modal-tab'}
            type="button"
            onClick={() => setTab('general')}
          >
            General
          </button>
          <button
            className={tab === 'providers' ? 'modal-tab active' : 'modal-tab'}
            type="button"
            onClick={() => setTab('providers')}
          >
            Providers
          </button>
          <button
            className={tab === 'team' ? 'modal-tab active' : 'modal-tab'}
            type="button"
            onClick={() => setTab('team')}
          >
            Team
          </button>
          <button
            className={tab === 'mcp' ? 'modal-tab active' : 'modal-tab'}
            type="button"
            onClick={() => setTab('mcp')}
          >
            MCP
          </button>
          <button
            className={tab === 'memory' ? 'modal-tab active' : 'modal-tab'}
            type="button"
            onClick={() => setTab('memory')}
          >
            Memory
          </button>
          <button
            className={tab === 'data' ? 'modal-tab active' : 'modal-tab'}
            type="button"
            onClick={() => setTab('data')}
          >
            Data
          </button>
          <button
            className={tab === 'about' ? 'modal-tab active' : 'modal-tab'}
            type="button"
            onClick={() => setTab('about')}
          >
            About
          </button>
        </nav>

        <div className="modal-body">
          {tab === 'general' && (
            <div className="settings-stack">
              <section className="settings-section">
                <div className="settings-section-heading">
                  <h3>Your name</h3>
                  <span className="soft-chip">Boss profile</span>
                </div>
                <label className="field">
                  <span>How the team addresses you</span>
                  <input
                    type="text"
                    value={bossName}
                    maxLength={80}
                    onChange={(event) => {
                      setBossName(event.target.value)
                      setSaveState('idle')
                    }}
                    placeholder="Boss"
                  />
                </label>
                <div className="field-actions">
                  <button
                    className="btn btn-primary btn-small"
                    type="button"
                    onClick={() => void saveBossName()}
                    disabled={disabled || saveState === 'saving'}
                  >
                    {saveState === 'saving' ? 'Saving...' : 'Save name'}
                  </button>
                  {saveState === 'saved' && (
                    <span className="inline-status success">
                      <Icon name="check" size={14} />
                      Saved
                    </span>
                  )}
                  {saveState === 'error' && (
                    <span className="inline-status error">
                      <Icon name="alert" size={14} />
                      Could not save
                    </span>
                  )}
                </div>
                <p className="field-hint">
                  This name is stored in the app settings and appears in every agent's context.
                </p>
              </section>

              <section className="settings-section">
                <div className="settings-section-heading">
                  <h3>Workspace</h3>
                  <span className="phase-badge">Local-first</span>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>Appearance</strong>
                    <span>Dark studio theme</span>
                  </div>
                  <span className="soft-chip">Dark</span>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>Project storage</strong>
                    <span>Each repository owns its workspace and SQLite database.</span>
                  </div>
                  <span className="soft-chip success">Local</span>
                </div>
              </section>
            </div>
          )}

          {tab === 'providers' && (
            <ProvidersPanel
              settings={settings}
              onSettingsChanged={onSettingsChanged}
              onProjectChanged={onProjectChanged}
            />
          )}

          {tab === 'team' && (
            <TeamPanel
              project={project}
              settings={settings}
              onProjectChanged={onProjectChanged}
              onGoToProviders={() => setTab('providers')}
            />
          )}

          {tab === 'mcp' && (
            <McpPanel project={project} onProjectChanged={onProjectChanged} />
          )}

          {tab === 'memory' && <MemoryPanel project={project} />}

          {tab === 'data' && (
            <div className="settings-stack">
              <section className="settings-section">
                <div className="settings-section-heading">
                  <h3>App folder</h3>
                  <span className="soft-chip">Global</span>
                </div>
                <PathRow label="Data folder" value={appInfo.dataDir} onReveal={onRevealData} disabled={disabled} />
                <PathRow label="Settings file" value={appInfo.settingsPath} onReveal={onRevealData} disabled={disabled} />
                <PathRow label="MCP catalog" value={appInfo.mcpDir} onReveal={onRevealData} disabled={disabled} />
              </section>

              <section className="settings-section">
                <div className="settings-section-heading">
                  <h3>Current project</h3>
                  <span className="soft-chip">Per repo</span>
                </div>
                {project ? (
                  <>
                    <PathRow
                      label="Workspace"
                      value={project.dataDir}
                      onReveal={onRevealProject}
                      disabled={disabled}
                    />
                    <PathRow
                      label="Database"
                      value={project.dbPath}
                      onReveal={onRevealProject}
                      disabled={disabled}
                    />
                    <PathRow
                      label="Team config"
                      value={project.teamPath}
                      onReveal={onRevealProject}
                      disabled={disabled}
                    />
                  </>
                ) : (
                  <p className="empty-settings">No project is open.</p>
                )}
              </section>

              <p className="settings-note">
                Persistent data stays inside this app folder and the opened repository. No
                PC-wide database service is installed.
              </p>
            </div>
          )}

          {tab === 'about' && (
            <div className="settings-stack">
              <div className="about-card">
                <Brand version={appInfo.version} />
                <p>
                  A local, portable multi-agent software studio. You direct the team; the team
                  keeps its own memory inside your project.
                </p>
              </div>

              <section className="settings-section">
                <div className="settings-section-heading">
                  <h3>Runtime</h3>
                  <span className="soft-chip">{appInfo.platform}</span>
                </div>
                <div className="about-grid">
                  <div>
                    <span>Electron</span>
                    <strong>{appInfo.electronVersion}</strong>
                  </div>
                  <div>
                    <span>Node</span>
                    <strong>{appInfo.nodeVersion}</strong>
                  </div>
                  <div>
                    <span>Mode</span>
                    <strong>{appInfo.isPackaged ? 'Packaged' : 'Development'}</strong>
                  </div>
                  <div>
                    <span>Telemetry</span>
                    <strong>None</strong>
                  </div>
                </div>
              </section>
            </div>
          )}
        </div>

        <footer className="modal-footer">
          <span className="modal-footer-note">
            <Icon name="shield" size={14} />
            Everything local. Nothing leaves this machine unless you connect a provider.
          </span>
          <button className="btn btn-quiet btn-small" type="button" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  )
}

type PathRowProps = {
  label: string
  value: string
  onReveal: () => void
  disabled: boolean
}

function PathRow({ label, value, onReveal, disabled }: PathRowProps) {
  return (
    <div className="path-setting-row">
      <div>
        <span>{label}</span>
        <code title={value}>{shortPath(value, 62)}</code>
      </div>
      <button className="btn btn-quiet btn-small" type="button" onClick={onReveal} disabled={disabled}>
        <Icon name="external" size={14} />
        Open
      </button>
    </div>
  )
}

