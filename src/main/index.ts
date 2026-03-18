import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, session } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, chmodSync, copyFileSync, writeFileSync } from 'fs'
import { execSync, spawnSync, spawn } from 'child_process'
import { net } from 'electron'
import Store from 'electron-store'
import YTDlpWrapLib from 'yt-dlp-wrap'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const YTDlpWrap: typeof YTDlpWrapLib = (YTDlpWrapLib as any).default ?? YTDlpWrapLib

interface AppSettings {
  downloadPath: string
  defaultFormat: string
  defaultQuality: string
  concurrentDownloads: number
  cookiesFromBrowser: string
  cookiesFile: string
}

interface AppState {
  lang: 'en' | 'ru'
  theme: 'fleet' | 'apathy'
  formatType: 'video' | 'audio'
  videoQuality: string
  audioQuality: string
  downloadPath: string
  concurrentDownloads: number
  cookiesFromBrowser: string
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
      concurrentDownloads: 3,
      cookiesFromBrowser: 'none',
      cookiesFile: ''
    },
    appState: {
      lang: 'en',
      theme: 'fleet',
      formatType: 'video',
      videoQuality: '1080',
      audioQuality: 'mp3_best',
      downloadPath: app.getPath('downloads'),
      concurrentDownloads: 3,
      cookiesFromBrowser: 'none'
    },
    history: []
  }
})

function getYtDlpPath(): string {
  const binary = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  if (app.isPackaged) return join(process.resourcesPath, 'bin', binary)
  return join(app.getAppPath(), 'bin', binary)
}

/** Writable cookies path in AppData — yt-dlp needs write access to update cookies */
function getWritableCookiesPath(): string {
  return join(app.getPath('userData'), 'cookies.txt')
}

/** Copy bundled cookies.txt to writable AppData on startup */
function ensureCookiesWritable(): void {
  const src = join(getYtDlpPath(), '..', 'cookies.txt')
  const dst = getWritableCookiesPath()
  if (!existsSync(src)) return
  try { copyFileSync(src, dst) } catch { /* ignore */ }
}

function findSystemYtDlp(): string | null {
  try {
    const result = execSync('where yt-dlp', { encoding: 'utf8', timeout: 3000 }).trim()
    const first = result.split('\n')[0].trim()
    if (first && existsSync(first)) return first
  } catch { /* not in PATH */ }
  return null
}

async function initYtDlp(): Promise<void> {
  const bundledPath = getYtDlpPath()
  const systemPath = findSystemYtDlp()
  if (systemPath) { ytDlpWrap = new YTDlpWrap(systemPath); tryUpdateYtDlp(bundledPath).catch(() => {}); return }
  if (existsSync(bundledPath)) { ytDlpWrap = new YTDlpWrap(bundledPath); tryUpdateYtDlp(bundledPath).catch(() => {}); return }
  mkdirSync(join(bundledPath, '..'), { recursive: true })
  await YTDlpWrap.downloadFromGithub(bundledPath)
  if (process.platform !== 'win32') { try { chmodSync(bundledPath, 0o755) } catch { /* ignore */ } }
  ytDlpWrap = new YTDlpWrap(bundledPath)
}

async function tryUpdateYtDlp(p: string): Promise<void> {
  if (!existsSync(p)) return
  try { execSync(`"${p}" -U`, { timeout: 30000, stdio: 'ignore' }) } catch { /* non-critical */ }
}

let ytDlpWrap: YTDlpWrap | null = null
const activeDownloads = new Map<string, { emitter: ReturnType<YTDlpWrap['exec']>; cancelled: boolean }>()
let mainWindow: BrowserWindow | null = null

/** Find Node.js path for yt-dlp JS runtime */
function findNodePath(): string | null {
  const candidates = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe']
  const found = candidates.find(p => existsSync(p))
  if (found) return found
  try { return execSync('where node', { encoding: 'utf8', timeout: 3000 }).split('\n')[0].trim() || null } catch { return null }
}

