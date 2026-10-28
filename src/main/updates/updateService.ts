import { app, BrowserWindow, shell } from 'electron'
import { IPC_CHANNELS, type AppSettings, type AppUpdateInfo } from '@shared/types'
import { createLogger } from '../config/logger'
import { loadSettings, updateSettingsPreferences } from '../config/settings'
import { AppError } from '../errors'

const log = createLogger('updates')
const OWNER = 'shamirbaral5180'
const REPO = 'AgentDesk'
const RELEASES_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`
const RELEASE_PREFIX = `https://github.com/${OWNER}/${REPO}/releases/`

let lastUpdate: AppUpdateInfo | null = null
let lastCheckedAt = 0
let checkPromise: Promise<AppUpdateInfo> | null = null

function versionParts(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((value) => (Number.isFinite(value) ? value : 0))
}

export function isNewerVersion(latest: string, current: string): boolean {
  const left = versionParts(latest)
  const right = versionParts(current)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) {
      return a > b
    }
  }
  return false
}

function broadcast(info: AppUpdateInfo): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.updateEvent, info)
    }
  }
}

export function getLastUpdate(): AppUpdateInfo | null {
  return lastUpdate
}

export async function checkForUpdates(force = false): Promise<AppUpdateInfo> {
  if (!force && lastUpdate && Date.now() - lastCheckedAt < 10 * 60_000) {
    return lastUpdate
  }
  if (checkPromise) {
    return checkPromise
  }
  checkPromise = (async () => {
    const currentVersion = app.getVersion()
    const checkedAt = Date.now()
    try {
      const response = await fetch(RELEASES_API, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': `AgentDesk/${currentVersion}`,
          'x-github-api-version': '2022-11-28'
        },
        signal: AbortSignal.timeout(10_000)
      })
      if (response.status === 404) {
        lastUpdate = {
          currentVersion,
          latestVersion: null,
          available: false,
          releaseName: null,
          releaseUrl: null,
          downloadUrl: null,
          publishedAt: null,
          releaseNotes: null,
          checkedAt
        }
        lastCheckedAt = checkedAt
        persistCheckedAt(checkedAt)
        return lastUpdate
      }
      if (!response.ok) {
        throw new Error(`GitHub release check failed with HTTP ${response.status}.`)
      }
      const release = (await response.json()) as {
        tag_name?: string
        name?: string
        body?: string
        html_url?: string
        published_at?: string
        assets?: Array<{ name?: string; browser_download_url?: string }>
      }
      const latestVersion = (release.tag_name ?? '').replace(/^v/i, '')
      const zip = (release.assets ?? []).find((asset) =>
        (asset.name ?? '').toLowerCase().endsWith('.zip')
      )
      const available = Boolean(
        latestVersion && zip?.browser_download_url && isNewerVersion(latestVersion, currentVersion)
      )
      lastUpdate = {
        currentVersion,
        latestVersion: latestVersion || null,
        available,
        releaseName: release.name ?? release.tag_name ?? null,
        releaseUrl: release.html_url ?? null,
        downloadUrl: zip?.browser_download_url ?? null,
        publishedAt: release.published_at ?? null,
        releaseNotes: release.body ? release.body.slice(0, 8_000) : null,
        checkedAt
      }
      lastCheckedAt = checkedAt
      persistCheckedAt(checkedAt)
      if (available) {
        log.info('New AgentDesk release available', {
          currentVersion,
          latestVersion,
          downloadUrl: lastUpdate.downloadUrl
        })
        const dismissed = loadSettings().updates.dismissedVersion
        if (dismissed !== latestVersion) {
          broadcast(lastUpdate)
        }
      }
      return lastUpdate
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('Could not check GitHub releases', { error: message })
      lastUpdate = {
        currentVersion,
        latestVersion: null,
        available: false,
        releaseName: null,
        releaseUrl: null,
        downloadUrl: null,
        publishedAt: null,
        releaseNotes: null,
        checkedAt,
        error: message
      }
      lastCheckedAt = checkedAt
      persistCheckedAt(checkedAt)
      return lastUpdate
    } finally {
      checkPromise = null
    }
  })()
  return checkPromise
}

function persistCheckedAt(checkedAt: number): void {
  try {
    updateSettingsPreferences({ updates: { lastCheckedAt: checkedAt } })
  } catch (error) {
    log.warn('Could not persist the update check time', { error })
  }
}

export function dismissUpdate(version: string): AppSettings {
  const settings = updateSettingsPreferences({
    updates: { dismissedVersion: version }
  })
  log.info('Update notification dismissed', { version })
  return settings
}

export async function openUpdateDownload(url: string): Promise<void> {
  const allowed =
    lastUpdate?.downloadUrl === url ||
    lastUpdate?.releaseUrl === url ||
    (url.startsWith(RELEASE_PREFIX) && url.toLowerCase().endsWith('.zip'))
  if (!allowed) {
    throw new AppError(
      'UPDATE_URL_DENIED',
      'Only AgentDesk GitHub release zip downloads can be opened.'
    )
  }
  await shell.openExternal(url)
}
