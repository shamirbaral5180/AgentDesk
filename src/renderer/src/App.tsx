import { useEffect, useState } from 'react'
import type {
  AppInfo,
  AppSettings,
  AppUpdateInfo,
  IpcResult,
  ProjectInfo,
  RecoveryReport
} from '@shared/types'
import { ErrorBanner } from './components/ErrorBanner'
import { Landing } from './components/Landing'
import { LoadingScreen } from './components/LoadingScreen'
import { ApprovalCenter } from './components/ApprovalCenter'
import { SettingsDialog } from './components/SettingsDialog'
import { UpdateBanner } from './components/UpdateBanner'
import { RecoveryBanner } from './components/RecoveryBanner'
import { Workspace } from './components/Workspace'

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) {
    throw new Error(result.error.message)
  }
  return result.data
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.'
}

export default function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [update, setUpdate] = useState<AppUpdateInfo | null>(null)
  const [updateDismissed, setUpdateDismissed] = useState(false)
  const [recovery, setRecovery] = useState<RecoveryReport | null>(null)
  const [recoveryDismissed, setRecoveryDismissed] = useState(false)

  async function loadRecovery(): Promise<void> {
    try {
      const result = await window.agentdesk.getRecoveryReport()
      if (result.ok) {
        setRecovery(result.data)
        setRecoveryDismissed(false)
      }
    } catch {
      // Recovery details are optional; the workspace still opens.
    }
  }

  useEffect(() => {
    let cancelled = false

    async function boot(): Promise<void> {
      if (!window.agentdesk) {
        setError('The secure preload bridge did not load. Restart AgentDesk.')
        setLoading(false)
        return
      }
      try {
        const [infoResult, settingsResult, projectResult] = await Promise.all([
          window.agentdesk.getAppInfo(),
          window.agentdesk.getSettings(),
          window.agentdesk.getCurrentProject()
        ])
        if (cancelled) {
          return
        }
        setAppInfo(unwrap(infoResult))
        setSettings(unwrap(settingsResult))
        const currentProject = unwrap(projectResult)
        setProject(currentProject)
        if (currentProject) {
          await loadRecovery()
        }
      } catch (bootError) {
        if (!cancelled) {
          setError(errorMessage(bootError))
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void boot()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!window.agentdesk) {
      return
    }
    const unsubscribe = window.agentdesk.onUpdateEvent((info) => {
      if (info.available) {
        setUpdate(info)
        setUpdateDismissed(false)
      }
    })
    void window.agentdesk
      .checkForUpdates()
      .then((result) => {
        if (result.ok && result.data.available) {
          setUpdate(result.data)
        }
      })
      .catch(() => undefined)
    return unsubscribe
  }, [])

  async function refreshSettings(): Promise<void> {
    try {
      const next = unwrap(await window.agentdesk.getSettings())
      setSettings(next)
    } catch (refreshError) {
      setError(errorMessage(refreshError))
    }
  }

  async function openProject(): Promise<void> {
    setBusy('open')
    setError(null)
    try {
      const opened = unwrap(await window.agentdesk.pickProject())
      if (opened) {
        setProject(opened)
        setSettingsOpen(false)
        await refreshSettings()
        await loadRecovery()
      }
    } catch (openError) {
      setError(errorMessage(openError))
    } finally {
      setBusy(null)
    }
  }

  async function openRecent(projectPath: string): Promise<void> {
    setBusy('recent')
    setError(null)
    try {
      const opened = unwrap(await window.agentdesk.openRecentProject(projectPath))
      setProject(opened)
      setSettingsOpen(false)
      await refreshSettings()
      await loadRecovery()
    } catch (openError) {
      setError(errorMessage(openError))
    } finally {
      setBusy(null)
    }
  }

  async function removeRecent(projectPath: string): Promise<void> {
    setBusy('recent')
    setError(null)
    try {
      const next = unwrap(await window.agentdesk.removeRecentProject(projectPath))
      setSettings(next)
    } catch (removeError) {
      setError(errorMessage(removeError))
    } finally {
      setBusy(null)
    }
  }

  async function closeProject(): Promise<void> {
    setBusy('close')
    setError(null)
    try {
      unwrap(await window.agentdesk.closeProject())
      setProject(null)
      setRecovery(null)
      await refreshSettings()
    } catch (closeError) {
      setError(errorMessage(closeError))
    } finally {
      setBusy(null)
    }
  }

  async function resumeMeeting(meetingId: string): Promise<void> {
    setBusy('recovery')
    setError(null)
    try {
      unwrap(await window.agentdesk.resumeMeeting(meetingId))
      await loadRecovery()
    } catch (resumeError) {
      setError(errorMessage(resumeError))
    } finally {
      setBusy(null)
    }
  }

  async function markStopped(meetingId: string): Promise<void> {
    setBusy('recovery')
    setError(null)
    try {
      const result = unwrap(await window.agentdesk.markRecoveryStopped(meetingId))
      setRecovery(result)
    } catch (stopError) {
      setError(errorMessage(stopError))
    } finally {
      setBusy(null)
    }
  }

  async function dismissRecovery(): Promise<void> {
    setRecoveryDismissed(true)
  }

  async function dismissUpdateNotice(version: string): Promise<void> {
    setUpdateDismissed(true)
    try {
      const next = unwrap(await window.agentdesk.dismissUpdate(version))
      setSettings(next)
    } catch (dismissError) {
      setError(errorMessage(dismissError))
    }
  }

  async function saveBossName(name: string): Promise<boolean> {
    setBusy('settings')
    setError(null)
    try {
      const next = unwrap(await window.agentdesk.updateSettings({ bossName: name }))
      setSettings(next)
      return true
    } catch (saveError) {
      setError(errorMessage(saveError))
      return false
    } finally {
      setBusy(null)
    }
  }

  async function revealData(): Promise<void> {
    setError(null)
    try {
      unwrap(await window.agentdesk.revealDataFolder())
    } catch (revealError) {
      setError(errorMessage(revealError))
    }
  }

  async function revealProject(): Promise<void> {
    setError(null)
    try {
      unwrap(await window.agentdesk.revealProjectFolder())
    } catch (revealError) {
      setError(errorMessage(revealError))
    }
  }

  if (loading) {
    return <LoadingScreen />
  }

  if (!appInfo || !settings) {
    return (
      <div className="boot-error">
        <div className="boot-error-card">
          <h1>AgentDesk could not start</h1>
          <p>{error ?? 'The app data could not be loaded.'}</p>
          <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="app-root">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {update?.available &&
        !updateDismissed &&
        settings.updates.dismissedVersion !== update.latestVersion && (
        <UpdateBanner
          update={update}
          onDismiss={() => {
            if (update.latestVersion) {
              void dismissUpdateNotice(update.latestVersion)
            }
          }}
          onDownload={() => {
            if (update.downloadUrl) {
              void window.agentdesk.openUpdateDownload(update.downloadUrl)
            }
          }}
          onReleaseNotes={() => {
            if (update.releaseUrl) {
              void window.agentdesk.openUpdateDownload(update.releaseUrl)
            }
          }}
        />
      )}

      {project && recovery && !recoveryDismissed && (
        <RecoveryBanner
          report={recovery}
          busy={busy === 'recovery'}
          onResume={(meetingId) => void resumeMeeting(meetingId)}
          onMarkStopped={(meetingId) => void markStopped(meetingId)}
          onDismiss={() => void dismissRecovery()}
        />
      )}

      {project ? (
        <Workspace
          project={project}
          appInfo={appInfo}
          settings={settings}
          busy={busy}
          onCloseProject={() => void closeProject()}
          onOpenSettings={() => setSettingsOpen(true)}
          onRevealProject={() => void revealProject()}
          onError={setError}
        />
      ) : (
        <Landing
          appInfo={appInfo}
          settings={settings}
          busy={busy}
          onOpenProject={() => void openProject()}
          onOpenRecent={(path) => void openRecent(path)}
          onRemoveRecent={(path) => void removeRecent(path)}
          onOpenSettings={() => setSettingsOpen(true)}
          onRevealData={() => void revealData()}
        />
      )}

      {project && <ApprovalCenter />}

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        appInfo={appInfo}
        project={project}
        busy={busy}
        onClose={() => setSettingsOpen(false)}
        onSaveBossName={saveBossName}
        onRevealData={() => void revealData()}
        onRevealProject={() => void revealProject()}
        onSettingsChanged={setSettings}
        onProjectChanged={setProject}
      />
    </div>
  )
}

