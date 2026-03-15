import { contextBridge, ipcRenderer } from 'electron'

const api = {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close:    () => ipcRenderer.send('window-close'),

  // Settings (electron-store)
  getSettings:          ()  => ipcRenderer.invoke('get-settings'),
  saveSettings:         (s: unknown) => ipcRenderer.invoke('save-settings', s),
  selectDownloadFolder: ()  => ipcRenderer.invoke('select-download-folder'),

  // Persistent app state
  getAppState:  () => ipcRenderer.invoke('get-app-state'),
  saveAppState: (patch: unknown) => ipcRenderer.invoke('save-app-state', patch),

  // History
  getHistory:     () => ipcRenderer.invoke('get-history'),
  appendHistory:  (item: unknown) => ipcRenderer.invoke('append-history', item),
  clearHistory:   () => ipcRenderer.invoke('clear-history'),

  // yt-dlp
  checkYtDlp:    () => ipcRenderer.invoke('check-ytdlp'),
  setupYtDlp:    () => ipcRenderer.invoke('setup-ytdlp'),
  fetchVideoInfo: (url: string) => ipcRenderer.invoke('fetch-video-info', url),
  startDownload:  (p: unknown) => ipcRenderer.invoke('start-download', p),
  cancelDownload: (id: string) => ipcRenderer.invoke('cancel-download', id),
  openFolder:     (path: string) => ipcRenderer.invoke('open-folder', path),

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
