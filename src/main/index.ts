import fs from 'node:fs'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  screen,
  session
} from 'electron'
import type { Rectangle } from 'electron'
import { initializeAppPaths } from './config/appPaths'
import { createLogger } from './config/logger'
import { loadSettings, removeRecentProject, updateWindowState } from './config/settings'
import { closeProject } from './project/projectService'
import { cancelAllChatRuns } from './chat/chatService'
import { cancelAllMeetings } from './meetings/meetingService'
import { killAllManagedProcesses } from './commands/commandRunner'
import { registerIpcHandlers } from './ipc/ipc'
import {
  captureWindow,
  cleanupModelShowcase,
  openChangesDialog,
  openChatContextInspector,
  openSettingsTab,
  prepareApprovalShowcase,
  prepareBuildRoomShowcase,
  prepareBuildShowcase,
  prepareChatShowcase,
  prepareMcpShowcase,
  prepareMeetingShowcase,
  cleanupMcpShowcase,
  sendChatFromUi,
  prepareModelShowcase,
  prepareShowcaseProject
} from './screenshot'
import { createMockOpenAIServer, runPhase2Smoke } from './phase2Smoke'
import type { MockServer } from './phase2Smoke'
import { runPhase3Smoke } from './phase3Smoke'
import { runPhase4Smoke } from './phase4Smoke'
import { runPhase5Smoke } from './phase5Smoke'
import { runPhase6Smoke } from './phase6Smoke'
import { runPhase7Smoke } from './phase7Smoke'
import { runPhase8Smoke } from './phase8Smoke'
import { runPhase9Smoke } from './phase9Smoke'
import { runPhase10Smoke } from './phase10Smoke'
import { checkForUpdates } from './updates/updateService'
import { closeAllServers } from './mcp/mcpManager'
import { createMockChatServer, type MockChatServer } from './chatMock'
import { createPhase4MockServer, type Phase4MockServer } from './phase4Mock'
import { createPhase6MockServer, type Phase6MockServer } from './phase6Mock'
import { createPhase7MockServer, type Phase7MockServer } from './phase7Mock'
import { runSmokeTest } from './smoke'

const log = createLogger('main')
const isSmokeTest = process.argv.includes('--smoke')
const isPhase2Smoke = process.argv.includes('--phase2-smoke')
const isPhase3Smoke = process.argv.includes('--phase3-smoke')
const isPhase4Smoke = process.argv.includes('--phase4-smoke')
const isPhase5Smoke = process.argv.includes('--phase5-smoke')
const isPhase6Smoke = process.argv.includes('--phase6-smoke')
const isPhase7Smoke = process.argv.includes('--phase7-smoke')
const isPhase8Smoke = process.argv.includes('--phase8-smoke')
const isPhase9Smoke = process.argv.includes('--phase9-smoke')
const isPhase10Smoke = process.argv.includes('--phase10-smoke')
const screenshotArgument = process.argv.find((argument) => argument.startsWith('--screenshot'))
const isScreenshotMode = Boolean(screenshotArgument)
const screenshotTarget =
  screenshotArgument && screenshotArgument.includes('=')
    ? screenshotArgument.split('=')[1]
    : 'workspace'

let startupError: Error | null = null
try {
  initializeAppPaths()
} catch (error) {
  startupError = error instanceof Error ? error : new Error(String(error))
}

let mainWindow: BrowserWindow | null = null
let saveTimer: NodeJS.Timeout | null = null

app.setAppUserModelId('com.agentdesk.app')

function boundsVisible(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    const horizontal = bounds.x < area.x + area.width && bounds.x + bounds.width > area.x
    const vertical = bounds.y < area.y + area.height && bounds.y + bounds.height > area.y
    return horizontal && vertical
  })
}

function saveWindowState(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return
  }
  try {
    const bounds = window.getNormalBounds()
    updateWindowState({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: window.isMaximized()
    })
  } catch (error) {
    log.warn('Could not save window state', { error })
  }
}

function scheduleWindowStateSave(window: BrowserWindow): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveWindowState(window)
  }, 500)
}

