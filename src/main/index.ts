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

/** Find ffmpeg binary in common locations + PATH */
function findFfmpeg(): string | null {
  const binary = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  // 1) Next to yt-dlp (bundled in the same bin/ dir)
  const binDir = join(getYtDlpPath(), '..')
  const bundled = join(binDir, binary)
  if (existsSync(bundled)) return bundled
  // 2) Common install locations on Windows
  const candidates = [
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe',
    join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    join(process.env['ProgramData'] ?? '', 'chocolatey', 'bin', 'ffmpeg.exe'),
  ]
  for (const p of candidates) { if (p && existsSync(p)) return p }
  // 3) System PATH
  try {
    const cmd = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg'
    const result = execSync(cmd, { encoding: 'utf8', timeout: 3000 }).trim()
    const first = result.split('\n')[0].trim()
    if (first && existsSync(first)) return first
  } catch { /* not in PATH */ }
  return null
}

function getYtDlpPath(): string {
  const binary = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  if (app.isPackaged) return join(process.resourcesPath, 'bin', binary)
  return join(app.getAppPath(), 'bin', binary)
}

/** Writable cookies path in AppData — yt-dlp needs write access to update cookies */
function getWritableCookiesPath(): string {
  return join(app.getPath('userData'), 'cookies.txt')
}

/** VK cookies path */
function getVkCookiesPath(): string {
  return join(app.getPath('userData'), 'vk-cookies.txt')
}