/** Build yt-dlp base args. */
function getBaseArgs(cookiesFromBrowser: string, cookiesFile?: string, url?: string): string[] {
  const explicit = cookiesFile && existsSync(cookiesFile) ? cookiesFile : null
  const writable = existsSync(getWritableCookiesPath()) ? getWritableCookiesPath() : null
  const activeCookies = explicit ?? writable

  const isTwitch  = url?.includes('twitch.tv') ?? false
  const isMusicYT = url?.includes('music.youtube.com') ?? false

  const args: string[] = [
    '--retries', '3',
    '--fragment-retries', '3',
    '--skip-unavailable-fragments',
  ]

  if (!isTwitch) {
    // YouTube Music: mweb/web_music require GVS PO Token with cookies — use ios which doesn't
    // Regular YouTube: mweb works with cookies, ios,mweb works without
    let playerClient: string
    if (isMusicYT) {
      // ios doesn't support cookies → use android_music (supports cookies, no PO Token needed)
      // without cookies ios works fine
      playerClient = activeCookies ? 'android_music' : 'ios'
    } else {
      playerClient = activeCookies ? 'mweb' : 'ios,mweb'
    }
    args.push('--extractor-args', `youtube:player_client=${playerClient}`)

    const nodePath = findNodePath()
    if (nodePath) args.push('--js-runtimes', `node:${nodePath}`)
  }

  if (activeCookies) args.push('--cookies', activeCookies)
  return args
}

function createWindow(): void {
  const iconPath = join(app.getAppPath(), 'build', 'icon.ico')
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined
  mainWindow = new BrowserWindow({
    width: 1300, height: 840, minWidth: 960, minHeight: 620,
    frame: false, backgroundColor: '#05050A', show: false, autoHideMenuBar: true, icon,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  })
  mainWindow.on('ready-to-show', () => { mainWindow?.show(); mainWindow?.focus() })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Window controls
ipcMain.on('window-minimize', () => mainWindow?.minimize())
ipcMain.on('window-maximize', () => { mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize() })
ipcMain.on('window-close', () => mainWindow?.close())

// Settings
ipcMain.handle('get-settings', () => store.get('settings'))
ipcMain.handle('save-settings', (_e, s: AppSettings) => { store.set('settings', s); return true })
ipcMain.handle('select-download-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
  return r.canceled ? null : r.filePaths[0] ?? null
})
ipcMain.handle('select-cookies-file', async () => {
  const r = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'], filters: [{ name: 'Cookies', extensions: ['txt'] }] })
  return r.canceled ? null : r.filePaths[0] ?? null
})

// App state
ipcMain.handle('get-app-state', () => store.get('appState'))
ipcMain.handle('save-app-state', (_e, patch: Partial<AppState>) => { store.set('appState', { ...store.get('appState'), ...patch }); return true })

// History
ipcMain.handle('get-history', () => store.get('history'))
ipcMain.handle('append-history', (_e, item: HistoryItem) => {
  const h = store.get('history').filter((x: HistoryItem) => x.id !== item.id)
  store.set('history', [item, ...h].slice(0, 200)); return true
})
ipcMain.handle('clear-history', () => { store.set('history', []); return true })

// yt-dlp
ipcMain.handle('check-ytdlp', () => {
  const b = getYtDlpPath(); const s = findSystemYtDlp()
  return { exists: existsSync(b) || !!s, path: existsSync(b) ? b : (s ?? '') }
})
ipcMain.handle('setup-ytdlp', async () => { try { await initYtDlp(); return { success: true } } catch (e) { return { success: false, error: String(e) } } })
ipcMain.handle('update-ytdlp', async () => {
  try {
    const p = getYtDlpPath()
    if (!existsSync(p)) return { success: false, error: 'Binary not found' }
    execSync(`"${p}" -U`, { timeout: 60000 })
    return { success: true }
  } catch (e) {
    const m = String(e)
    return (m.includes('up to date') || m.includes('already up')) ? { success: true } : { success: false, error: m }
  }
})
ipcMain.handle('detect-browser', () => null)

// Check if the persistent YouTube session already has cookies (i.e. user is logged in)
ipcMain.handle('check-yt-session', async () => {
  const ses = session.fromPartition('persist:yt-cookies')
  const cookies = await ses.cookies.get({ domain: 'youtube.com', name: 'SID' })
  return { loggedIn: cookies.length > 0 }
})

