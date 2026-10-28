export type IconName =
  | 'folder'
  | 'file'
  | 'chevron'
  | 'settings'
  | 'close'
  | 'arrow-right'
  | 'database'
  | 'users'
  | 'hard-drive'
  | 'sparkles'
  | 'check'
  | 'lock'
  | 'terminal'
  | 'external'
  | 'plus'
  | 'clock'
  | 'branch'
  | 'shield'
  | 'alert'
  | 'panel'
  | 'chat'
  | 'paperclip'
  | 'image'
  | 'stop'
  | 'send'
  | 'refresh'
  | 'copy'
  | 'arrow-down'
  | 'moon'
  | 'sun'

type IconProps = {
  name: IconName
  size?: number
  className?: string
}

const paths: Record<IconName, string> = {
  folder: 'M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
  file: 'M14 2.75H7a2 2 0 0 0-2 2v14.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.75zM14 2.75v5h5',
  chevron: 'm9 18 6-6-6-6',
  settings:
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.7 1.7-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V22h-2.4v-.09A1.7 1.7 0 0 0 11.7 20.3a1.7 1.7 0 0 0-1.88.34l-.06.06-1.7-1.7.06-.06A1.7 1.7 0 0 0 8.46 17a1.7 1.7 0 0 0-1.56-1.03H6.8v-2.4h.1a1.7 1.7 0 0 0 1.56-1.03 1.7 1.7 0 0 0-.34-1.88l-.06-.06 1.7-1.7.06.06A1.7 1.7 0 0 0 11.7 8.6a1.7 1.7 0 0 0 1.03-1.56V6.9h2.4v.14a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 1.7 1.7-.06.06A1.7 1.7 0 0 0 19.4 11.7c.2.62.78 1.04 1.42 1.04h.18v2.4h-.18c-.64 0-1.22.42-1.42 1.04z',
  close: 'M6 6l12 12M18 6 6 18',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  database:
    'M4 6.5c0-1.66 3.58-3 8-3s8 1.34 8 3-3.58 3-8 3-8-1.34-8-3zM4 6.5v5c0 1.66 3.58 3 8 3s8-1.34 8-3v-5M4 11.5v5c0 1.66 3.58 3 8 3s8-1.34 8-3v-5',
  users:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  'hard-drive':
    'M4 5.5h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1zM3 13h18M7 16.5h.01M11 16.5h.01',
  sparkles:
    'M12 3l1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4zM18.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8zM5 15l.6 1.7 1.7.6-1.7.6L5 19.6l-.6-1.7-1.7-.6 1.7-.6z',
  check: 'M20 6 9 17l-5-5',
  lock: 'M6 10V8a6 6 0 0 1 12 0v2M5 10h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM12 14v3',
  terminal: 'M4 17l6-6-6-6M12 19h8',
  external: 'M14 4h6v6M20 4 10 14M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5',
  plus: 'M12 5v14M5 12h14',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9c0 4-3 6-6 6H6',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  alert: 'M12 3 2.5 20h19zM12 9v5M12 17.5h.01',
  panel: 'M4 4h16v16H4zM9 4v16',
  chat: 'M21 12a8 8 0 0 1-8 8H7l-4 3v-6a8 8 0 0 1 8-8h2a8 8 0 0 1 8 3zM8.5 11h.01M12 11h.01M15.5 11h.01',
  paperclip:
    'M20 11.5 12.6 19a5 5 0 0 1-7.1-7.1l8-8a3.5 3.5 0 0 1 5 5l-8.1 8a2 2 0 0 1-2.8-2.8l7.4-7.4',
  image: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4 16l4.5-4.5 4 4 3-3L20 17',
  stop: 'M7 7h10v10H7z',
  send: 'M4 12 20 4l-4 16-4-7-8-1z',
  refresh: 'M20 11a8 8 0 1 0-2.3 6.5M20 5v6h-6',
  copy: 'M8 8h11v11H8zM5 16H4V4h12v1',
  'arrow-down': 'M12 5v14M6 13l6 6 6-6',
  moon: 'M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1'
}

export function Icon({ name, size = 18, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  )
}
