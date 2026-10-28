import { Icon } from './Icon'

type ErrorBannerProps = {
  message: string
  onDismiss: () => void
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  return (
    <div className="error-banner" role="alert">
      <span className="error-banner-icon">
        <Icon name="alert" size={18} />
      </span>
      <div className="error-banner-copy">
        <strong>Something went wrong</strong>
        <span>{message}</span>
      </div>
      <button className="icon-button" type="button" onClick={onDismiss} aria-label="Dismiss error">
        <Icon name="close" size={16} />
      </button>
    </div>
  )
}
