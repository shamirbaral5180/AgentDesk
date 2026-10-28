import type { AppUpdateInfo } from '@shared/types'
import { Icon } from './Icon'

type UpdateBannerProps = {
  update: AppUpdateInfo
  onDismiss: () => void
  onDownload: () => void
  onReleaseNotes: () => void
}

export function UpdateBanner({
  update,
  onDismiss,
  onDownload,
  onReleaseNotes
}: UpdateBannerProps) {
  return (
    <div className="update-banner" role="status">
      <span className="update-banner-icon">
        <Icon name="arrow-down" size={17} />
      </span>
      <div className="update-banner-copy">
        <strong>AgentDesk {update.latestVersion} is available</strong>
        <span>
          You are running {update.currentVersion}. Download the new portable zip from GitHub.
        </span>
      </div>
      <div className="update-banner-actions">
        <button className="btn btn-quiet btn-small" type="button" onClick={onReleaseNotes}>
          Release notes
        </button>
        <button className="btn btn-primary btn-small" type="button" onClick={onDownload}>
          <Icon name="arrow-down" size={13} />
          Download zip
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss update notification"
          title="Dismiss"
        >
          <Icon name="close" size={15} />
        </button>
      </div>
    </div>
  )
}