/** Normalize VK URLs: extract video ID (+ access_key) from ?z= parameter */
function normalizeVkUrl(url: string): string {
  if (!url.includes('vk.com') && !url.includes('vkvideo.ru')) return url
  try {
    const u = new URL(url)
    const z = u.searchParams.get('z')
    if (z) {
      // z=video-123456_789/accesskey  — the part after / is the private access key
      const m = z.match(/^(video-?\d+_\d+)(?:\/([a-f0-9]+))?/)
      if (m) {
        const base = `https://vk.com/${m[1]}`
        return m[2] ? `${base}?access_key=${m[2]}` : base
      }
    }
  } catch { /* ignore */ }
  return url
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

// ── Tiny local HTTP server for Twitch embed preview ──────────────────────────
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'http'

let previewServerPort = 0

function startPreviewServer(): void {
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    // Parse ?id=VIDEO_ID or ?channel=CHANNEL_NAME from URL
    const url = new URL(req.url ?? '/', `http://localhost`)
    const videoId = url.searchParams.get('id') ?? ''
    const channelName = url.searchParams.get('channel') ?? ''
    const playerConfig = channelName ? `channel: "${channelName}"` : `video: "${videoId}"`

    // For live channels: fetch real stream start time via Twitch GQL so the
    // timer always shows total stream duration (e.g. 7:48:37), not viewer session time.
    const streamTimeScript = channelName ? `
  (function() {
    function fetchStreamStart() {
      try {
        fetch('https://gql.twitch.tv/gql', {
          method: 'POST',
          headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
          body: JSON.stringify([{"query":"query{user(login:\\"${channelName}\\"){stream{createdAt}}}"}])
        }).then(function(r){ return r.json(); }).then(function(data) {
          var createdAt = data && data[0] && data[0].data && data[0].data.user
            && data[0].data.user.stream && data[0].data.user.stream.createdAt;
          if (createdAt) { window.__streamStarted = new Date(createdAt).getTime(); }
        }).catch(function(){});
      } catch(e) {}
    }
    fetchStreamStart();
    setTimeout(fetchStreamStart, 6000); // retry once
  })();
` : ''

    const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100vw; height: 100vh; overflow: hidden; background: #000; }
  #twitch-player { width: 100vw; height: 100vh; }
</style>
</head><body>
<div id="twitch-player"></div>
<script src="https://player.twitch.tv/js/embed/v1.js"></script>
<script>
  window.__streamStarted = null;

  var player = new Twitch.Player("twitch-player", {
    ${playerConfig},
    parent: ["localhost"],
    autoplay: true,
    muted: false,
    width: "100%",
    height: "100%"
  });
  window.__twitchPlayer = player;

  // Fallback: if GQL hasn't resolved yet, use getCurrentTime() on PLAYING
  // (for some streams getCurrentTime returns the real DVR position from stream start)
  player.addEventListener(Twitch.Player.PLAYING, function() {
    if (!window.__streamStarted) {
      try {
        var ct = player.getCurrentTime();
        if (typeof ct === 'number' && ct > 1) {
          window.__streamStarted = Date.now() - ct * 1000;
        }
      } catch(e) {}
    }
  });

  ${streamTimeScript}

  // Returns seconds since stream actually started (wall-clock based).
  // This is the REAL stream duration, not viewer session time.
  window.__getStreamPos = function() {
    if (window.__streamStarted) {
      return Math.floor((Date.now() - window.__streamStarted) / 1000);
    }
    try {
      var ct = player.getCurrentTime();
      return (typeof ct === 'number' && ct >= 0) ? Math.floor(ct) : -1;
    } catch(e) { return -1; }
  };

  player.addEventListener(Twitch.Player.READY, function() {
    setTimeout(function() { window.dispatchEvent(new Event('resize')); }, 300);
    setTimeout(function() { window.dispatchEvent(new Event('resize')); }, 1000);
  });
</script>
</body></html>`
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as { port: number }
    previewServerPort = addr.port
  })
}

/** Inject CSS into all Twitch player subframes to hide subscribe/follow overlays */
function injectTwitchOverrideCSS(wc: Electron.WebContents): void {
  try {
    const css = `
      /* Hide subscribe/follow/mature overlays in Twitch embed */
      .player-overlay-background,
      .recommendations-overlay,
      .content-overlay-gate,
      .click-handler ~ .channel-info-bar,
      .top-bar, .channel-info-bar,
      [data-a-target="subscribe-button__subscribe-button"],
      [data-a-target="follow-button"],
      [data-test-selector="subscribe-button__subscribe-button"],
      [data-a-target="player-overlay-mature-accept"],
      .pl-browse-native, .browse-channel-btn-container,
      .subscribe-cta, .follow-cta,
      .pl-rec-overlay,
      .player-overlay__content:not(.video-player__overlay):not(.quality-selector-menu) {
        display: none !important;
      }
    `
    for (const frame of wc.mainFrame.framesInSubtree) {
      if (frame.url?.includes('player.twitch.tv')) {
        frame.executeJavaScript(`
          (() => {
            if (document.getElementById('_yd_twitch_fix')) return;
            const s = document.createElement('style');
            s.id = '_yd_twitch_fix';
            s.textContent = ${JSON.stringify(css)};
            (document.head || document.documentElement).appendChild(s);
          })();
        `).catch(() => {})
      }
    }
  } catch { /* non-critical */ }
}

ipcMain.handle('get-preview-port', () => previewServerPort)

/** Find Node.js path for yt-dlp JS runtime */
function findNodePath(): string | null {
  const candidates = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe']
  const found = candidates.find(p => existsSync(p))
  if (found) return found
  try { return execSync('where node', { encoding: 'utf8', timeout: 3000 }).split('\n')[0].trim() || null } catch { return null }
}

/** Returns true if the error is an SSL/network transient error that can be retried */
function isSslError(raw: string): boolean {
  const l = raw.toLowerCase()
  return l.includes('eof occurred in violation of protocol') ||
    l.includes('_ssl.c') ||
    l.includes('ssl: eof') ||
    l.includes('connection reset by peer') ||
    l.includes('remotedisconnected') ||
    l.includes('broken pipe') ||
    l.includes('unable to download json metadata') && l.includes('ssl')
}

/** Returns true if cookies.txt exists but is known-invalid (rotated/expired) */
function areCookiesStale(): boolean {
  const p = getWritableCookiesPath()
  if (!existsSync(p)) return false
  // Quick probe: run yt-dlp --cookies <file> --simulate on a known-public video
  // Too slow to do here — instead we track staleness via a flag set after seeing the warning
  return _cookiesStale
}
let _cookiesStale = false

/** Call this whenever yt-dlp emits the "cookies are no longer valid" warning */
function markCookiesStale(): void {
  if (!_cookiesStale) {
    _cookiesStale = true
    console.warn('[YouDownload] Cookies marked as stale — falling back to ios client')
  }
}

/** Build yt-dlp base args. */
function getBaseArgs(cookiesFromBrowser: string, cookiesFile?: string, url?: string, forceClient?: string, sslFallback = false): string[] {
  const explicit = cookiesFile && existsSync(cookiesFile) ? cookiesFile : null
  const writable = existsSync(getWritableCookiesPath()) ? getWritableCookiesPath() : null
  // Don't use cookies if they're known-stale
  const activeCookies = areCookiesStale() ? null : (explicit ?? writable)

  const isTwitch  = url?.includes('twitch.tv') ?? false
  const isVK      = (url?.includes('vk.com') || url?.includes('vkvideo.ru')) ?? false
  const isMusicYT = url?.includes('music.youtube.com') ?? false

  // NOTE: --remote-components ejs:github removed — it requires Node.js/Deno on the
  // system and causes "No supported JavaScript runtime" warnings on clean installs.
  const args: string[] = [
    '--retries',          isTwitch ? '10' : '3',
    '--fragment-retries', isTwitch ? '10' : '3',
    '--skip-unavailable-fragments',
  ]

  // Twitch HLS: добавляем паузу между фрагментами и таймаут соединения,
  // чтобы снизить нагрузку и избежать SSL-обрывов
  if (isTwitch) {
    args.push(
      '--sleep-interval',   '1',
      '--max-sleep-interval','3',
      '--socket-timeout',   '30',
    )
  }

  // SSL fallback: при повторной попытке после SSL-ошибки отключаем проверку сертификата
  if (sslFallback) {
    args.push('--no-check-certificates')
  }

  // Automatically pass --ffmpeg-location if we can find ffmpeg
  const ffmpegPath = findFfmpeg()
  if (ffmpegPath) {
    const ffmpegDir = join(ffmpegPath, '..')
    args.push('--ffmpeg-location', ffmpegDir)
  }

  // Bundled qjs.exe for JS challenge solving (n-challenge) — self-contained, no internet needed
  const qjsPath = join(getYtDlpPath(), '..', 'qjs.exe')
  if (existsSync(qjsPath)) {
    args.push('--js-runtimes', `quickjs:${qjsPath}`)
  }

  if (!isTwitch && !isVK) {
    if (forceClient) {
      // Caller explicitly requests a specific player client (e.g. age-gate retry)
      args.push('--extractor-args', `youtube:player_client=${forceClient}`)
    } else if (isMusicYT) {
      // YouTube Music: android_music with valid cookies, ios without
      const playerClient = (activeCookies && !areCookiesStale()) ? 'android_music' : 'ios'
      args.push('--extractor-args', `youtube:player_client=${playerClient}`)
    } else if (activeCookies && !areCookiesStale()) {
      // Valid logged-in cookies → tv_embedded client (full format list, no PO Token needed)
      args.push('--extractor-args', 'youtube:player_client=tv_embedded')
    } else {
      // No cookies OR stale cookies → tv_embedded (full formats, no PO Token, no JS runtime needed)
      args.push('--extractor-args', 'youtube:player_client=tv_embedded')
    }
  }

  if (isVK) {
    const vkCookies = existsSync(getVkCookiesPath()) ? getVkCookiesPath() : null
    if (vkCookies) {
      args.push('--cookies', vkCookies)
    } else if (cookiesFromBrowser && cookiesFromBrowser !== 'none') {
      args.push('--cookies-from-browser', cookiesFromBrowser)
    }
  } else if (activeCookies) {
    args.push('--cookies', activeCookies)
  }
  return args
}

function createWindow(): void {
  const iconPath = join(app.getAppPath(), 'build', 'icon.ico')
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined
  mainWindow = new BrowserWindow({
    width: 1300, height: 840, minWidth: 960, minHeight: 620,
    frame: false, backgroundColor: '#05050A', show: false, autoHideMenuBar: true, icon,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: true, backgroundThrottling: false }
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
// ffmpeg check & download
ipcMain.handle('check-ffmpeg', () => {
  const p = findFfmpeg()
  return { exists: !!p, path: p ?? '' }
})

ipcMain.handle('download-ffmpeg', async (event) => {
  const binDir = join(getYtDlpPath(), '..')
  const ffmpegExe = join(binDir, 'ffmpeg.exe')
  const ffprobeExe = join(binDir, 'ffprobe.exe')
  try {
    mkdirSync(binDir, { recursive: true })
    // Use yt-dlp itself to download ffmpeg via winget or direct GitHub release
    // Strategy: try winget first (silent), then fall back to direct download via PowerShell
    event.sender.send('ffmpeg-download-progress', { step: 'Trying winget...' })
    try {
      execSync('winget install --id Gyan.FFmpeg -e --silent --accept-package-agreements --accept-source-agreements', { timeout: 120000, stdio: 'ignore' })
      const newPath = findFfmpeg()
      if (newPath) return { success: true, path: newPath }
    } catch { /* winget failed or not available */ }

    // Fallback: download ffmpeg-release-essentials from GitHub via PowerShell
    event.sender.send('ffmpeg-download-progress', { step: 'Downloading ffmpeg...' })
    const psScript = `
$url = 'https://github.com/GyanD/codexffmpeg/releases/download/7.1.1/ffmpeg-7.1.1-essentials_build.zip'
$tmp = "$env:TEMP\\ffmpeg_dl.zip"
$out = "$env:TEMP\\ffmpeg_unpack"
Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
Expand-Archive -Path $tmp -DestinationPath $out -Force
$exe = Get-ChildItem -Path $out -Filter 'ffmpeg.exe' -Recurse | Select-Object -First 1
Copy-Item -Path $exe.FullName -Destination '${ffmpegExe.replace(/\\/g, '\\\\')}' -Force
$probe = Get-ChildItem -Path $out -Filter 'ffprobe.exe' -Recurse | Select-Object -First 1
if ($probe) { Copy-Item -Path $probe.FullName -Destination '${ffprobeExe.replace(/\\/g, '\\\\')}' -Force }
Remove-Item $tmp -Force
Remove-Item $out -Recurse -Force
`
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/\n/g, ' ')}"`, { timeout: 300000, stdio: 'ignore' })
    if (existsSync(ffmpegExe)) return { success: true, path: ffmpegExe }
    return { success: false, error: 'ffmpeg.exe not found after download' }
  } catch (e) {
    return { success: false, error: String(e) }
  }
})

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

