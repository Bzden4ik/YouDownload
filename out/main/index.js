"use strict";
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const child_process = require("child_process");
const Store = require("electron-store");
const YTDlpWrapLib = require("yt-dlp-wrap");
const YTDlpWrap = YTDlpWrapLib.default ?? YTDlpWrapLib;
const store = new Store({
  defaults: {
    settings: {
      downloadPath: electron.app.getPath("downloads"),
      defaultFormat: "mp4",
      defaultQuality: "1080",
      concurrentDownloads: 3
    },
    appState: {
      lang: "en",
      theme: "fleet",
      formatType: "video",
      videoQuality: "1080",
      audioQuality: "mp3_best",
      downloadPath: electron.app.getPath("downloads"),
      concurrentDownloads: 3
    },
    history: []
  }
});
function getYtDlpPath() {
  const binary = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  if (electron.app.isPackaged) {
    return path.join(process.resourcesPath, "bin", binary);
  }
  return path.join(electron.app.getAppPath(), "bin", binary);
}
function findSystemYtDlp() {
  try {
    const cmd = process.platform === "win32" ? "where yt-dlp" : "which yt-dlp";
    const result = child_process.execSync(cmd, { encoding: "utf8", timeout: 3e3 }).trim();
    const firstLine = result.split("\n")[0].trim();
    if (firstLine && fs.existsSync(firstLine)) return firstLine;
  } catch {
  }
  return null;
}
async function initYtDlp() {
  const bundledPath = getYtDlpPath();
  if (fs.existsSync(bundledPath)) {
    ytDlpWrap = new YTDlpWrap(bundledPath);
    return;
  }
  const systemPath = findSystemYtDlp();
  if (systemPath) {
    ytDlpWrap = new YTDlpWrap(systemPath);
    return;
  }
  const binDir = path.join(bundledPath, "..");
  fs.mkdirSync(binDir, { recursive: true });
  await YTDlpWrap.downloadFromGithub(bundledPath);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(bundledPath, 493);
    } catch {
    }
  }
  ytDlpWrap = new YTDlpWrap(bundledPath);
}
let ytDlpWrap = null;
const activeDownloads = /* @__PURE__ */ new Map();
let mainWindow = null;
function createWindow() {
  const iconPath = path.join(electron.app.getAppPath(), "build", "icon.ico");
  const icon = fs.existsSync(iconPath) ? electron.nativeImage.createFromPath(iconPath) : void 0;
  mainWindow = new electron.BrowserWindow({
    width: 1300,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    backgroundColor: "#05050A",
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    electron.shell.openExternal(url);
    return { action: "deny" };
  });
  if (!electron.app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
electron.ipcMain.on("window-minimize", () => mainWindow?.minimize());
electron.ipcMain.on("window-maximize", () => {
  mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize();
});
electron.ipcMain.on("window-close", () => mainWindow?.close());
electron.ipcMain.handle("get-settings", () => store.get("settings"));
electron.ipcMain.handle("save-settings", (_e, s) => {
  store.set("settings", s);
  return true;
});
electron.ipcMain.handle("select-download-folder", async () => {
  const result = await electron.dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  return result.canceled ? null : result.filePaths[0] ?? null;
});
electron.ipcMain.handle("get-app-state", () => store.get("appState"));
electron.ipcMain.handle("save-app-state", (_e, patch) => {
  const current = store.get("appState");
  store.set("appState", { ...current, ...patch });
  return true;
});
electron.ipcMain.handle("get-history", () => store.get("history"));
electron.ipcMain.handle("append-history", (_e, item) => {
  const history = store.get("history");
  const filtered = history.filter((h) => h.id !== item.id);
  store.set("history", [item, ...filtered].slice(0, 200));
  return true;
});
electron.ipcMain.handle("clear-history", () => {
  store.set("history", []);
  return true;
});
electron.ipcMain.handle("check-ytdlp", () => {
  const bundled = getYtDlpPath();
  const system = findSystemYtDlp();
  const exists = fs.existsSync(bundled) || !!system;
  return { exists, path: fs.existsSync(bundled) ? bundled : system ?? "" };
});
electron.ipcMain.handle("setup-ytdlp", async () => {
  try {
    await initYtDlp();
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});
electron.ipcMain.handle("fetch-video-info", async (_e, url) => {
  if (!ytDlpWrap) return { success: false, error: "yt-dlp not initialized" };
  try {
    const info = await ytDlpWrap.getVideoInfo([url, "--no-playlist"]);
    return { success: true, data: info };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});
electron.ipcMain.handle("start-download", async (event, payload) => {
  if (!ytDlpWrap) return { success: false, error: "yt-dlp not initialized" };
  const settings = store.get("settings");
  const outDir = payload.downloadPath || settings.downloadPath;
  const args = [
    payload.url,
    ...payload.formatArgs,
    "-o",
    path.join(outDir, "%(title)s.%(ext)s"),
    "--no-playlist",
    "--progress",
    "--newline"
  ];
  try {
    const emitter = ytDlpWrap.exec(args);
    activeDownloads.set(payload.id, { emitter, cancelled: false });
    emitter.on("ytDlpEvent", (eventType, eventData) => {
      if (eventType === "download") {
        const pct = eventData.match(/(\d+\.?\d*)%/)?.[1];
        const speed = eventData.match(/at\s+([\d.]+\s*\S+\/s)/)?.[1];
        const eta = eventData.match(/ETA\s+([\d:]+)/)?.[1];
        event.sender.send("download-progress", {
          id: payload.id,
          progress: pct ? parseFloat(pct) : 0,
          speed: speed ?? "",
          eta: eta ?? "",
          status: "downloading"
        });
      }
    });
    emitter.on("error", (err) => {
      const dl = activeDownloads.get(payload.id);
      if (!dl?.cancelled) event.sender.send("download-error", { id: payload.id, error: err.message });
      activeDownloads.delete(payload.id);
    });
    emitter.on("close", () => {
      const dl = activeDownloads.get(payload.id);
      if (!dl?.cancelled) event.sender.send("download-complete", { id: payload.id });
      activeDownloads.delete(payload.id);
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});
electron.ipcMain.handle("cancel-download", (_e, id) => {
  const dl = activeDownloads.get(id);
  if (!dl) return { success: false };
  dl.cancelled = true;
  try {
    dl.emitter.kill();
  } catch {
  }
  activeDownloads.delete(id);
  return { success: true };
});
electron.ipcMain.handle("open-folder", (_e, path2) => electron.shell.openPath(path2));
electron.app.whenReady().then(async () => {
  createWindow();
  initYtDlp().catch(() => {
  });
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
