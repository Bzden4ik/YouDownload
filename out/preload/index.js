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
  // Persistent app state
  getAppState: () => electron.ipcRenderer.invoke("get-app-state"),
  saveAppState: (patch) => electron.ipcRenderer.invoke("save-app-state", patch),
  // History
  getHistory: () => electron.ipcRenderer.invoke("get-history"),
  appendHistory: (item) => electron.ipcRenderer.invoke("append-history", item),
  clearHistory: () => electron.ipcRenderer.invoke("clear-history"),
  // yt-dlp
  checkYtDlp: () => electron.ipcRenderer.invoke("check-ytdlp"),
  setupYtDlp: () => electron.ipcRenderer.invoke("setup-ytdlp"),
  fetchVideoInfo: (url) => electron.ipcRenderer.invoke("fetch-video-info", url),
  startDownload: (p) => electron.ipcRenderer.invoke("start-download", p),
  cancelDownload: (id) => electron.ipcRenderer.invoke("cancel-download", id),
  openFolder: (path) => electron.ipcRenderer.invoke("open-folder", path),
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