// Check if VK session has cookies
ipcMain.handle('check-vk-session', async () => {
  const ses = session.fromPartition('persist:vk-cookies')
  const cookies = await ses.cookies.get({ domain: 'vk.com', name: 'remixsid' })
  return { loggedIn: cookies.length > 0 }
})

// Opens embedded VK window. User logs in, closes — cookies saved to vk-cookies.txt
ipcMain.handle('extract-vk-cookies', async () => {
  const ses = session.fromPartition('persist:vk-cookies')

  const loginWin = new BrowserWindow({
    width: 1080, height: 720,
    title: 'YouDownload — Sign in to VK, then close this window',
    autoHideMenuBar: true,
    parent: mainWindow ?? undefined,
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true },
  })

  loginWin.loadURL('https://vk.com')
  loginWin.show()
  await new Promise<void>(resolve => loginWin.on('closed', resolve))

  try {
    const vk = await ses.cookies.get({ domain: 'vk.com' })
    if (vk.length === 0) return { success: false, error: 'No VK cookies found — make sure you signed in before closing.' }
    const lines = ['# Netscape HTTP Cookie File', '']
    for (const c of vk) {
      const domain   = c.domain ?? ''
      const hostOnly = domain.startsWith('.') ? 'TRUE' : 'FALSE'
      const secure   = c.secure ? 'TRUE' : 'FALSE'
      const expiry   = c.expirationDate ? Math.floor(c.expirationDate) : 0
      lines.push(`${domain}\t${hostOnly}\t${c.path ?? '/'}\t${secure}\t${expiry}\t${c.name}\t${c.value}`)
    }
    writeFileSync(getVkCookiesPath(), lines.join('\n'), 'utf-8')
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
})