// Opens embedded YouTube window. User logs in (or is already logged in), closes — cookies saved.
ipcMain.handle('extract-browser-cookies', async () => {
  const dst = getWritableCookiesPath()
  const ses  = session.fromPartition('persist:yt-cookies')

  const loginWin = new BrowserWindow({
    width: 1080, height: 720,
    title: 'YouDownload — Sign in to YouTube, then close this window',
    autoHideMenuBar: true,
    parent: mainWindow ?? undefined,
    webPreferences: {
      session: ses,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  loginWin.loadURL('https://www.youtube.com')
  loginWin.show()

  await new Promise<void>(resolve => loginWin.on('closed', resolve))

  try {
    const yt  = await ses.cookies.get({ domain: 'youtube.com' })
    const goo = await ses.cookies.get({ domain: 'google.com' })
    const all = [...yt, ...goo]

    if (all.length === 0) return { success: false, error: 'No cookies found — make sure you signed in before closing.' }

    const lines = ['# Netscape HTTP Cookie File', '']
    for (const c of all) {
      const domain   = c.domain ?? ''
      const hostOnly = domain.startsWith('.') ? 'TRUE' : 'FALSE'
      const secure   = c.secure ? 'TRUE' : 'FALSE'
      const expiry   = c.expirationDate ? Math.floor(c.expirationDate) : 0
      lines.push(`${domain}\t${hostOnly}\t${c.path ?? '/'}\t${secure}\t${expiry}\t${c.name}\t${c.value}`)
    }
    writeFileSync(dst, lines.join('\n'), 'utf-8')
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
})

/** Strip WARNING lines from yt-dlp output, keep only the key ERROR */
function cleanYtDlpError(raw: string): string {
  const lines = raw.split('\n')
  // Prefer lines starting with ERROR:
  const errors = lines.filter(l => l.trimStart().startsWith('ERROR:'))
  if (errors.length > 0) {
    return errors.map(l => l.replace(/^.*?ERROR:\s*/, '')).join(' | ')
  }
  // Fallback: remove WARNING lines and return the rest
  const cleaned = lines.filter(l => !l.trimStart().startsWith('WARNING:')).join('\n').trim()
  return cleaned || raw
}

// Fetch video info
ipcMain.handle('fetch-video-info', async (_e, url: string) => {
  if (!ytDlpWrap) return { success: false, error: 'yt-dlp not initialized' }
  try {
    const s = store.get('settings')
    const baseArgs = getBaseArgs(s.cookiesFromBrowser, s.cookiesFile, url)
    // Чистый playlist URL (нет watch?v=) — берём первый трек через --playlist-items 1
    const isPlaylistOnly = /[?&]list=/.test(url) && !/[?&]v=/.test(url)
    const extraArgs = isPlaylistOnly
      ? ['--yes-playlist', '--playlist-items', '1']
      : ['--no-playlist']
    const info = await ytDlpWrap.getVideoInfo([url, ...extraArgs, ...baseArgs])
    return { success: true, data: info }
  } catch (e) { return { success: false, error: String(e) } }
})

// Fetch Twitch channel content (vods or clips)
ipcMain.handle('fetch-twitch-channel', async (_e, channelName: string, type: 'vods' | 'clips') => {
  const url = type === 'vods'
    ? `https://www.twitch.tv/${channelName}/videos?filter=archives&sort=time`
    : `https://www.twitch.tv/${channelName}/clips?filter=clips&range=all`
  try {
    const result = spawnSync(
      getYtDlpPath(),
      [url, '--flat-playlist', '--dump-json', '--yes-playlist', '--no-warnings'],
      { encoding: 'utf8', timeout: 30000 }
    )
    const entries = (result.stdout || '').trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
    return { success: true, entries }
  } catch (e) {
    return { success: false, error: String(e), entries: [] }
  }
})

// Fetch playlist entries (titles + ids only, fast)
ipcMain.handle('fetch-playlist-info', async (_e, url: string) => {
  if (!ytDlpWrap) return { success: false, error: 'yt-dlp not initialized' }
  try {
    const s = store.get('settings')
    const result = spawnSync(
      getYtDlpPath(),
      [url, '--flat-playlist', '--dump-json', '--yes-playlist', ...getBaseArgs(s.cookiesFromBrowser, s.cookiesFile, url)],
      { encoding: 'utf8', timeout: 30000 }
    )
    if (result.status !== 0) return { success: false, error: result.stderr?.slice(0, 300) || 'Failed' }
    const entries = result.stdout.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
    return { success: true, entries }
  } catch (e) { return { success: false, error: String(e) } }
})

// Start download
ipcMain.handle('start-download', async (event, payload: { id: string; url: string; formatArgs: string[]; downloadPath: string }) => {
  if (!ytDlpWrap) return { success: false, error: 'yt-dlp not initialized' }
  const s = store.get('settings')
  const outDir = payload.downloadPath || s.downloadPath

  // YouTube Music содержит только аудио — заменяем видео-форматы на аудио
  let formatArgs = payload.formatArgs
  if (payload.url.includes('music.youtube')) {
    const hasVideoFormat = formatArgs.some(a => a.includes('bestvideo'))
    if (hasVideoFormat) {
      formatArgs = ['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0']
    }
  }

  const args = [payload.url, ...formatArgs, ...getBaseArgs(s.cookiesFromBrowser, s.cookiesFile, payload.url),
    '-o', join(outDir, '%(title)s.%(ext)s'), '--no-playlist', '--progress', '--newline']
  try {
    const emitter = ytDlpWrap.exec(args)
    activeDownloads.set(payload.id, { emitter, cancelled: false })
    emitter.on('ytDlpEvent', (type: string, data: string) => {
      if (type === 'download') {
        const pct = data.match(/(\d+\.?\d*)%/)?.[1]
        const speed = data.match(/at\s+([\d.]+\s*\S+\/s)/)?.[1]
        const eta = data.match(/ETA\s+([\d:]+)/)?.[1]
        event.sender.send('download-progress', { id: payload.id, progress: pct ? parseFloat(pct) : 0, speed: speed ?? '', eta: eta ?? '', status: 'downloading' })
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
  } catch (e) { return { success: false, error: String(e) } }
})

// Cancel download
ipcMain.handle('cancel-download', (_e, id: string) => {
  const dl = activeDownloads.get(id)
  if (!dl) return { success: false }
  dl.cancelled = true
  const ytDlpProcess = (dl.emitter as unknown as { ytDlpProcess?: { pid?: number; kill: () => void } }).ytDlpProcess
  if (ytDlpProcess?.pid) {
    try {
      // taskkill /T убивает дерево процессов (yt-dlp + ffmpeg)
      execSync(`taskkill /pid ${ytDlpProcess.pid} /T /F`, { stdio: 'ignore' })
    } catch { /* игнорируем если уже завершён */ }
    try { ytDlpProcess.kill() } catch { /* обновляем статус объекта */ }
  }
  return { success: true }
})

ipcMain.handle('open-folder', (_e, path: string) => shell.openPath(path))

// ── Auto-updater ─────────────────────────────────────────────────────────────

const CURRENT_VERSION = app.getVersion()  // from package.json
const GITHUB_RELEASES_API = 'https://api.github.com/repos/Bzden4ik/YouDownload/releases/latest'

interface GitHubRelease {
  tag_name: string
  name: string
  body: string
  html_url: string
  assets: { name: string; browser_download_url: string; size: number }[]
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET' })
    req.setHeader('User-Agent', `YouDownload/${CURRENT_VERSION}`)
    req.setHeader('Accept', 'application/vnd.github+json')
    let body = ''
    req.on('response', res => {
      res.on('data', chunk => { body += chunk.toString() })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function compareVersions(a: string, b: string): number {
  const normalize = (v: string) => v.replace(/^v/, '').split('.').map(Number)
  const [aMaj, aMin, aPatch] = normalize(a)
  const [bMaj, bMin, bPatch] = normalize(b)
  if (aMaj !== bMaj) return bMaj - aMaj
  if (aMin !== bMin) return bMin - aMin
  return (bPatch ?? 0) - (aPatch ?? 0)
}

ipcMain.handle('check-for-updates', async () => {
  try {
    const release = await fetchJson(GITHUB_RELEASES_API) as GitHubRelease
    const latest = release.tag_name.replace(/^v/, '')
    const current = CURRENT_VERSION.replace(/^v/, '')
    const hasUpdate = compareVersions(current, latest) > 0

    if (!hasUpdate) return { hasUpdate: false, currentVersion: current, latestVersion: latest }

    // Find Windows installer asset
    const asset = release.assets.find(a =>
      a.name.toLowerCase().endsWith('.exe') && a.name.toLowerCase().includes('setup')
    )

    return {
      hasUpdate: true,
      currentVersion: current,
      latestVersion: latest,
      releaseName: release.name,
      releaseNotes: release.body,
      downloadUrl: asset?.browser_download_url ?? release.html_url,
      assetName: asset?.name ?? '',
      assetSize: asset?.size ?? 0,
    }
  } catch (err) {
    return { hasUpdate: false, error: String(err) }
  }
})

ipcMain.handle('download-and-install-update', async (event, downloadUrl: string, assetName: string) => {
  try {
    const tmpDir = app.getPath('temp')
    const installerPath = join(tmpDir, assetName || 'YouDownload-update.exe')

    // Download with progress
    await new Promise<void>((resolve, reject) => {
      const req = net.request({ url: downloadUrl, method: 'GET' })
      req.setHeader('User-Agent', `YouDownload/${CURRENT_VERSION}`)
      let received = 0
      let total = 0
      const chunks: Buffer[] = []

      req.on('response', res => {
        total = parseInt(res.headers['content-length'] as string ?? '0', 10)
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          received += chunk.length
          if (total > 0) {
            const pct = Math.round((received / total) * 100)
            event.sender.send('update-download-progress', pct)
          }
        })
        res.on('end', () => {
          writeFileSync(installerPath, Buffer.concat(chunks))
          resolve()
        })
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    })

    event.sender.send('update-download-progress', 100)

    // Launch installer and quit
    spawn(installerPath, [], { detached: true, stdio: 'ignore' }).unref()
    setTimeout(() => app.quit(), 1500)

    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

/** Save cookies from the persistent session to the writable cookies.txt */
async function saveSessionCookies(): Promise<void> {
  const ses = session.fromPartition('persist:yt-cookies')
  const yt  = await ses.cookies.get({ domain: 'youtube.com' })
  const goo = await ses.cookies.get({ domain: 'google.com' })
  const all = [...yt, ...goo]
  if (all.length === 0) return
  const lines = ['# Netscape HTTP Cookie File', '']
  for (const c of all) {
    const domain   = c.domain ?? ''
    const hostOnly = domain.startsWith('.') ? 'TRUE' : 'FALSE'
    const secure   = c.secure ? 'TRUE' : 'FALSE'
    const expiry   = c.expirationDate ? Math.floor(c.expirationDate) : 0
    lines.push(`${domain}\t${hostOnly}\t${c.path ?? '/'}\t${secure}\t${expiry}\t${c.name}\t${c.value}`)
  }
  writeFileSync(getWritableCookiesPath(), lines.join('\n'), 'utf-8')
}

/** Silently open YouTube in the background to refresh session cookies, then close. */
async function autoRefreshCookies(): Promise<void> {
  const ses = session.fromPartition('persist:yt-cookies')
  const existing = await ses.cookies.get({ domain: 'youtube.com', name: 'SID' })
  if (existing.length === 0) return // not logged in — skip

  const win = new BrowserWindow({
    width: 1, height: 1, show: false,
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true },
  })
  try {
    await Promise.race([
      new Promise<void>(resolve => win.webContents.once('did-finish-load', resolve)),
      new Promise<void>(resolve => setTimeout(resolve, 12000)),
    ])
    win.loadURL('https://www.youtube.com')
    await Promise.race([
      new Promise<void>(resolve => win.webContents.once('did-finish-load', resolve)),
      new Promise<void>(resolve => setTimeout(resolve, 12000)),
    ])
    // Give YouTube a moment to set/rotate cookies
    await new Promise(resolve => setTimeout(resolve, 2500))
    await saveSessionCookies()
  } catch { /* non-critical */ } finally {
    win.destroy()
  }
}

// App lifecycle
app.whenReady().then(async () => {
  createWindow()
  ensureCookiesWritable()
  initYtDlp().catch(() => {})
  // Auto-refresh YouTube cookies silently if user was previously signed in
  setTimeout(() => autoRefreshCookies().catch(() => {}), 3000)
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
