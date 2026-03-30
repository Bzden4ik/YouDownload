import { contextBridge, ipcRenderer } from 'electron'

const api = {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close:    () => ipcRenderer.send('window-close'),

  // Settings (electron-store)
  getSettings:          ()  => ipcRenderer.invoke('get-settings'),
  saveSettings:         (s: unknown) => ipcRenderer.invoke('save-settings', s),
  selectDownloadFolder: ()  => ipcRenderer.invoke('select-download-folder'),
  selectCookiesFile:    ()  => ipcRenderer.invoke('select-cookies-file'),

  // Persistent app state
  getAppState:  () => ipcRenderer.invoke('get-app-state'),
  saveAppState: (patch: unknown) => ipcRenderer.invoke('save-app-state', patch),

  // History
  getHistory:     () => ipcRenderer.invoke('get-history'),
  appendHistory:  (item: unknown) => ipcRenderer.invoke('append-history', item),
  clearHistory:   () => ipcRenderer.invoke('clear-history'),

  // ffmpeg
  checkFfmpeg:    () => ipcRenderer.invoke('check-ffmpeg'),
  downloadFfmpeg: () => ipcRenderer.invoke('download-ffmpeg'),
  onFfmpegDownloadProgress: (cb: (d: unknown) => void) => {
    const h = (_: Electron.IpcRendererEvent, d: unknown) => cb(d)
    ipcRenderer.on('ffmpeg-download-progress', h)
    return () => ipcRenderer.removeListener('ffmpeg-download-progress', h)
  },

  // yt-dlp
  checkYtDlp:    () => ipcRenderer.invoke('check-ytdlp'),
  setupYtDlp:    () => ipcRenderer.invoke('setup-ytdlp'),
  updateYtDlp:   () => ipcRenderer.invoke('update-ytdlp'),
  detectBrowser: () => ipcRenderer.invoke('detect-browser'),
  checkYtSession:        () => ipcRenderer.invoke('check-yt-session'),
  extractBrowserCookies: () => ipcRenderer.invoke('extract-browser-cookies'),
  checkVkSession:        () => ipcRenderer.invoke('check-vk-session'),
  extractVkCookies:      () => ipcRenderer.invoke('extract-vk-cookies'),
  checkTwitchSession:    () => ipcRenderer.invoke('check-twitch-session'),
  extractTwitchCookies:  () => ipcRenderer.invoke('extract-twitch-cookies'),
  fetchVideoInfo: (url: string) => ipcRenderer.invoke('fetch-video-info', url),
  fetchPlaylistInfo: (url: string) => ipcRenderer.invoke('fetch-playlist-info', url),
  fetchTwitchChannel: (channelName: string, type: 'vods' | 'clips', refresh?: boolean) => ipcRenderer.invoke('fetch-twitch-channel', channelName, type, refresh),
  getTwitchCacheMeta: (channelName: string) => ipcRenderer.invoke('get-twitch-cache-meta', channelName),
  setTwitchChannelPin: (channelName: string, pinned: boolean) => ipcRenderer.invoke('set-twitch-channel-pin', channelName, pinned),
  debugListFormats: (url: string) => ipcRenderer.invoke('debug-list-formats', url),
  getCookiesStale:  () => ipcRenderer.invoke('get-cookies-stale'),
  resetCookiesStale: () => ipcRenderer.invoke('reset-cookies-stale'),
  startDownload:  (p: unknown) => ipcRenderer.invoke('start-download', p),
  cancelDownload: (id: string) => ipcRenderer.invoke('cancel-download', id),
  openFolder:      (path: string) => ipcRenderer.invoke('open-folder', path),
  openExternal:    (url: string) => ipcRenderer.invoke('open-external', url),
  openTwitchChat:  (channel: string) => ipcRenderer.invoke('open-twitch-chat', channel),
  fetchTwitchFollowedLive: () => ipcRenderer.invoke('fetch-twitch-followed-live'),
  getPreviewPort:  () => ipcRenderer.invoke('get-preview-port'),

  // Updates
  checkForUpdates:         () => ipcRenderer.invoke('check-for-updates'),
  downloadAndInstallUpdate: (url: string, name: string) => ipcRenderer.invoke('download-and-install-update', url, name),
  onUpdateAvailable: (cb: (d: unknown) => void) => {
    const h = (_: Electron.IpcRendererEvent, d: unknown) => cb(d)
    ipcRenderer.on('update-available', h)
    return () => ipcRenderer.removeListener('update-available', h)
  },
  onUpdateDownloadProgress: (cb: (pct: number) => void) => {
    const h = (_: Electron.IpcRendererEvent, pct: number) => cb(pct)
    ipcRenderer.on('update-download-progress', h)
    return () => ipcRenderer.removeListener('update-download-progress', h)
  },

  onDownloadProgress: (cb: (d: unknown) => void) => {
    const handler = (_: Electron.IpcRendererEvent, d: unknown) => cb(d)
    ipcRenderer.on('download-progress', handler)
    return () => ipcRenderer.removeListener('download-progress', handler)
  },
  onDownloadComplete: (cb: (d: unknown) => void) => {
    const handler = (_: Electron.IpcRendererEvent, d: unknown) => cb(d)
    ipcRenderer.on('download-complete', handler)
    return () => ipcRenderer.removeListener('download-complete', handler)
  },
  onDownloadError: (cb: (d: unknown) => void) => {
    const handler = (_: Electron.IpcRendererEvent, d: unknown) => cb(d)
    ipcRenderer.on('download-error', handler)
    return () => ipcRenderer.removeListener('download-error', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