// Check if Twitch session has cookies (i.e. user is logged in to Twitch chat)
ipcMain.handle('check-twitch-session', async () => {
  const ses = session.fromPartition('persist:twitch-chat')
  const cookies = await ses.cookies.get({ domain: 'twitch.tv', name: 'auth-token' })
  return { loggedIn: cookies.length > 0 }
})

// Opens Twitch login in a window using the SAME persist:twitch-chat session as the chat webview.
// After closing, the session already has the auth cookies — chat will open logged-in automatically.
ipcMain.handle('extract-twitch-cookies', async () => {
  const ses = session.fromPartition('persist:twitch-chat')

  const loginWin = new BrowserWindow({
    width: 1080, height: 720,
    title: 'YouDownload — Sign in to Twitch, then close this window',
    autoHideMenuBar: true,
    parent: mainWindow ?? undefined,
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true },
  })

  loginWin.loadURL('https://www.twitch.tv/login')
  loginWin.show()
  await new Promise<void>(resolve => loginWin.on('closed', resolve))

  const cookies = await ses.cookies.get({ domain: 'twitch.tv', name: 'auth-token' })
  if (cookies.length === 0) return { success: false, error: 'No Twitch cookies found — make sure you signed in before closing.' }
  return { success: true }
})

/** Detect ffmpeg-missing errors from yt-dlp and return a human-readable message */
function enrichFfmpegError(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower.includes('ffmpeg is not installed') || lower.includes('ffmpeg not found')) {
    return 'ffmpeg not installed. Install it: winget install ffmpeg  (then restart the app). Or place ffmpeg.exe in the same folder as yt-dlp.exe.'
  }
  return raw
}

/** Strip WARNING lines from yt-dlp output, keep only the key ERROR, truncate long output */
function cleanYtDlpError(raw: string): string {
  // SSL errors — translate to human-readable message
  if (isSslError(raw)) return 'ssl_error'

  const lines = raw.split('\n')
  // Prefer lines starting with ERROR:
  const errors = lines.filter(l => l.trimStart().startsWith('ERROR:'))
  if (errors.length > 0) {
    return errors.map(l => l.replace(/^.*?ERROR:\s*/, '')).join(' | ').slice(0, 300)
  }
  // Fallback: remove WARNING/INFO lines and return the rest, truncated
  const cleaned = lines
    .filter(l => !l.trimStart().startsWith('WARNING:') && !l.trimStart().startsWith('['))
    .join('\n').trim()
  return (cleaned || raw).slice(0, 300)
}

/** Returns true if the error is an age-gate / sign-in required error */
function isAgeGateError(raw: string): boolean {
  const l = raw.toLowerCase()
  return l.includes('sign in to confirm your age') ||
    l.includes('age-restricted') ||
    l.includes('confirm your age') ||
    l.includes('this video may be inappropriate')
}

