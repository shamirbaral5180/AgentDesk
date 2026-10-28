import type { AppInfo, AppSettings, ProjectInfo } from '@shared/types'
import { ProjectDesk } from './ProjectDesk'

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
  return (
    <ProjectDesk
      project={project}
      appInfo={appInfo}
      settings={settings}
      busy={busy}
      onCloseProject={onCloseProject}
      onOpenSettings={onOpenSettings}
      onRevealProject={onRevealProject}
      onError={onError}
    />
  )
}