function createWindow(): void {
  const settings = loadSettings()
  const primaryArea = screen.getPrimaryDisplay().workAreaSize
  const width = Math.min(Math.max(settings.window.width, 1024), primaryArea.width)
  const height = Math.min(Math.max(settings.window.height, 680), primaryArea.height)
  const savedBounds: Rectangle | null =
    settings.window.x !== undefined &&
    settings.window.y !== undefined &&
    boundsVisible({
      x: settings.window.x,
      y: settings.window.y,
      width,
      height
    })
      ? {
          x: settings.window.x,
          y: settings.window.y,
          width,
          height
        }
      : null

  const window = new BrowserWindow({
    width,
    height,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'AgentDesk',
    backgroundColor: '#0b0e13',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  mainWindow = window
  window.setMenuBarVisibility(false)

  window.once('ready-to-show', () => {
    if (settings.window.maximized) {
      window.maximize()
    }
    window.show()
  })

  window.on('resize', () => scheduleWindowStateSave(window))
  window.on('move', () => scheduleWindowStateSave(window))
  window.on('close', () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    saveWindowState(window)
  })
  window.on('closed', () => {
    mainWindow = null
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  window.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) {
      return
    }
    if (url.startsWith('file://')) {
      return
    }
    event.preventDefault()
  })

  window.webContents.on('before-input-event', (event, input) => {
    if (!app.isPackaged && input.type === 'keyDown' && input.key === 'F12') {
      window.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void window.loadURL(rendererUrl)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

const hasSingleInstanceLock =
  isSmokeTest ||
  isPhase2Smoke ||
  isPhase3Smoke ||
  isPhase4Smoke ||
  isPhase5Smoke ||
  isPhase6Smoke ||
  isPhase7Smoke ||
  isPhase8Smoke ||
  isPhase9Smoke ||
  isScreenshotMode
    ? true
    : app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      return
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.show()
    mainWindow.focus()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })

  app.on('before-quit', () => {
    cancelAllChatRuns()
    cancelAllMeetings()
    closeAllServers()
    killAllManagedProcesses()
    closeProject()
  })

  app.on('will-quit', () => {
    cancelAllChatRuns()
    cancelAllMeetings()
    closeAllServers()
    killAllManagedProcesses()
    closeProject()
  })

  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception', { error })
  })

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', { reason })
  })

  void app.whenReady().then(async () => {
    if (startupError) {
      dialog.showErrorBox(
        'AgentDesk cannot start',
        `The app folder is not writable.\n\n${startupError.message}\n\nMove the AgentDesk folder to a writable location and try again.`
      )
      app.quit()
      return
    }

    nativeTheme.themeSource = 'dark'
    Menu.setApplicationMenu(null)
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })
    session.defaultSession.setPermissionCheckHandler(() => false)

    if (isSmokeTest) {
      const exitCode = await runSmokeTest()
      app.exit(exitCode)
      return
    }

    if (isPhase2Smoke) {
      const exitCode = await runPhase2Smoke()
      app.exit(exitCode)
      return
    }

    if (isPhase3Smoke) {
      const exitCode = await runPhase3Smoke()
      app.exit(exitCode)
      return
    }

    if (isPhase4Smoke) {
      const exitCode = await runPhase4Smoke()
      app.exit(exitCode)
      return
    }

    if (isPhase5Smoke) {
      const exitCode = await runPhase5Smoke()
      app.exit(exitCode)
      return
    }

    if (isPhase6Smoke) {
      const exitCode = await runPhase6Smoke()
      app.exit(exitCode)
      return
    }

    if (isPhase7Smoke) {
      const exitCode = await runPhase7Smoke()
      app.exit(exitCode)
      return
    }

    if (isPhase8Smoke) {
      const exitCode = await runPhase8Smoke()
      app.exit(exitCode)
      return
    }

    if (isPhase9Smoke) {
      const exitCode = await runPhase9Smoke()
      app.exit(exitCode)
      return
    }

    if (isPhase10Smoke) {
      const exitCode = await runPhase10Smoke()
      app.exit(exitCode)
      return
    }

    if (isScreenshotMode) {
      let showcaseRoot: string | null = null
      let showcaseProviderId: string | null = null
      let showcaseMcpServerId: string | null = null
      let mockServer: MockServer | null = null
      let chatMockServer: MockChatServer | null = null
      let phase4MockServer: Phase4MockServer | null = null
      let phase6MockServer: Phase6MockServer | null = null
      let phase7MockServer: Phase7MockServer | null = null
      try {
        const chatShowcase =
          screenshotTarget === 'chat' ||
          screenshotTarget === 'chat-context' ||
          screenshotTarget === 'chat-live'
        const buildShowcase =
          screenshotTarget === 'build' ||
          screenshotTarget === 'memory' ||
          screenshotTarget === 'changes' ||
          screenshotTarget === 'approval'
        const modelShowcase =
          screenshotTarget === 'workspace' ||
          screenshotTarget === 'providers' ||
          screenshotTarget === 'team' ||
          screenshotTarget === 'test' ||
          screenshotTarget === 'test-run'
        const meetingShowcase = screenshotTarget === 'meeting'
        const buildRoomShowcase = screenshotTarget === 'build-room'
        const mcpShowcase = screenshotTarget === 'mcp'
        if (mcpShowcase) {
          const showcase = await prepareMcpShowcase()
          showcaseRoot = showcase.root
          showcaseMcpServerId = showcase.serverId
        } else if (buildRoomShowcase) {
          phase6MockServer = await createPhase6MockServer()
          phase7MockServer = await createPhase7MockServer()
          const showcase = await prepareBuildRoomShowcase({
            planBaseUrl: phase6MockServer.baseUrl,
            buildBaseUrl: phase7MockServer.baseUrl
          })
          showcaseRoot = showcase.root
          showcaseProviderId = showcase.providerId
        } else if (meetingShowcase) {
          phase6MockServer = await createPhase6MockServer()
          const showcase = await prepareMeetingShowcase(phase6MockServer.baseUrl)
          showcaseRoot = showcase.root
          showcaseProviderId = showcase.providerId
        } else if (chatShowcase) {
          chatMockServer = await createMockChatServer()
          const showcase = await prepareChatShowcase(chatMockServer.baseUrl)
          showcaseRoot = showcase.root
          showcaseProviderId = showcase.providerId
        } else if (buildShowcase) {
          phase4MockServer = await createPhase4MockServer()
          const showcase =
            screenshotTarget === 'approval'
              ? await prepareApprovalShowcase(phase4MockServer.baseUrl)
              : await prepareBuildShowcase(phase4MockServer.baseUrl)
          showcaseRoot = showcase.root
          showcaseProviderId = showcase.providerId
        } else if (modelShowcase) {
          if (screenshotTarget === 'test-run') {
            mockServer = await createMockOpenAIServer()
          }
          const showcase = prepareModelShowcase(mockServer?.baseUrl)
          showcaseRoot = showcase.root
          showcaseProviderId = showcase.providerId
        } else if (screenshotTarget !== 'landing') {
          showcaseRoot = prepareShowcaseProject()
        }
        registerIpcHandlers()
        createWindow()
        if (!mainWindow) {
          throw new Error('Window was not created')
        }

        let topShot: string
        let bottomShot: string | null = null

        if (screenshotTarget === 'meeting') {
          await new Promise<void>((resolve) => setTimeout(resolve, 1400))
          await mainWindow.webContents.executeJavaScript(
            "(() => { const tab = [...document.querySelectorAll('.view-tab')].find((element) => element.textContent?.trim() === 'Plan room'); if (tab) { tab.click(); return true } return false })()"
          )
          await new Promise<void>((resolve) => setTimeout(resolve, 700))
          topShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}.png`
          )
          bottomShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}-bottom.png`,
            '.meeting-scroll'
          )
        } else if (screenshotTarget === 'build-room') {
          await new Promise<void>((resolve) => setTimeout(resolve, 1400))
          await mainWindow.webContents.executeJavaScript(
            "(() => { const tab = [...document.querySelectorAll('.view-tab')].find((element) => element.textContent?.trim() === 'Build room'); if (tab) { tab.click(); return true } return false })()"
          )
          await new Promise<void>((resolve) => setTimeout(resolve, 800))
          topShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}.png`,
            '.meeting-scroll',
            true
          )
          bottomShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}-bottom.png`,
            '.meeting-scroll'
          )
        } else if (screenshotTarget === 'data') {
          await openSettingsTab(mainWindow, 'Data')
          await new Promise<void>((resolve) => setTimeout(resolve, 1200))
          topShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}.png`
          )
          bottomShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}-bottom.png`,
            '.modal-body'
          )
        } else if (screenshotTarget === 'mcp') {
          await openSettingsTab(mainWindow, 'MCP')
          await new Promise<void>((resolve) => setTimeout(resolve, 500))
          topShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}.png`
          )
        } else if (screenshotTarget === 'build') {
          topShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}.png`,
            '.chat-scroll',
            true
          )
          bottomShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}-bottom.png`,
            '.chat-scroll'
          )
        } else if (screenshotTarget === 'memory') {
          await openSettingsTab(mainWindow, 'Memory')
          topShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}.png`
          )
        } else if (screenshotTarget === 'approval') {
          await new Promise<void>((resolve) => setTimeout(resolve, 700))
          topShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}.png`
          )
        } else if (screenshotTarget === 'changes') {
          await openChangesDialog(mainWindow)
          topShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}.png`
          )
        } else if (screenshotTarget === 'project') {
          await new Promise<void>((resolve) => setTimeout(resolve, 1200))
          await mainWindow.webContents.executeJavaScript(
            "(() => { const tab = [...document.querySelectorAll('.view-tab')].find((element) => element.textContent?.trim() === 'Project'); if (tab) { tab.click(); return true } return false })()"
          )
          topShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}.png`
          )
          bottomShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}-bottom.png`,
            '.main-scroll'
          )
        } else if (screenshotTarget === 'chat-live') {
          const sent = await sendChatFromUi(mainWindow)
          if (!sent) {
            throw new Error('Could not send a message through the chat composer')
          }
          topShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}.png`,
            '.chat-scroll'
          )
          await new Promise<void>((resolve) => setTimeout(resolve, 6500))
        } else if (screenshotTarget === 'chat-context') {
          await openChatContextInspector(mainWindow)
          topShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}.png`
          )
        } else if (screenshotTarget === 'chat') {
          topShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}.png`,
            '.chat-scroll',
            true
          )
          bottomShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}-bottom.png`,
            '.chat-scroll'
          )
        } else if (
          screenshotTarget === 'providers' ||
          screenshotTarget === 'team' ||
          screenshotTarget === 'test' ||
          screenshotTarget === 'test-run'
        ) {
          await openSettingsTab(
            mainWindow,
            screenshotTarget === 'team' ? 'Team' : 'Providers'
          )
          if (screenshotTarget === 'team') {
            await mainWindow.webContents.executeJavaScript(
              "(() => { const button = [...document.querySelectorAll('.team-row-actions button')].find((element) => element.textContent?.trim() === 'Configure'); if (button) { button.click(); return true } return false })()"
            )
            await new Promise<void>((resolve) => setTimeout(resolve, 350))
          }
          if (screenshotTarget === 'test' || screenshotTarget === 'test-run') {
            await mainWindow.webContents.executeJavaScript(
              "(() => { const button = [...document.querySelectorAll('.model-actions button')].find((element) => element.textContent?.trim() === 'Test'); if (button) { button.click(); return true } return false })()"
            )
            await new Promise<void>((resolve) => setTimeout(resolve, 500))
          }
          if (screenshotTarget === 'test-run') {
            const started = await mainWindow.webContents.executeJavaScript(
              "(() => { const button = [...document.querySelectorAll('.test-modal button')].find((element) => element.textContent?.trim() === 'Run test'); if (button) { button.click(); return true } return false })()"
            )
            console.log('SCREENSHOT_TEST_STARTED', started)
            await new Promise<void>((resolve) => setTimeout(resolve, 1200))
            const streamed = await mainWindow.webContents.executeJavaScript(
              "document.querySelector('.test-output pre')?.textContent ?? ''"
            )
            console.log('SCREENSHOT_TEST_STREAM', streamed)
          }
          topShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}.png`
          )
          if (screenshotTarget === 'team') {
            bottomShot = await captureWindow(
              mainWindow,
              `screenshot-${screenshotTarget}-bottom.png`,
              '.modal-body'
            )
          }
        } else {
          topShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}.png`
          )
          const scrollSelector =
            screenshotTarget === 'landing' ? '.landing-shell' : '.main-scroll'
          bottomShot = await captureWindow(
            mainWindow,
            `screenshot-${screenshotTarget}-bottom.png`,
            scrollSelector
          )
        }

        console.log(
          `SCREENSHOT_RESULT ${JSON.stringify({ target: screenshotTarget, topShot, bottomShot })}`
        )
        if (screenshotTarget === 'approval') {
          cancelAllChatRuns()
          killAllManagedProcesses()
          await new Promise<void>((resolve) => setTimeout(resolve, 500))
        }
        if (showcaseProviderId) {
          cleanupModelShowcase(showcaseProviderId, showcaseRoot ?? '')
        }
        if (showcaseRoot) {
          fs.rmSync(path.resolve(showcaseRoot, '..', 'phase4-outside.txt'), { force: true })
        }
        if (showcaseMcpServerId) {
          cleanupMcpShowcase(showcaseMcpServerId)
        }
        closeProject()
        if (showcaseRoot) {
          removeRecentProject(showcaseRoot)
        }
        if (mockServer) {
          await mockServer.close()
        }
        if (chatMockServer) {
          await chatMockServer.close()
        }
        if (phase4MockServer) {
          await phase4MockServer.close()
        }
        if (phase6MockServer) {
          await phase6MockServer.close()
        }
        if (phase7MockServer) {
          await phase7MockServer.close()
        }
        app.exit(0)
      } catch (error) {
        log.error('Screenshot mode failed', { error })
        console.error('SCREENSHOT_FAILED', error)
        if (showcaseMcpServerId) {
          cleanupMcpShowcase(showcaseMcpServerId)
        }
        closeProject()
        if (showcaseRoot) {
          removeRecentProject(showcaseRoot)
        }
        if (mockServer) {
          await mockServer.close()
        }
        if (chatMockServer) {
          await chatMockServer.close()
        }
        if (phase4MockServer) {
          await phase4MockServer.close()
        }
        if (phase6MockServer) {
          await phase6MockServer.close()
        }
        if (phase7MockServer) {
          await phase7MockServer.close()
        }
        app.exit(1)
      }
      return
    }

    registerIpcHandlers()
    createWindow()
    void checkForUpdates(true)
  })
}