// Fetch video info
ipcMain.handle('fetch-video-info', async (_e, rawUrl: string) => {
  if (!ytDlpWrap) return { success: false, error: 'yt-dlp not initialized' }
  const url = normalizeVkUrl(rawUrl)
  const s = store.get('settings')
  const isPlaylistOnly = /[?&]list=/.test(url) && !/[?&]v=/.test(url)
  const extraArgs = isPlaylistOnly
    ? ['--yes-playlist', '--playlist-items', '1']
    : ['--no-playlist']

  // Attempt 1: normal args
  try {
    const baseArgs = getBaseArgs(s.cookiesFromBrowser, s.cookiesFile, url)
    const fullArgs = [url, ...extraArgs, ...baseArgs]
    console.log('\n─── fetch-video-info ───────────────────────────────')
    console.log('URL:', url)
    console.log('yt-dlp path:', getYtDlpPath())
    console.log('Args:', fullArgs.join(' '))
    console.log('cookiesStale:', _cookiesStale)
    const info = await ytDlpWrap.getVideoInfo(fullArgs)
    console.log('✓ fetch-video-info OK, formats count:', (info as any)?.formats?.length ?? 'n/a')
    return { success: true, data: info }
  } catch (e) {
    const errStr = String(e)
    // Detect stale cookies warning and retry immediately with ios client
    if (errStr.includes('cookies are no longer valid') || errStr.includes('cookies have been rotated')) {
      markCookiesStale()
      console.warn('[YouDownload] Stale cookies detected — retrying with ios client (no cookies)')
      try {
        const retryArgs = getBaseArgs('none', undefined, url, 'ios')
        const retryFull = [url, ...extraArgs, ...retryArgs]
        console.log('Retry args:', retryFull.join(' '))
        const info = await ytDlpWrap.getVideoInfo(retryFull)
        console.log('✓ fetch-video-info retry OK, formats:', (info as any)?.formats?.length ?? 'n/a')
        return { success: true, data: info }
      } catch (e2) {
        console.error('✗ fetch-video-info retry ERROR:', String(e2))
        return { success: false, error: cleanYtDlpError(String(e2)) }
      }
    }
    console.error('✗ fetch-video-info ERROR (raw):\n', errStr)

    // Attempt 2: age-gate → retry with tv_embedded client (bypasses age check without cookies)
    if (isAgeGateError(errStr)) {
      try {
        const retryArgs = getBaseArgs(s.cookiesFromBrowser, s.cookiesFile, url, 'tv_embedded')
        const info = await ytDlpWrap.getVideoInfo([url, ...extraArgs, ...retryArgs])
        return { success: true, data: info }
      } catch (e2) {
        const err2 = String(e2)
        // Still blocked — user needs to sign in
        if (isAgeGateError(err2)) {
          return {
            success: false,
            error: 'age_gate', // special token — renderer shows sign-in prompt
          }
        }
        return { success: false, error: cleanYtDlpError(err2) }
      }
    }

    return { success: false, error: cleanYtDlpError(errStr) }
  }
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
ipcMain.handle('start-download', async (event, payload: { id: string; url: string; formatArgs: string[]; downloadPath: string; sectionDuration?: number }) => {
  if (!ytDlpWrap) return { success: false, error: 'yt-dlp not initialized' }
  const s = store.get('settings')
  const outDir = payload.downloadPath || s.downloadPath
  payload = { ...payload, url: normalizeVkUrl(payload.url) }

  // YouTube Music содержит только аудио — заменяем видео-форматы на аудио
  let formatArgs = payload.formatArgs
  if (payload.url.includes('music.youtube')) {
    const hasVideoFormat = formatArgs.some(a => a.includes('bestvideo'))
    if (hasVideoFormat) {
      formatArgs = ['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0']
    }
  }

  // Для HLS-стримов с --download-sections прогресс идёт по фрагментам (0→100 на каждый),
  // поэтому используем оценку прогресса по времени вместо парсинга % из вывода.
  const isSectionDownload = formatArgs.includes('--download-sections')
  let sectionTimer: ReturnType<typeof setInterval> | null = null

  // Если нужен --download-sections, проверяем ffmpeg ДО запуска
  if (isSectionDownload && !findFfmpeg()) {
    return {
      success: false,
      error: 'ffmpeg не установлен. Для скачивания отрезков требуется ffmpeg.\n' +
             'Установить: winget install ffmpeg  (затем перезапустить приложение)\n' +
             'Или поместить ffmpeg.exe в ту же папку, что и yt-dlp.exe'
    }
  }

  if (isSectionDownload) {
    const dur = payload.sectionDuration && payload.sectionDuration > 0 ? payload.sectionDuration : 300
    const startTime = Date.now()
    // Добавляем 30% запас времени — Twitch VOD скачивается примерно в реальном времени
    const expectedMs = dur * 1000 * 1.3
    console.log(`[section-timer] запущен, dur=${dur}s, expectedMs=${Math.round(expectedMs/1000)}s`)
    sectionTimer = setInterval(() => {
      const elapsed = Date.now() - startTime
      const pct = Math.min((elapsed / expectedMs) * 95, 95)
      event.sender.send('download-progress', { id: payload.id, progress: pct, speed: '', eta: '', status: 'downloading' })
    }, 800)
  }

  const buildArgs = (sslFallback: boolean) =>
    [payload.url, ...formatArgs, ...getBaseArgs(s.cookiesFromBrowser, s.cookiesFile, payload.url, undefined, sslFallback),
      '-o', join(outDir, '%(title)s.%(ext)s'), '--no-playlist', '--progress', '--newline']

  // DEBUG: log full yt-dlp args before starting download
  console.log('\n─── start-download ─────────────────────────────────')
  console.log('ID:', payload.id)
  console.log('URL:', payload.url)
  console.log('formatArgs:', formatArgs.join(' '))
  console.log('outDir:', outDir)
  console.log('Full args:', buildArgs(false).join(' '))
  console.log('ffmpeg path:', findFfmpeg() ?? 'NOT FOUND')

  /** Запускает загрузку с заданными args. Возвращает промис который резолвится при close/error. */
  const runDownload = (args: string[]): Promise<'complete' | 'ssl_error' | 'error'> =>
    new Promise(resolve => {
      const emitter = ytDlpWrap!.exec(args)
      activeDownloads.set(payload.id, { emitter, cancelled: false })

      emitter.on('ytDlpEvent', (type: string, data: string) => {
        if (type === 'download') {
          if (sectionTimer) return
          const pct = data.match(/(\d+\.?\d*)%/)?.[1]
          const speed = data.match(/at\s+([\d.]+\s*\S+\/s)/)?.[1]
          const eta = data.match(/ETA\s+([\d:]+)/)?.[1]
          event.sender.send('download-progress', { id: payload.id, progress: pct ? parseFloat(pct) : 0, speed: speed ?? '', eta: eta ?? '', status: 'downloading' })
        }
      })

      emitter.on('error', (err: Error) => {
        if (activeDownloads.get(payload.id)?.cancelled) { resolve('error'); return }
        const raw = err.message
        console.error('✗ download ERROR (raw):\n', raw)
        // Auto-detect stale cookies mid-download
        if (raw.includes('cookies are no longer valid') || raw.includes('cookies have been rotated')) {
          markCookiesStale()
        }
        if (isSslError(raw)) { resolve('ssl_error'); return }
        // Non-SSL error — report immediately
        if (sectionTimer) { clearInterval(sectionTimer); sectionTimer = null }
        let msg: string
        if (isAgeGateError(raw)) { msg = 'age_gate' }
        else { msg = enrichFfmpegError(cleanYtDlpError(raw)) }
        console.error('✗ download ERROR (cleaned):', msg)
        event.sender.send('download-error', { id: payload.id, error: msg })
        activeDownloads.delete(payload.id)
        resolve('error')
      })

      emitter.on('close', () => {
        console.log(`[yt-dlp close] id=${payload.id}, sectionTimer active=${!!sectionTimer}, cancelled=${activeDownloads.get(payload.id)?.cancelled ?? false}`)
        if (activeDownloads.get(payload.id)?.cancelled) { resolve('error'); return }
        resolve('complete')
      })
    })

  try {
    // Attempt 1 — normal args
    const result1 = await runDownload(buildArgs(false))

    if (result1 === 'complete') {
      if (sectionTimer) { clearInterval(sectionTimer); sectionTimer = null }
      event.sender.send('download-complete', { id: payload.id })
      activeDownloads.delete(payload.id)
      return { success: true }
    }

    // result1 === 'error' means cancelled or non-SSL error (already reported) — just clean up
    if (result1 === 'error') {
      if (sectionTimer) { clearInterval(sectionTimer); sectionTimer = null }
      return { success: true }
    }

    if (result1 === 'ssl_error') {
      // Notify user we're retrying
      event.sender.send('download-progress', {
        id: payload.id, progress: 0, speed: '', eta: '',
        status: 'downloading', hint: 'ssl_retry'
      })

      // Attempt 2 — SSL fallback (--no-check-certificates + higher retries)
      const result2 = await runDownload(buildArgs(true))

      if (result2 === 'complete') {
        if (sectionTimer) { clearInterval(sectionTimer); sectionTimer = null }
        event.sender.send('download-complete', { id: payload.id })
        activeDownloads.delete(payload.id)
        return { success: true }
      }

      if (result2 === 'ssl_error') {
        // Both attempts failed with SSL — report as ssl_error token
        if (sectionTimer) { clearInterval(sectionTimer); sectionTimer = null }
        event.sender.send('download-error', { id: payload.id, error: 'ssl_error' })
        activeDownloads.delete(payload.id)
      }

      // result2 === 'error': cancelled or non-SSL error already reported
      if (result2 === 'error') {
        if (sectionTimer) { clearInterval(sectionTimer); sectionTimer = null }
      }
    }

    return { success: true }
  } catch (e) { return { success: false, error: String(e) } }
})

// DEBUG: list all available formats for a URL (logs to console)
ipcMain.handle('debug-list-formats', async (_e, url: string) => {
  const { spawnSync } = await import('child_process')
  const ytPath = getYtDlpPath()
  console.log('\n─── debug-list-formats ─────────────────────────────')
  console.log('URL:', url)
  const result = spawnSync(ytPath, [url, '--list-formats', '--no-playlist'], { encoding: 'utf8', timeout: 30000 })
  console.log('STDOUT:\n', result.stdout)
  if (result.stderr) console.log('STDERR:\n', result.stderr)
  return { stdout: result.stdout, stderr: result.stderr }
})

// Cookies stale status — renderer can query and show a warning banner
ipcMain.handle('get-cookies-stale', () => _cookiesStale)
ipcMain.handle('reset-cookies-stale', () => { _cookiesStale = false; return true })

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
ipcMain.handle('open-external', (_e, url: string) => shell.openExternal(url))

// Fetch followed live streams via Twitch GQL (no Client-ID secret needed — uses public kimne78 key)
ipcMain.handle('fetch-twitch-followed-live', async () => {
  const ses = session.fromPartition('persist:twitch-chat')

  // Need auth-token for the API call
  const authCookies = await ses.cookies.get({ domain: 'twitch.tv', name: 'auth-token' })
  const authToken = authCookies[0]?.value
  if (!authToken) return { success: false, error: 'not_logged_in' }

  // Step 1: get current user login via GQL
  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'

  const gqlFetch = (body: object): Promise<any> => new Promise((resolve, reject) => {
    const req = net.request({ url: 'https://gql.twitch.tv/gql', method: 'POST' })
    req.setHeader('Content-Type', 'application/json')
    req.setHeader('Client-ID', CLIENT_ID)
    req.setHeader('Authorization', `OAuth ${authToken}`)
    let data = ''
    req.on('response', res => {
      res.on('data', c => { data += c.toString() })
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
    })
    req.on('error', reject)
    req.write(JSON.stringify(body))
    req.end()
  })

  try {
    // Get viewer's own user ID
    const meResp = await gqlFetch([{ query: 'query { currentUser { id login displayName profileImageURL(width: 70) } }' }])
    const me = meResp?.[0]?.data?.currentUser
    if (!me) return { success: false, error: 'not_logged_in' }

    // Fetch followed live streams — GQL FollowedLiveUsers
    const liveResp = await gqlFetch([{
      operationName: 'FollowedSideNav_CurrentUser',
      variables: { first: 100 },
      query: `query FollowedSideNav_CurrentUser($first: Int) {
        currentUser {
          followedLiveUsers(first: $first) {
            nodes {
              id login displayName
              profileImageURL(width: 70)
              stream {
                id title viewersCount game { name }
              }
            }
          }
        }
      }`
    }])

    const nodes = liveResp?.[0]?.data?.currentUser?.followedLiveUsers?.nodes ?? []
    const streams = nodes.map((u: any) => ({
      login: u.login,
      displayName: u.displayName,
      avatar: u.profileImageURL,
      title: u.stream?.title ?? '',
      viewers: u.stream?.viewersCount ?? 0,
      game: u.stream?.game?.name ?? '',
    }))

    return { success: true, streams, me: { login: me.login, displayName: me.displayName, avatar: me.profileImageURL } }
  } catch (e) {
    return { success: false, error: String(e) }
  }
})

// Chat window controls
let chatWindow: BrowserWindow | null = null

ipcMain.on('chat-minimize', () => chatWindow?.minimize())
ipcMain.on('chat-maximize', () => {
  if (!chatWindow) return
  if (chatWindow.isMaximized()) {
    chatWindow.unmaximize()
    chatWindow.webContents.send('chat-maximized', false)
  } else {
    chatWindow.maximize()
    chatWindow.webContents.send('chat-maximized', true)
  }
})
ipcMain.on('chat-close', () => { chatWindow?.close(); chatWindow = null })

// Open Twitch chat in a separate frameless window with custom titlebar
ipcMain.handle('open-twitch-chat', (_e, channel: string) => {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.focus()
    return
  }
  chatWindow = new BrowserWindow({
    width: 360,
    height: 720,
    minWidth: 280,
    minHeight: 400,
    title: `Chat — ${channel}`,
    backgroundColor: '#0e0e10',
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      webviewTag: true,
      session: session.fromPartition('persist:twitch-chat'),
    },
  })

  const chatHtmlPath = app.isPackaged
    ? join(process.resourcesPath, 'app.asar', 'src', 'chat.html')
    : join(app.getAppPath(), 'src', 'chat.html')
  chatWindow.loadFile(chatHtmlPath, { query: { channel } })

  chatWindow.on('maximize', () => chatWindow?.webContents.send('chat-maximized', true))
  chatWindow.on('unmaximize', () => chatWindow?.webContents.send('chat-maximized', false))
  chatWindow.on('closed', () => { chatWindow = null })
})

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

