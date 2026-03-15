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
      concurrentDownloads: 3,
      cookiesFromBrowser: "none",
      cookiesFile: ""
    },
    appState: {
      lang: "en",
      theme: "fleet",
      formatType: "video",
      videoQuality: "1080",
      audioQuality: "mp3_best",
      downloadPath: electron.app.getPath("downloads"),
      concurrentDownloads: 3,
      cookiesFromBrowser: "none"
    },
    history: []
  }
});
function getYtDlpPath() {
  const binary = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  if (electron.app.isPackaged) return path.join(process.resourcesPath, "bin", binary);
  return path.join(electron.app.getAppPath(), "bin", binary);
}
function getWritableCookiesPath() {
  return path.join(electron.app.getPath("userData"), "cookies.txt");
}
function ensureCookiesWritable() {
  const src = path.join(getYtDlpPath(), "..", "cookies.txt");
  const dst = getWritableCookiesPath();
  if (!fs.existsSync(src)) return;
  try {
    fs.copyFileSync(src, dst);
  } catch {
  }
}
function findSystemYtDlp() {
  try {
    const result = child_process.execSync("where yt-dlp", { encoding: "utf8", timeout: 3e3 }).trim();
    const first = result.split("\n")[0].trim();
    if (first && fs.existsSync(first)) return first;
  } catch {
  }
  return null;
}
async function initYtDlp() {
  const bundledPath = getYtDlpPath();
  const systemPath = findSystemYtDlp();
  if (systemPath) {
    ytDlpWrap = new YTDlpWrap(systemPath);
    tryUpdateYtDlp(bundledPath).catch(() => {
    });
    return;
  }
  if (fs.existsSync(bundledPath)) {
    ytDlpWrap = new YTDlpWrap(bundledPath);
    tryUpdateYtDlp(bundledPath).catch(() => {
    });
    return;
  }
  fs.mkdirSync(path.join(bundledPath, ".."), { recursive: true });
  await YTDlpWrap.downloadFromGithub(bundledPath);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(bundledPath, 493);
    } catch {
    }
  }
  ytDlpWrap = new YTDlpWrap(bundledPath);
}
async function tryUpdateYtDlp(p) {
  if (!fs.existsSync(p)) return;
  try {
    child_process.execSync(`"${p}" -U`, { timeout: 3e4, stdio: "ignore" });
  } catch {
  }
}
let ytDlpWrap = null;
const activeDownloads = /* @__PURE__ */ new Map();
let mainWindow = null;
function findNodePath() {
  const candidates = ["C:\\Program Files\\nodejs\\node.exe", "C:\\Program Files (x86)\\nodejs\\node.exe"];
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) return found;
  try {
    return child_process.execSync("where node", { encoding: "utf8", timeout: 3e3 }).split("\n")[0].trim() || null;
  } catch {
    return null;
  }
}
function getBaseArgs(cookiesFromBrowser, cookiesFile, url) {
  const explicit = cookiesFile && fs.existsSync(cookiesFile) ? cookiesFile : null;
  const writable = fs.existsSync(getWritableCookiesPath()) ? getWritableCookiesPath() : null;
  const activeCookies = explicit ?? writable;
  const playerClient = "android_vr";
  const args = [
    "--extractor-args",
    `youtube:player_client=${playerClient}`,
    "--retries",
    "5",
    "--fragment-retries",
    "5",
    "--skip-unavailable-fragments"
  ];
  const nodePath = findNodePath();
  if (nodePath) args.push("--js-runtimes", `node:${nodePath}`);
  if (activeCookies) {
    args.push("--cookies", activeCookies);
  }
  return args;
}
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
    webPreferences: { preload: path.join(__dirname, "../preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: false }
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
  const r = await electron.dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0] ?? null;
});
electron.ipcMain.handle("select-cookies-file", async () => {
  const r = await electron.dialog.showOpenDialog(mainWindow, { properties: ["openFile"], filters: [{ name: "Cookies", extensions: ["txt"] }] });
  return r.canceled ? null : r.filePaths[0] ?? null;
});
electron.ipcMain.handle("get-app-state", () => store.get("appState"));
electron.ipcMain.handle("save-app-state", (_e, patch) => {
  store.set("appState", { ...store.get("appState"), ...patch });
  return true;
});
electron.ipcMain.handle("get-history", () => store.get("history"));
electron.ipcMain.handle("append-history", (_e, item) => {
  const h = store.get("history").filter((x) => x.id !== item.id);
  store.set("history", [item, ...h].slice(0, 200));
  return true;
});
electron.ipcMain.handle("clear-history", () => {
  store.set("history", []);
  return true;
});
electron.ipcMain.handle("check-ytdlp", () => {
  const b = getYtDlpPath();
  const s = findSystemYtDlp();
  return { exists: fs.existsSync(b) || !!s, path: fs.existsSync(b) ? b : s ?? "" };
});
electron.ipcMain.handle("setup-ytdlp", async () => {
  try {
    await initYtDlp();
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
});
electron.ipcMain.handle("update-ytdlp", async () => {
  try {
    const p = getYtDlpPath();
    if (!fs.existsSync(p)) return { success: false, error: "Binary not found" };
    child_process.execSync(`"${p}" -U`, { timeout: 6e4 });
    return { success: true };
  } catch (e) {
    const m = String(e);
    return m.includes("up to date") || m.includes("already up") ? { success: true } : { success: false, error: m };
  }
});
electron.ipcMain.handle("detect-browser", () => null);
electron.ipcMain.handle("check-yt-session", async () => {
  const ses = electron.session.fromPartition("persist:yt-cookies");
  const cookies = await ses.cookies.get({ domain: "youtube.com", name: "SID" });
  return { loggedIn: cookies.length > 0 };
});
electron.ipcMain.handle("extract-browser-cookies", async () => {
  const dst = getWritableCookiesPath();
  const ses = electron.session.fromPartition("persist:yt-cookies");
  const loginWin = new electron.BrowserWindow({
    width: 1080,
    height: 720,
    title: "YouDownload — Sign in to YouTube, then close this window",
    autoHideMenuBar: true,
    parent: mainWindow ?? void 0,
    webPreferences: {
      session: ses,
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  loginWin.loadURL("https://www.youtube.com");
  loginWin.show();
  await new Promise((resolve) => loginWin.on("closed", resolve));
  try {
    const yt = await ses.cookies.get({ domain: "youtube.com" });
    const goo = await ses.cookies.get({ domain: "google.com" });
    const all = [...yt, ...goo];
    if (all.length === 0) return { success: false, error: "No cookies found — make sure you signed in before closing." };
    const lines = ["# Netscape HTTP Cookie File", ""];
    for (const c of all) {
      const domain = c.domain ?? "";
      const hostOnly = domain.startsWith(".") ? "TRUE" : "FALSE";
      const secure = c.secure ? "TRUE" : "FALSE";
      const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0;
      lines.push(`${domain}	${hostOnly}	${c.path ?? "/"}	${secure}	${expiry}	${c.name}	${c.value}`);
    }
    fs.writeFileSync(dst, lines.join("\n"), "utf-8");
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
});
electron.ipcMain.handle("fetch-video-info", async (_e, url) => {
  if (!ytDlpWrap) return { success: false, error: "yt-dlp not initialized" };
  try {
    const s = store.get("settings");
    const baseArgs = getBaseArgs(s.cookiesFromBrowser, s.cookiesFile, url);
    const isPlaylistOnly = /[?&]list=/.test(url) && !/[?&]v=/.test(url);
    const extraArgs = isPlaylistOnly ? ["--yes-playlist", "--playlist-items", "1"] : ["--no-playlist"];
    const info = await ytDlpWrap.getVideoInfo([url, ...extraArgs, ...baseArgs]);
    return { success: true, data: info };
  } catch (e) {
    return { success: false, error: String(e) };
  }
});
electron.ipcMain.handle("fetch-playlist-info", async (_e, url) => {
  if (!ytDlpWrap) return { success: false, error: "yt-dlp not initialized" };
  try {
    const s = store.get("settings");
    const result = child_process.spawnSync(
      getYtDlpPath(),
      [url, "--flat-playlist", "--dump-json", "--yes-playlist", ...getBaseArgs(s.cookiesFromBrowser, s.cookiesFile, url)],
      { encoding: "utf8", timeout: 3e4 }
    );
    if (result.status !== 0) return { success: false, error: result.stderr?.slice(0, 300) || "Failed" };
    const entries = result.stdout.trim().split("\n").filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
    return { success: true, entries };
  } catch (e) {
    return { success: false, error: String(e) };
  }
});
electron.ipcMain.handle("start-download", async (event, payload) => {
  if (!ytDlpWrap) return { success: false, error: "yt-dlp not initialized" };
  const s = store.get("settings");
  const outDir = payload.downloadPath || s.downloadPath;
  let formatArgs = payload.formatArgs;
  if (payload.url.includes("music.youtube")) {
    const hasVideoFormat = formatArgs.some((a) => a.includes("bestvideo"));
    if (hasVideoFormat) {
      formatArgs = ["-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "0"];
    }
  }
  const args = [
    payload.url,
    ...formatArgs,
    ...getBaseArgs(s.cookiesFromBrowser, s.cookiesFile, payload.url),
    "-o",
    path.join(outDir, "%(title)s.%(ext)s"),
    "--no-playlist",
    "--progress",
    "--newline"
  ];
  try {
    const emitter = ytDlpWrap.exec(args);
    activeDownloads.set(payload.id, { emitter, cancelled: false });
    emitter.on("ytDlpEvent", (type, data) => {
      if (type === "download") {
        const pct = data.match(/(\d+\.?\d*)%/)?.[1];
        const speed = data.match(/at\s+([\d.]+\s*\S+\/s)/)?.[1];
        const eta = data.match(/ETA\s+([\d:]+)/)?.[1];
        event.sender.send("download-progress", { id: payload.id, progress: pct ? parseFloat(pct) : 0, speed: speed ?? "", eta: eta ?? "", status: "downloading" });
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
  } catch (e) {
    return { success: false, error: String(e) };
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
  ensureCookiesWritable();
  initYtDlp().catch(() => {
  });
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
