"use strict";
const electron = require("electron");
const api = {
  minimize: () => electron.ipcRenderer.send("window-minimize"),
  maximize: () => electron.ipcRenderer.send("window-maximize"),
  close: () => electron.ipcRenderer.send("window-close"),
  // Settings (electron-store)
  getSettings: () => electron.ipcRenderer.invoke("get-settings"),
  saveSettings: (s) => electron.ipcRenderer.invoke("save-settings", s),
  selectDownloadFolder: () => electron.ipcRenderer.invoke("select-download-folder"),
  selectCookiesFile: () => electron.ipcRenderer.invoke("select-cookies-file"),
  // Persistent app state
  getAppState: () => electron.ipcRenderer.invoke("get-app-state"),
  saveAppState: (patch) => electron.ipcRenderer.invoke("save-app-state", patch),
  // History
  getHistory: () => electron.ipcRenderer.invoke("get-history"),
  appendHistory: (item) => electron.ipcRenderer.invoke("append-history", item),
  clearHistory: () => electron.ipcRenderer.invoke("clear-history"),
  // ffmpeg
  checkFfmpeg: () => electron.ipcRenderer.invoke("check-ffmpeg"),
  downloadFfmpeg: () => electron.ipcRenderer.invoke("download-ffmpeg"),
  onFfmpegDownloadProgress: (cb) => {
    const h = (_, d) => cb(d);
    electron.ipcRenderer.on("ffmpeg-download-progress", h);
    return () => electron.ipcRenderer.removeListener("ffmpeg-download-progress", h);
  },
  // yt-dlp
  checkYtDlp: () => electron.ipcRenderer.invoke("check-ytdlp"),
  setupYtDlp: () => electron.ipcRenderer.invoke("setup-ytdlp"),
  updateYtDlp: () => electron.ipcRenderer.invoke("update-ytdlp"),
  detectBrowser: () => electron.ipcRenderer.invoke("detect-browser"),
  checkYtSession: () => electron.ipcRenderer.invoke("check-yt-session"),
  extractBrowserCookies: () => electron.ipcRenderer.invoke("extract-browser-cookies"),
  checkVkSession: () => electron.ipcRenderer.invoke("check-vk-session"),
  extractVkCookies: () => electron.ipcRenderer.invoke("extract-vk-cookies"),
  fetchVideoInfo: (url) => electron.ipcRenderer.invoke("fetch-video-info", url),
  fetchPlaylistInfo: (url) => electron.ipcRenderer.invoke("fetch-playlist-info", url),
  fetchTwitchChannel: (channelName, type) => electron.ipcRenderer.invoke("fetch-twitch-channel", channelName, type),
  startDownload: (p) => electron.ipcRenderer.invoke("start-download", p),
  cancelDownload: (id) => electron.ipcRenderer.invoke("cancel-download", id),
  openFolder: (path) => electron.ipcRenderer.invoke("open-folder", path),
  openExternal: (url) => electron.ipcRenderer.invoke("open-external", url),
  getPreviewPort: () => electron.ipcRenderer.invoke("get-preview-port"),
  // Updates
  checkForUpdates: () => electron.ipcRenderer.invoke("check-for-updates"),
  downloadAndInstallUpdate: (url, name) => electron.ipcRenderer.invoke("download-and-install-update", url, name),
  onUpdateAvailable: (cb) => {
    const h = (_, d) => cb(d);
    electron.ipcRenderer.on("update-available", h);
    return () => electron.ipcRenderer.removeListener("update-available", h);
  },
  onUpdateDownloadProgress: (cb) => {
    const h = (_, pct) => cb(pct);
    electron.ipcRenderer.on("update-download-progress", h);
    return () => electron.ipcRenderer.removeListener("update-download-progress", h);
  },
  onDownloadProgress: (cb) => {
    const handler = (_, d) => cb(d);
    electron.ipcRenderer.on("download-progress", handler);
    return () => electron.ipcRenderer.removeListener("download-progress", handler);
  },
  onDownloadComplete: (cb) => {
    const handler = (_, d) => cb(d);
    electron.ipcRenderer.on("download-complete", handler);
    return () => electron.ipcRenderer.removeListener("download-complete", handler);
  },
  onDownloadError: (cb) => {
    const handler = (_, d) => cb(d);
    electron.ipcRenderer.on("download-error", handler);
    return () => electron.ipcRenderer.removeListener("download-error", handler);
  }
};
electron.contextBridge.exposeInMainWorld("api", api);