/**
 * On startup: just flush already-cached Electron session cookies to cookies.txt.
 * We do NOT open a hidden browser window — doing so triggers Google's security
 * flow and can sign users out of YouTube/Google in their system browsers.
 */
async function autoRefreshCookies(): Promise<void> {
  try {
    await saveSessionCookies()
  } catch { /* non-critical */ }
}

/** On startup: flush VK session cookies to vk-cookies.txt without opening any window. */
async function autoRefreshVkCookies(): Promise<void> {
  try {
    const ses = session.fromPartition('persist:vk-cookies')
    const existing = await ses.cookies.get({ domain: 'vk.com', name: 'remixsid' })
    if (existing.length === 0) return
    const vk = await ses.cookies.get({ domain: 'vk.com' })
    if (vk.length === 0) return
    const lines = ['# Netscape HTTP Cookie File', '']
    for (const c of vk) {
      const domain   = c.domain ?? ''
      const hostOnly = domain.startsWith('.') ? 'TRUE' : 'FALSE'
      const secure   = c.secure ? 'TRUE' : 'FALSE'
      const expiry   = c.expirationDate ? Math.floor(c.expirationDate) : 0
      lines.push(`${domain}\t${hostOnly}\t${c.path ?? '/'}\t${secure}\t${expiry}\t${c.name}\t${c.value}`)
    }
    writeFileSync(getVkCookiesPath(), lines.join('\n'), 'utf-8')
  } catch { /* non-critical */ }
}

