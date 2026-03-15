import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, chmodSync } from 'fs'
import { execSync } from 'child_process'
import Store from 'electron-store'
import YTDlpWrapLib from 'yt-dlp-wrap'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const YTDlpWrap: typeof YTDlpWrapLib = (YTDlpWrapLib as any).default ?? YTDlpWrapLib

interface AppSettings {
  downloadPath: string
  defaultFormat: string
  defaultQuality: string
  concurrentDownloads: number
}

interface AppState {
  lang: 'en' | 'ru'
  theme: 'fleet' | 'apathy'
  formatType: 'video' | 'audio'
  videoQuality: string
  audioQuality: string
  downloadPath: string
  concurrentDownloads: number
}

interface HistoryItem {
  id: string
  url: string
  title: string
  thumbnail?: string
  formatLabel: string
  status: 'complete' | 'error' | 'cancelled'
  createdAt: number
}

interface StoreSchema {
  settings: AppSettings
  appState: AppState
  history: HistoryItem[]
}

const store = new Store<StoreSchema>({
  defaults: {
    settings: {
      downloadPath: app.getPath('downloads'),
      defaultFormat: 'mp4',
      defaultQuality: '1080',
      concurrentDownloads: 3
    },
    appState: {
      lang: 'en',
      theme: 'fleet',
      formatType: 'video',
      videoQuality: '1080',
      audioQuality: 'mp3_best',
      downloadPath: app.getPath('downloads'),
      concurrentDownloads: 3
    },
    history: []
  }
})

function getYtDlpPath(): string {
  const binary = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bin', binary)
  }
  return join(app.getAppPath(), 'bin', binary)
}

/** Check if yt-dlp is available on system PATH */
function findSystemYtDlp(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where yt-dlp' : 'which yt-dlp'
    const result = execSync(cmd, { encoding: 'utf8', timeout: 3000 }).trim()
    const firstLine = result.split('\n')[0].trim()
    if (firstLine && existsSync(firstLine)) return firstLine
  } catch { /* not in PATH */ }
  return null
}

async function initYtDlp(): Promise<void> {
  // 1. Check bundled binary first
  const bundledPath = getYtDlpPath()
  if (existsSync(bundledPath)) {
    ytDlpWrap = new YTDlpWrap(bundledPath)
    return
  }

  // 2. Check system PATH
  const systemPath = findSystemYtDlp()
  if (systemPath) {
    ytDlpWrap = new YTDlpWrap(systemPath)
    return
  }

  // 3. Download from GitHub
  const binDir = join(bundledPath, '..')
  mkdirSync(binDir, { recursive: true })
  await YTDlpWrap.downloadFromGithub(bundledPath)
  // Make executable on Unix
  if (process.platform !== 'win32') {
    try { chmodSync(bundledPath, 0o755) } catch { /* ignore */ }
  }
  ytDlpWrap = new YTDlpWrap(bundledPath)
}

let ytDlpWrap: YTDlpWrap | null = null

// id -> { emitter, cancelled }
const activeDownloads = new Map<string, { emitter: ReturnType<YTDlpWrap['exec']>; cancelled: boolean }>()

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  // Load icon for dev mode
  const iconPath = join(app.getAppPath(), 'build', 'icon.ico')
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined

  mainWindow = new BrowserWindow({
    width: 1300,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    backgroundColor: '#05050A',
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Window controls
ipcMain.on('window-minimize', () => mainWindow?.minimize())
ipcMain.on('window-maximize', () => {
  mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize()
})
ipcMain.on('window-close', () => mainWindow?.close())

// Settings
ipcMain.handle('get-settings', () => store.get('settings'))
ipcMain.handle('save-settings', (_e, s: AppSettings) => { store.set('settings', s); return true })
ipcMain.handle('select-download-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0] ?? null
})

// App state (lang, format, quality, etc.)
ipcMain.handle('get-app-state', () => store.get('appState'))
ipcMain.handle('save-app-state', (_e, patch: Partial<AppState>) => {
  const current = store.get('appState')
  store.set('appState', { ...current, ...patch })
  return true
})

// History
ipcMain.handle('get-history', () => store.get('history'))
ipcMain.handle('append-history', (_e, item: HistoryItem) => {
  const history = store.get('history')
  const filtered = history.filter((h: HistoryItem) => h.id !== item.id)
  store.set('history', [item, ...filtered].slice(0, 200))
  return true
})
ipcMain.handle('clear-history', () => { store.set('history', []); return true })

// yt-dlp lifecycle
ipcMain.handle('check-ytdlp', () => {
  const bundled = getYtDlpPath()
  const system  = findSystemYtDlp()
  const exists  = existsSync(bundled) || !!system
  return { exists, path: existsSync(bundled) ? bundled : (system ?? '') }
})
ipcMain.handle('setup-ytdlp', async () => {
  try {
    await initYtDlp()
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

// Fetch video info
ipcMain.handle('fetch-video-info', async (_e, url: string) => {
  if (!ytDlpWrap) return { success: false, error: 'yt-dlp not initialized' }
  try {
    const info = await ytDlpWrap.getVideoInfo([url, '--no-playlist'])
    return { success: true, data: info }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

// Start download
ipcMain.handle('start-download', async (event, payload: {
  id: string; url: string; formatArgs: string[]; downloadPath: string
}) => {
  if (!ytDlpWrap) return { success: false, error: 'yt-dlp not initialized' }

  const settings = store.get('settings')
  const outDir = payload.downloadPath || settings.downloadPath

  const args = [
    payload.url,
    ...payload.formatArgs,
    '-o', join(outDir, '%(title)s.%(ext)s'),
    '--no-playlist',
    '--progress',
    '--newline'
  ]

  try {
    const emitter = ytDlpWrap.exec(args)
    activeDownloads.set(payload.id, { emitter, cancelled: false })

    emitter.on('ytDlpEvent', (eventType: string, eventData: string) => {
      if (eventType === 'download') {
        const pct   = eventData.match(/(\d+\.?\d*)%/)?.[1]
        const speed = eventData.match(/at\s+([\d.]+\s*\S+\/s)/)?.[1]
        const eta   = eventData.match(/ETA\s+([\d:]+)/)?.[1]
        event.sender.send('download-progress', {
          id: payload.id,
          progress: pct ? parseFloat(pct) : 0,
          speed: speed ?? '',
          eta: eta ?? '',
          status: 'downloading'
        })
      }
    })

    emitter.on('error', (err: Error) => {
      const dl = activeDownloads.get(payload.id)
      if (!dl?.cancelled) event.sender.send('download-error', { id: payload.id, error: err.message })
      activeDownloads.delete(payload.id)
    })

    emitter.on('close', () => {
      const dl = activeDownloads.get(payload.id)
      if (!dl?.cancelled) event.sender.send('download-complete', { id: payload.id })
      activeDownloads.delete(payload.id)
    })

    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

// Cancel download
ipcMain.handle('cancel-download', (_e, id: string) => {
  const dl = activeDownloads.get(id)
  if (!dl) return { success: false }
  dl.cancelled = true
  try { (dl.emitter as unknown as { kill: () => void }).kill() } catch {}
  activeDownloads.delete(id)
  return { success: true }
})

// Open folder
ipcMain.handle('open-folder', (_e, path: string) => shell.openPath(path))

// App lifecycle
app.whenReady().then(async () => {
  createWindow()
  initYtDlp().catch(() => { /* handled by setup-ytdlp IPC */ })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