// ── GPU / Video hardware acceleration ────────────────────────────────────────
// Без этих флагов Electron деградирует до программного декодинга при HLS 1080p60,
// что вызывает dropped frames и лаги в webview-плеере.

// Принудительно включаем GPU-растеризацию и zero-copy для видеодекодинга
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('disable-software-rasterizer')

// Windows: D3D11 — аппаратный декодер видео (DXVA2/D3D11VA)
app.commandLine.appendSwitch('use-angle', 'd3d11')
app.commandLine.appendSwitch('enable-features', [
  'D3D11VideoDecoder',          // аппаратный декодинг H.264/AVC через D3D11
  'VaapiVideoDecoder',          // fallback для Intel/AMD через VAAPI
  'PlatformHEVCDecoderSupport', // HEVC/H.265 если стрим в этом формате
  'HardwareMediaKeyHandling',
  'CanvasOopRasterization',
  'EnableDrDc',                 // Double-buffered rendering — меньше разрывов
].join(','))

// Убираем GPU-vsync ограничение — плеер не должен ждать swap'а главного окна
app.commandLine.appendSwitch('disable-gpu-vsync')

// Отдельный GPU memory buffer для video overlay — изолирует видео от UI rendering
app.commandLine.appendSwitch('enable-hardware-overlays', 'single-fullscreen,single-on-top,underlay')

// Каждое BrowserWindow получает свой renderer process — чат-окно не перехватывает GPU у плеера
app.commandLine.appendSwitch('renderer-process-limit', '100')
// Отключаем сжатие рендерер-процессов (default Electron-поведение может мешать видео)
app.commandLine.appendSwitch('disable-renderer-backgrounding')

// App lifecycle
app.whenReady().then(async () => {
  // Allow media (video/audio) permissions for the preview webview session
  session.fromPartition('persist:preview').setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'autoplay', 'fullscreen', 'mediaKeySystem']
    callback(allowed.includes(permission))
  })

  // Inject CSS into Twitch player sub-frames to hide subscribe/follow overlays
  app.on('web-contents-created', (_, wc) => {
    wc.on('did-finish-load', () => injectTwitchOverrideCSS(wc))
    wc.on('did-frame-finish-load', () => injectTwitchOverrideCSS(wc))
  })
  startPreviewServer()
  createWindow()
  ensureCookiesWritable()
  initYtDlp().catch(() => {})
  // Auto-refresh cookies silently if user was previously signed in
  setTimeout(() => { autoRefreshCookies().catch(() => {}); autoRefreshVkCookies().catch(() => {}) }, 3000)
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
