"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const child_process = require("child_process");
const Store = require("electron-store");
const YTDlpWrapLib = require("yt-dlp-wrap");
const http = require("http");
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
    history: [],
    twitchCache: {}
  }
});
function findFfmpeg() {
  const binary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const binDir = path.join(getYtDlpPath(), "..");
  const bundled = path.join(binDir, binary);
  if (fs.existsSync(bundled)) return bundled;
  const candidates = [
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe",
    path.join(process.env["LOCALAPPDATA"] ?? "", "Programs", "ffmpeg", "bin", "ffmpeg.exe"),
    path.join(process.env["ProgramData"] ?? "", "chocolatey", "bin", "ffmpeg.exe")
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  try {
    const cmd = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
    const result = child_process.execSync(cmd, { encoding: "utf8", timeout: 3e3 }).trim();
    const first = result.split("\n")[0].trim();
    if (first && fs.existsSync(first)) return first;
  } catch {
  }
  return null;
}
function getYtDlpPath() {
  const binary = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  if (electron.app.isPackaged) return path.join(process.resourcesPath, "bin", binary);
  return path.join(electron.app.getAppPath(), "bin", binary);
}
function getWritableCookiesPath() {
  return path.join(electron.app.getPath("userData"), "cookies.txt");
}
function getVkCookiesPath() {
  return path.join(electron.app.getPath("userData"), "vk-cookies.txt");
}
function normalizeVkUrl(url) {
  if (!url.includes("vk.com") && !url.includes("vkvideo.ru")) return url;
  try {
    const u = new URL(url);
    const z = u.searchParams.get("z");
    if (z) {
      const m = z.match(/^(video-?\d+_\d+)(?:\/([a-f0-9]+))?/);
      if (m) {
        const base = `https://vk.com/${m[1]}`;
        return m[2] ? `${base}?access_key=${m[2]}` : base;
      }
    }
  } catch {
  }
  return url;
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
let previewServerPort = 0;
function startPreviewServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);
    const ytVideoId = url.searchParams.get("yt") ?? "";
    const videoId = url.searchParams.get("id") ?? "";
    const channelName = url.searchParams.get("channel") ?? "";
    if (ytVideoId) {
      const html2 = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100vw; height: 100vh; overflow: hidden; background: #000; }
  #yt-player { width: 100vw; height: 100vh; }
</style>
</head><body>
<div id="yt-player"></div>
<script>
  var tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);

  var player;
  window.onYouTubeIframeAPIReady = function() {
    player = new YT.Player('yt-player', {
      videoId: '${ytVideoId}',
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: 1,
        rel: 0,
        modestbranding: 1,
        iv_load_policy: 3,
        origin: 'http://localhost'
      },
      events: {
        onReady: function(e) { e.target.playVideo(); }
      }
    });
    window.__ytPlayer = player;
  };

  // API helpers for webview executeJavaScript
  window.__ytGetTime = function() {
    try { return Math.floor(player.getCurrentTime()); } catch(e) { return -1; }
  };
  window.__ytSeek = function(s) {
    try { player.seekTo(s, true); } catch(e) {}
  };
  window.__ytPlay = function() {
    try { player.playVideo(); } catch(e) {}
  };
  window.__ytPause = function() {
    try { player.pauseVideo(); } catch(e) {}
  };
  window.__ytIsPlaying = function() {
    try { return player.getPlayerState() === 1; } catch(e) { return false; }
  };
<\/script>
</body></html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html2);
      return;
    }
    const playerConfig = channelName ? `channel: "${channelName}"` : `video: "${videoId}"`;
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
` : "";
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
<script src="https://player.twitch.tv/js/embed/v1.js"><\/script>
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
<\/script>
</body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    previewServerPort = addr.port;
  });
}
function injectTwitchOverrideCSS(wc) {
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
    `;
    for (const frame of wc.mainFrame.framesInSubtree) {
      if (frame.url?.includes("player.twitch.tv")) {
        frame.executeJavaScript(`
          (() => {
            if (document.getElementById('_yd_twitch_fix')) return;
            const s = document.createElement('style');
            s.id = '_yd_twitch_fix';
            s.textContent = ${JSON.stringify(css)};
            (document.head || document.documentElement).appendChild(s);
          })();
        `).catch(() => {
        });
      }
    }
  } catch {
  }
}
electron.ipcMain.handle("get-preview-port", () => previewServerPort);
function isSslError(raw) {
  const l = raw.toLowerCase();
  return l.includes("eof occurred in violation of protocol") || l.includes("_ssl.c") || l.includes("ssl: eof") || l.includes("connection reset by peer") || l.includes("remotedisconnected") || l.includes("broken pipe") || l.includes("unable to download json metadata") && l.includes("ssl");
}
function areCookiesStale() {
  const p = getWritableCookiesPath();
  if (!fs.existsSync(p)) return false;
  return _cookiesStale;
}
let _cookiesStale = false;
function markCookiesStale() {
  if (!_cookiesStale) {
    _cookiesStale = true;
    console.warn("[YouDownload] Cookies marked as stale — falling back to ios client");
  }
}
function getBaseArgs(cookiesFromBrowser, cookiesFile, url, forceClient, sslFallback = false) {
  const explicit = cookiesFile && fs.existsSync(cookiesFile) ? cookiesFile : null;
  const writable = fs.existsSync(getWritableCookiesPath()) ? getWritableCookiesPath() : null;
  const activeCookies = areCookiesStale() ? null : explicit ?? writable;
  const isTwitch = url?.includes("twitch.tv") ?? false;
  const isVK = (url?.includes("vk.com") || url?.includes("vkvideo.ru")) ?? false;
  const isMusicYT = url?.includes("music.youtube.com") ?? false;
  const args = [
    "--retries",
    isTwitch ? "10" : "3",
    "--fragment-retries",
    isTwitch ? "10" : "3",
    "--skip-unavailable-fragments"
  ];
  if (isTwitch) {
    args.push(
      "--sleep-interval",
      "1",
      "--max-sleep-interval",
      "3",
      "--socket-timeout",
      "30"
    );
  }
  if (sslFallback) {
    args.push("--no-check-certificates");
  }
  const ffmpegPath = findFfmpeg();
  if (ffmpegPath) {
    const ffmpegDir = path.join(ffmpegPath, "..");
    args.push("--ffmpeg-location", ffmpegDir);
  }
  const qjsPath = path.join(getYtDlpPath(), "..", "qjs.exe");
  if (fs.existsSync(qjsPath)) {
    args.push("--js-runtimes", `quickjs:${qjsPath}`);
  }
  if (!isTwitch && !isVK) {
    if (forceClient) {
      args.push("--extractor-args", `youtube:player_client=${forceClient}`);
    } else if (isMusicYT) {
      const playerClient = activeCookies && !areCookiesStale() ? "android_music" : "ios";
      args.push("--extractor-args", `youtube:player_client=${playerClient}`);
    } else if (activeCookies && !areCookiesStale()) {
      args.push("--extractor-args", "youtube:player_client=tv_embedded");
    } else {
      args.push("--extractor-args", "youtube:player_client=tv_embedded");
    }
  }
  if (isVK) {
    const vkCookies = fs.existsSync(getVkCookiesPath()) ? getVkCookiesPath() : null;
    if (vkCookies) {
      args.push("--cookies", vkCookies);
    } else if (cookiesFromBrowser && cookiesFromBrowser !== "none") {
      args.push("--cookies-from-browser", cookiesFromBrowser);
    }
  } else if (activeCookies) {
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
    webPreferences: { preload: path.join(__dirname, "../preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: true, backgroundThrottling: false }
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
electron.ipcMain.handle("check-ffmpeg", () => {
  const p = findFfmpeg();
  return { exists: !!p, path: p ?? "" };
});
electron.ipcMain.handle("download-ffmpeg", async (event) => {
  const binDir = path.join(getYtDlpPath(), "..");
  const ffmpegExe = path.join(binDir, "ffmpeg.exe");
  const ffprobeExe = path.join(binDir, "ffprobe.exe");
  try {
    fs.mkdirSync(binDir, { recursive: true });
    event.sender.send("ffmpeg-download-progress", { step: "Trying winget..." });
    try {
      child_process.execSync("winget install --id Gyan.FFmpeg -e --silent --accept-package-agreements --accept-source-agreements", { timeout: 12e4, stdio: "ignore" });
      const newPath = findFfmpeg();
      if (newPath) return { success: true, path: newPath };
    } catch {
    }
    event.sender.send("ffmpeg-download-progress", { step: "Downloading ffmpeg..." });
    const psScript = `
$url = 'https://github.com/GyanD/codexffmpeg/releases/download/7.1.1/ffmpeg-7.1.1-essentials_build.zip'
$tmp = "$env:TEMP\\ffmpeg_dl.zip"
$out = "$env:TEMP\\ffmpeg_unpack"
Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
Expand-Archive -Path $tmp -DestinationPath $out -Force
$exe = Get-ChildItem -Path $out -Filter 'ffmpeg.exe' -Recurse | Select-Object -First 1
Copy-Item -Path $exe.FullName -Destination '${ffmpegExe.replace(/\\/g, "\\\\")}' -Force
$probe = Get-ChildItem -Path $out -Filter 'ffprobe.exe' -Recurse | Select-Object -First 1
if ($probe) { Copy-Item -Path $probe.FullName -Destination '${ffprobeExe.replace(/\\/g, "\\\\")}' -Force }
Remove-Item $tmp -Force
Remove-Item $out -Recurse -Force
`;
    child_process.execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/\n/g, " ")}"`, { timeout: 3e5, stdio: "ignore" });
    if (fs.existsSync(ffmpegExe)) return { success: true, path: ffmpegExe };
    return { success: false, error: "ffmpeg.exe not found after download" };
  } catch (e) {
    return { success: false, error: String(e) };
  }
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
electron.ipcMain.handle("check-vk-session", async () => {
  const ses = electron.session.fromPartition("persist:vk-cookies");
  const cookies = await ses.cookies.get({ domain: "vk.com", name: "remixsid" });
  return { loggedIn: cookies.length > 0 };
});
electron.ipcMain.handle("extract-vk-cookies", async () => {
  const ses = electron.session.fromPartition("persist:vk-cookies");
  const loginWin = new electron.BrowserWindow({
    width: 1080,
    height: 720,
    title: "YouDownload — Sign in to VK, then close this window",
    autoHideMenuBar: true,
    parent: mainWindow ?? void 0,
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true }
  });
  loginWin.loadURL("https://vk.com");
  loginWin.show();
  await new Promise((resolve) => loginWin.on("closed", resolve));
  try {
    const vk = await ses.cookies.get({ domain: "vk.com" });
    if (vk.length === 0) return { success: false, error: "No VK cookies found — make sure you signed in before closing." };
    const lines = ["# Netscape HTTP Cookie File", ""];
    for (const c of vk) {
      const domain = c.domain ?? "";
      const hostOnly = domain.startsWith(".") ? "TRUE" : "FALSE";
      const secure = c.secure ? "TRUE" : "FALSE";
      const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0;
      lines.push(`${domain}	${hostOnly}	${c.path ?? "/"}	${secure}	${expiry}	${c.name}	${c.value}`);
    }
    fs.writeFileSync(getVkCookiesPath(), lines.join("\n"), "utf-8");
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
});
electron.ipcMain.handle("check-twitch-session", async () => {
  const ses = electron.session.fromPartition("persist:twitch-chat");
  const cookies = await ses.cookies.get({ domain: "twitch.tv", name: "auth-token" });
  return { loggedIn: cookies.length > 0 };
});
electron.ipcMain.handle("extract-twitch-cookies", async () => {
  const ses = electron.session.fromPartition("persist:twitch-chat");
  const loginWin = new electron.BrowserWindow({
    width: 1080,
    height: 720,
    title: "YouDownload — Sign in to Twitch, then close this window",
    autoHideMenuBar: true,
    parent: mainWindow ?? void 0,
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true }
  });
  loginWin.loadURL("https://www.twitch.tv/login");
  loginWin.show();
  await new Promise((resolve) => loginWin.on("closed", resolve));
  const cookies = await ses.cookies.get({ domain: "twitch.tv", name: "auth-token" });
  if (cookies.length === 0) return { success: false, error: "No Twitch cookies found — make sure you signed in before closing." };
  return { success: true };
});
function enrichFfmpegError(raw) {
  const lower = raw.toLowerCase();
  if (lower.includes("ffmpeg is not installed") || lower.includes("ffmpeg not found")) {
    return "ffmpeg not installed. Install it: winget install ffmpeg  (then restart the app). Or place ffmpeg.exe in the same folder as yt-dlp.exe.";
  }
  return raw;
}
function cleanYtDlpError(raw) {
  if (isSslError(raw)) return "ssl_error";
  const lines = raw.split("\n");
  const errors = lines.filter((l) => l.trimStart().startsWith("ERROR:"));
  if (errors.length > 0) {
    return errors.map((l) => l.replace(/^.*?ERROR:\s*/, "")).join(" | ").slice(0, 300);
  }
  const cleaned = lines.filter((l) => !l.trimStart().startsWith("WARNING:") && !l.trimStart().startsWith("[")).join("\n").trim();
  return (cleaned || raw).slice(0, 300);
}
function isAgeGateError(raw) {
  const l = raw.toLowerCase();
  return l.includes("sign in to confirm your age") || l.includes("age-restricted") || l.includes("confirm your age") || l.includes("this video may be inappropriate");
}
electron.ipcMain.handle("fetch-video-info", async (_e, rawUrl) => {
  if (!ytDlpWrap) return { success: false, error: "yt-dlp not initialized" };
  const url = normalizeVkUrl(rawUrl);
  const s = store.get("settings");
  const isPlaylistOnly = /[?&]list=/.test(url) && !/[?&]v=/.test(url);
  const extraArgs = isPlaylistOnly ? ["--yes-playlist", "--playlist-items", "1"] : ["--no-playlist"];
  try {
    const baseArgs = getBaseArgs(s.cookiesFromBrowser, s.cookiesFile, url);
    const fullArgs = [url, ...extraArgs, ...baseArgs];
    console.log("\n─── fetch-video-info ───────────────────────────────");
    console.log("URL:", url);
    console.log("yt-dlp path:", getYtDlpPath());
    console.log("Args:", fullArgs.join(" "));
    console.log("cookiesStale:", _cookiesStale);
    const info = await ytDlpWrap.getVideoInfo(fullArgs);
    console.log("✓ fetch-video-info OK, formats count:", info?.formats?.length ?? "n/a");
    return { success: true, data: info };
  } catch (e) {
    const errStr = String(e);
    if (errStr.includes("cookies are no longer valid") || errStr.includes("cookies have been rotated")) {
      markCookiesStale();
      console.warn("[YouDownload] Stale cookies detected — retrying with ios client (no cookies)");
      try {
        const retryArgs = getBaseArgs("none", void 0, url, "ios");
        const retryFull = [url, ...extraArgs, ...retryArgs];
        console.log("Retry args:", retryFull.join(" "));
        const info = await ytDlpWrap.getVideoInfo(retryFull);
        console.log("✓ fetch-video-info retry OK, formats:", info?.formats?.length ?? "n/a");
        return { success: true, data: info };
      } catch (e2) {
        console.error("✗ fetch-video-info retry ERROR:", String(e2));
        return { success: false, error: cleanYtDlpError(String(e2)) };
      }
    }
    console.error("✗ fetch-video-info ERROR (raw):\n", errStr);
    if (isAgeGateError(errStr)) {
      try {
        const retryArgs = getBaseArgs(s.cookiesFromBrowser, s.cookiesFile, url, "tv_embedded");
        const info = await ytDlpWrap.getVideoInfo([url, ...extraArgs, ...retryArgs]);
        return { success: true, data: info };
      } catch (e2) {
        const err2 = String(e2);
        if (isAgeGateError(err2)) {
          return {
            success: false,
            error: "age_gate"
            // special token — renderer shows sign-in prompt
          };
        }
        return { success: false, error: cleanYtDlpError(err2) };
      }
    }
    return { success: false, error: cleanYtDlpError(errStr) };
  }
});
const TWITCH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
const hotCache = /* @__PURE__ */ new Map();
function getCachedChannel(key) {
  const all = store.get("twitchCache");
  const hit = all[key];
  if (!hit) return null;
  if (!hit.pinned && Date.now() - hit.fetchedAt > TWITCH_CACHE_TTL_MS) {
    const updated = { ...all };
    delete updated[key];
    store.set("twitchCache", updated);
    hotCache.delete(key);
    return null;
  }
  const hot = hotCache.get(key);
  return {
    entries: hot?.entries ?? hit.entries,
    fetchedAt: hit.fetchedAt,
    pinned: hit.pinned
  };
}
function setCachedChannel(key, entries, pinned) {
  const fetchedAt = Date.now();
  hotCache.set(key, { entries, fetchedAt });
  const all = store.get("twitchCache");
  const existing = all[key];
  store.set("twitchCache", {
    ...all,
    [key]: { entries, fetchedAt, pinned: pinned ?? existing?.pinned ?? false }
  });
}
function pinCachedChannel(key, pinned) {
  const all = store.get("twitchCache");
  if (!all[key]) return;
  store.set("twitchCache", { ...all, [key]: { ...all[key], pinned } });
}
electron.ipcMain.handle("get-twitch-cache-meta", (_e, channelName) => {
  const all = store.get("twitchCache");
  const cn = channelName.toLowerCase();
  const vods = all[`${cn}:vods`];
  const clips = all[`${cn}:clips`];
  return {
    vods: vods ? { fetchedAt: vods.fetchedAt, pinned: vods.pinned } : null,
    clips: clips ? { fetchedAt: clips.fetchedAt, pinned: clips.pinned } : null
  };
});
electron.ipcMain.handle("set-twitch-channel-pin", (_e, channelName, pinned) => {
  const cn = channelName.toLowerCase();
  pinCachedChannel(`${cn}:vods`, pinned);
  pinCachedChannel(`${cn}:clips`, pinned);
  return { success: true };
});
electron.ipcMain.handle("get-twitch-pinned-channels", () => {
  const all = store.get("twitchCache");
  const pinnedSet = /* @__PURE__ */ new Set();
  for (const key of Object.keys(all)) {
    if (all[key].pinned) {
      const channelName = key.replace(/:vods$|:clips$/, "");
      if (channelName) pinnedSet.add(channelName);
    }
  }
  return Array.from(pinnedSet);
});
async function fetchGqlDates(channelName, maxEntries) {
  const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
  const dateMap = {};
  let cursor = null;
  let fetched = 0;
  const maxPages = Math.ceil(Math.min(maxEntries, 500) / 100);
  const gqlRequest = (body) => new Promise((resolve, reject) => {
    const req = electron.net.request({ url: "https://gql.twitch.tv/gql", method: "POST" });
    req.setHeader("Content-Type", "application/json");
    req.setHeader("Client-ID", CLIENT_ID);
    let data = "";
    req.on("response", (res) => {
      res.on("data", (c) => {
        data += c.toString();
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
  for (let page = 0; page < maxPages; page++) {
    const paginationArg = cursor ? `, after: "${cursor}"` : "";
    const gqlResult = await gqlRequest(JSON.stringify([{
      query: `query {
        user(login: "${channelName}") {
          videos(first: 100, type: ARCHIVE, sort: TIME${paginationArg}) {
            edges { node { id createdAt } cursor }
            pageInfo { hasNextPage }
          }
        }
      }`
    }]));
    const edges = gqlResult?.[0]?.data?.user?.videos?.edges ?? [];
    for (const edge of edges) {
      const node = edge?.node;
      if (node?.id && node?.createdAt) {
        const ts = Math.floor(new Date(node.createdAt).getTime() / 1e3);
        dateMap[`v${node.id}`] = ts;
        dateMap[node.id] = ts;
      }
    }
    fetched += edges.length;
    const hasNextPage = gqlResult?.[0]?.data?.user?.videos?.pageInfo?.hasNextPage;
    if (!hasNextPage || edges.length === 0) break;
    cursor = edges[edges.length - 1]?.cursor ?? null;
    if (!cursor) break;
  }
  return dateMap;
}
function gqlPost(body) {
  const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
  return new Promise((resolve, reject) => {
    const req = electron.net.request({ url: "https://gql.twitch.tv/gql", method: "POST" });
    req.setHeader("Content-Type", "application/json");
    req.setHeader("Client-ID", CLIENT_ID);
    let data = "";
    req.on("response", (res) => {
      res.on("data", (c) => {
        data += c.toString();
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
async function fetchGqlClipsDelta(channelName, since) {
  const newEntries = [];
  let cursor = null;
  const sinceMs = since * 1e3;
  for (let page = 0; page < 50; page++) {
    const paginationArg = cursor ? `, after: "${cursor}"` : "";
    const result = await gqlPost(JSON.stringify([{
      query: `query {
        user(login: "${channelName}") {
          clips(first: 100, criteria: { sort: CREATED_AT_DESC }${paginationArg}) {
            edges {
              cursor
              node {
                id slug title
                createdAt
                durationSeconds
                viewCount
                thumbnailURL(width: 480, height: 272)
                broadcaster { login displayName }
                game { name }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      }`
    }]));
    const edges = result?.[0]?.data?.user?.clips?.edges ?? [];
    let reachedOld = false;
    for (const edge of edges) {
      const node = edge?.node;
      if (!node) continue;
      const createdAtMs = new Date(node.createdAt).getTime();
      if (createdAtMs <= sinceMs) {
        reachedOld = true;
        break;
      }
      const ts = Math.floor(createdAtMs / 1e3);
      const d = new Date(createdAtMs);
      newEntries.push({
        id: node.slug ?? node.id,
        title: node.title ?? node.slug,
        url: `https://www.twitch.tv/${channelName}/clip/${node.slug ?? node.id}`,
        webpage_url: `https://www.twitch.tv/${channelName}/clip/${node.slug ?? node.id}`,
        thumbnail: node.thumbnailURL ?? null,
        duration: node.durationSeconds ?? null,
        view_count: node.viewCount ?? null,
        timestamp: ts,
        upload_date: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`,
        ie_key: "TwitchClips",
        _type: "url"
      });
    }
    if (reachedOld || !result?.[0]?.data?.user?.clips?.pageInfo?.hasNextPage || edges.length === 0) break;
    cursor = edges[edges.length - 1]?.cursor ?? null;
    if (!cursor) break;
  }
  return newEntries;
}
async function fetchGqlVodsDelta(channelName, since) {
  const newEntries = [];
  let cursor = null;
  const sinceMs = since * 1e3;
  for (let page = 0; page < 20; page++) {
    const paginationArg = cursor ? `, after: "${cursor}"` : "";
    const result = await gqlPost(JSON.stringify([{
      query: `query {
        user(login: "${channelName}") {
          videos(first: 100, type: ARCHIVE, sort: TIME${paginationArg}) {
            edges {
              cursor
              node {
                id title
                createdAt
                lengthSeconds
                viewCount
                thumbnailURLs(width: 480, height: 272)
                game { name }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      }`
    }]));
    const edges = result?.[0]?.data?.user?.videos?.edges ?? [];
    let reachedOld = false;
    for (const edge of edges) {
      const node = edge?.node;
      if (!node) continue;
      const createdAtMs = new Date(node.createdAt).getTime();
      if (createdAtMs <= sinceMs) {
        reachedOld = true;
        break;
      }
      const ts = Math.floor(createdAtMs / 1e3);
      const d = new Date(createdAtMs);
      newEntries.push({
        id: `v${node.id}`,
        title: node.title ?? `VOD ${node.id}`,
        url: `https://www.twitch.tv/videos/${node.id}`,
        webpage_url: `https://www.twitch.tv/videos/${node.id}`,
        thumbnail: node.thumbnailURLs?.[0] ?? null,
        duration: node.lengthSeconds ?? null,
        view_count: node.viewCount ?? null,
        timestamp: ts,
        upload_date: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`,
        ie_key: "TwitchVod",
        _type: "url"
      });
    }
    if (reachedOld || !result?.[0]?.data?.user?.videos?.pageInfo?.hasNextPage || edges.length === 0) break;
    cursor = edges[edges.length - 1]?.cursor ?? null;
    if (!cursor) break;
  }
  return newEntries;
}
electron.ipcMain.handle("fetch-twitch-delta", async (_e, channelName, type) => {
  const cacheKey = `${channelName.toLowerCase()}:${type}`;
  const all = store.get("twitchCache");
  const cached = all[cacheKey];
  if (!cached) {
    return { success: false, reason: "no_cache" };
  }
  const since = cached.lastDeltaCheckedAt ?? cached.fetchedAt;
  const nowSec = Math.floor(Date.now() / 1e3);
  const ageSec = nowSec - Math.floor(since / 1e3);
  if (ageSec < 60) {
    return { success: true, newEntries: [], alreadyFresh: true };
  }
  console.log(`[twitch-delta] ${cacheKey}: checking new content since ${new Date(since).toISOString()} (${Math.round(ageSec / 60)}min ago)`);
  try {
    const newEntries = type === "clips" ? await fetchGqlClipsDelta(channelName, Math.floor(since / 1e3)) : await fetchGqlVodsDelta(channelName, Math.floor(since / 1e3));
    console.log(`[twitch-delta] ${cacheKey}: found ${newEntries.length} new entries`);
    const nowMs = Date.now();
    store.set("twitchCache", {
      ...store.get("twitchCache"),
      [cacheKey]: { ...cached, lastDeltaCheckedAt: nowMs }
    });
    if (newEntries.length > 0) {
      const existingEntries = hotCache.get(cacheKey)?.entries ?? cached.entries;
      const existingIds = new Set(existingEntries.map((e) => e.id));
      const truly_new = newEntries.filter((e) => !existingIds.has(e.id));
      if (truly_new.length > 0) {
        const merged = [...truly_new, ...existingEntries];
        hotCache.set(cacheKey, { entries: merged, fetchedAt: cached.fetchedAt });
        store.set("twitchCache", {
          ...store.get("twitchCache"),
          [cacheKey]: { ...cached, entries: merged, lastDeltaCheckedAt: nowMs }
        });
      }
      return { success: true, newEntries: truly_new, deltaCheckedAt: nowMs };
    }
    return { success: true, newEntries: [], deltaCheckedAt: nowMs };
  } catch (e) {
    console.error(`[twitch-delta] ${cacheKey} error:`, String(e));
    return { success: false, reason: String(e) };
  }
});
function fetchYtDlpEntries(url) {
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn(
      getYtDlpPath(),
      [url, "--flat-playlist", "--dump-json", "--yes-playlist", "--no-warnings"],
      { encoding: "utf8" }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("yt-dlp timeout after 30s"));
    }, 3e4);
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.slice(0, 300) || `yt-dlp exited with code ${code}`));
        return;
      }
      const entries = stdout.trim().split("\n").filter(Boolean).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);
      resolve(entries);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
electron.ipcMain.handle("fetch-twitch-channel", async (_e, channelName, type, refresh = false) => {
  const cacheKey = `${channelName.toLowerCase()}:${type}`;
  if (!refresh) {
    const cached = getCachedChannel(cacheKey);
    if (cached) {
      console.log(`[twitch-cache] HIT ${cacheKey} (${cached.entries.length} entries, age ${Math.round((Date.now() - cached.fetchedAt) / 1e3)}s, pinned=${cached.pinned})`);
      return { success: true, entries: cached.entries, fromCache: true, pinned: cached.pinned, fetchedAt: cached.fetchedAt };
    }
  }
  const url = type === "vods" ? `https://www.twitch.tv/${channelName}/videos?filter=archives&sort=time` : `https://www.twitch.tv/${channelName}/clips?filter=clips&range=all`;
  try {
    let entries;
    if (type === "vods") {
      const [ytEntries, dateMapPage1] = await Promise.all([
        fetchYtDlpEntries(url),
        fetchGqlDates(channelName, 100).catch(() => ({}))
      ]);
      entries = ytEntries;
      let dateMap = dateMapPage1;
      if (entries.length > Object.keys(dateMapPage1).length / 2) {
        try {
          dateMap = await fetchGqlDates(channelName, entries.length);
        } catch {
        }
      }
      for (const e of entries) {
        const ts = dateMap[e.id] ?? dateMap[(e.id ?? "").replace(/^v/, "")];
        if (ts) {
          e.timestamp = ts;
          const d = new Date(ts * 1e3);
          e.upload_date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
        }
      }
      console.log(`[twitch-fetch] VODs: ${entries.length} entries, dateMap: ${Object.keys(dateMap).length} dates`);
    } else {
      entries = await fetchYtDlpEntries(url);
    }
    const existingMeta = store.get("twitchCache")[cacheKey];
    setCachedChannel(cacheKey, entries, existingMeta?.pinned);
    return { success: true, entries, fromCache: false, pinned: existingMeta?.pinned ?? false, fetchedAt: Date.now() };
  } catch (e) {
    return { success: false, error: String(e), entries: [] };
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
  const baseDir = payload.downloadPath || s.downloadPath;
  const saveToPlaylistFolder = payload.saveToPlaylistFolder || payload.url.includes("youtube.com") && payload.url.includes("/playlist") || payload.formatArgs.includes("--yes-playlist");
  const outDir = saveToPlaylistFolder ? (() => {
    const d = path.join(baseDir, "YouPlayList");
    fs.mkdirSync(d, { recursive: true });
    return d;
  })() : baseDir;
  const isYouTubePlaylist = payload.url.includes("youtube.com") && payload.url.includes("/playlist") || payload.formatArgs.includes("--yes-playlist");
  payload = { ...payload, url: normalizeVkUrl(payload.url) };
  let formatArgs = payload.formatArgs;
  if (payload.url.includes("music.youtube")) {
    const hasVideoFormat = formatArgs.some((a) => a.includes("bestvideo"));
    if (hasVideoFormat) {
      formatArgs = ["-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "0"];
    }
  }
  const isSectionDownload = formatArgs.includes("--download-sections");
  let sectionTimer = null;
  if (isSectionDownload && !findFfmpeg()) {
    return {
      success: false,
      error: "ffmpeg не установлен. Для скачивания отрезков требуется ffmpeg.\nУстановить: winget install ffmpeg  (затем перезапустить приложение)\nИли поместить ffmpeg.exe в ту же папку, что и yt-dlp.exe"
    };
  }
  if (isSectionDownload) {
    const dur = payload.sectionDuration && payload.sectionDuration > 0 ? payload.sectionDuration : 300;
    const startTime = Date.now();
    const expectedMs = dur * 1e3 * 1.3;
    console.log(`[section-timer] запущен, dur=${dur}s, expectedMs=${Math.round(expectedMs / 1e3)}s`);
    sectionTimer = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const pct = Math.min(elapsed / expectedMs * 95, 95);
      event.sender.send("download-progress", { id: payload.id, progress: pct, speed: "", eta: "", status: "downloading" });
    }, 800);
  }
  const buildArgs = (sslFallback) => [
    payload.url,
    ...formatArgs,
    ...getBaseArgs(s.cookiesFromBrowser, s.cookiesFile, payload.url, void 0, sslFallback),
    "-o",
    path.join(outDir, "%(title)s.%(ext)s"),
    "--windows-filenames",
    "--no-part",
    ...isYouTubePlaylist ? ["--yes-playlist"] : ["--no-playlist"],
    "--progress",
    "--newline"
  ];
  console.log("\n─── start-download ─────────────────────────────────");
  console.log("ID:", payload.id);
  console.log("URL:", payload.url);
  console.log("formatArgs:", formatArgs.join(" "));
  console.log("outDir:", outDir);
  console.log("Full args:", buildArgs(false).join(" "));
  console.log("ffmpeg path:", findFfmpeg() ?? "NOT FOUND");
  const runDownload = (args) => new Promise((resolve) => {
    const emitter = ytDlpWrap.exec(args);
    activeDownloads.set(payload.id, { emitter, cancelled: false });
    emitter.on("ytDlpEvent", (type, data) => {
      if (type === "download") {
        if (sectionTimer) return;
        const pct = data.match(/(\d+\.?\d*)%/)?.[1];
        const speed = data.match(/at\s+([\d.]+\s*\S+\/s)/)?.[1];
        const eta = data.match(/ETA\s+([\d:]+)/)?.[1];
        event.sender.send("download-progress", { id: payload.id, progress: pct ? parseFloat(pct) : 0, speed: speed ?? "", eta: eta ?? "", status: "downloading" });
      }
    });
    emitter.on("error", (err) => {
      if (activeDownloads.get(payload.id)?.cancelled) {
        resolve("error");
        return;
      }
      const raw = err.message;
      console.error("✗ download ERROR (raw):\n", raw);
      if (raw.includes("cookies are no longer valid") || raw.includes("cookies have been rotated")) {
        markCookiesStale();
      }
      if (isSslError(raw)) {
        resolve("ssl_error");
        return;
      }
      if (raw.includes("--live-from-start is passed") || raw.includes("no formats that can be downloaded from the start")) {
        resolve("no_live_from_start");
        return;
      }
      if (sectionTimer) {
        clearInterval(sectionTimer);
        sectionTimer = null;
      }
      let msg;
      if (isAgeGateError(raw)) {
        msg = "age_gate";
      } else {
        msg = enrichFfmpegError(cleanYtDlpError(raw));
      }
      console.error("✗ download ERROR (cleaned):", msg);
      event.sender.send("download-error", { id: payload.id, error: msg });
      activeDownloads.delete(payload.id);
      resolve("error");
    });
    emitter.on("close", () => {
      console.log(`[yt-dlp close] id=${payload.id}, sectionTimer active=${!!sectionTimer}, cancelled=${activeDownloads.get(payload.id)?.cancelled ?? false}`);
      if (activeDownloads.get(payload.id)?.cancelled) {
        resolve("error");
        return;
      }
      resolve("complete");
    });
  });
  const clearTimers = () => {
    if (sectionTimer) {
      clearInterval(sectionTimer);
      sectionTimer = null;
    }
  };
  try {
    const result1 = await runDownload(buildArgs(false));
    if (result1 === "complete") {
      clearTimers();
      event.sender.send("download-complete", { id: payload.id });
      activeDownloads.delete(payload.id);
      return { success: true };
    }
    if (result1 === "error") {
      clearTimers();
      return { success: true };
    }
    if (result1 === "no_live_from_start") {
      console.log("[live-from-start] not supported, falling back to live edge");
      const fallbackArgs = buildArgs(false).filter((a) => a !== "--live-from-start");
      const result1b = await runDownload(fallbackArgs);
      if (result1b === "complete") {
        clearTimers();
        event.sender.send("download-complete", { id: payload.id });
        activeDownloads.delete(payload.id);
        return { success: true };
      }
      clearTimers();
      return { success: true };
    }
    if (result1 === "ssl_error") {
      event.sender.send("download-progress", {
        id: payload.id,
        progress: 0,
        speed: "",
        eta: "",
        status: "downloading",
        hint: "ssl_retry"
      });
      const result2 = await runDownload(buildArgs(true));
      if (result2 === "complete") {
        clearTimers();
        event.sender.send("download-complete", { id: payload.id });
        activeDownloads.delete(payload.id);
        return { success: true };
      }
      if (result2 === "ssl_error") {
        clearTimers();
        event.sender.send("download-error", { id: payload.id, error: "ssl_error" });
        activeDownloads.delete(payload.id);
      }
      if (result2 === "error") {
        clearTimers();
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
});
electron.ipcMain.handle("debug-list-formats", async (_e, url) => {
  const { spawnSync: spawnSync2 } = await import("child_process");
  const ytPath = getYtDlpPath();
  console.log("\n─── debug-list-formats ─────────────────────────────");
  console.log("URL:", url);
  const result = spawnSync2(ytPath, [url, "--list-formats", "--no-playlist"], { encoding: "utf8", timeout: 3e4 });
  console.log("STDOUT:\n", result.stdout);
  if (result.stderr) console.log("STDERR:\n", result.stderr);
  return { stdout: result.stdout, stderr: result.stderr };
});
electron.ipcMain.handle("get-cookies-stale", () => _cookiesStale);
electron.ipcMain.handle("reset-cookies-stale", () => {
  _cookiesStale = false;
  return true;
});
electron.ipcMain.handle("cancel-download", (_e, id) => {
  const dl = activeDownloads.get(id);
  if (!dl) return { success: false };
  dl.cancelled = true;
  const ytDlpProcess = dl.emitter.ytDlpProcess;
  if (ytDlpProcess?.pid) {
    try {
      child_process.execSync(`taskkill /pid ${ytDlpProcess.pid} /T /F`, { stdio: "ignore" });
    } catch {
    }
    try {
      ytDlpProcess.kill();
    } catch {
    }
  }
  return { success: true };
});
electron.ipcMain.handle("open-folder", (_e, path2) => electron.shell.openPath(path2));
electron.ipcMain.handle("open-external", (_e, url) => electron.shell.openExternal(url));
electron.ipcMain.handle("fetch-twitch-followed-live", async () => {
  const ses = electron.session.fromPartition("persist:twitch-chat");
  const authCookies = await ses.cookies.get({ domain: "twitch.tv", name: "auth-token" });
  const authToken = authCookies[0]?.value;
  if (!authToken) return { success: false, error: "not_logged_in" };
  const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
  const gqlFetch = (body) => new Promise((resolve, reject) => {
    const req = electron.net.request({ url: "https://gql.twitch.tv/gql", method: "POST" });
    req.setHeader("Content-Type", "application/json");
    req.setHeader("Client-ID", CLIENT_ID);
    req.setHeader("Authorization", `OAuth ${authToken}`);
    let data = "";
    req.on("response", (res) => {
      res.on("data", (c) => {
        data += c.toString();
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
  try {
    const meResp = await gqlFetch([{ query: "query { currentUser { id login displayName profileImageURL(width: 70) } }" }]);
    const me = meResp?.[0]?.data?.currentUser;
    if (!me) return { success: false, error: "not_logged_in" };
    const liveResp = await gqlFetch([{
      operationName: "FollowedSideNav_CurrentUser",
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
    }]);
    const nodes = liveResp?.[0]?.data?.currentUser?.followedLiveUsers?.nodes ?? [];
    const streams = nodes.map((u) => ({
      login: u.login,
      displayName: u.displayName,
      avatar: u.profileImageURL,
      title: u.stream?.title ?? "",
      viewers: u.stream?.viewersCount ?? 0,
      game: u.stream?.game?.name ?? ""
    }));
    return { success: true, streams, me: { login: me.login, displayName: me.displayName, avatar: me.profileImageURL } };
  } catch (e) {
    return { success: false, error: String(e) };
  }
});
let chatWindow = null;
electron.ipcMain.on("chat-minimize", () => chatWindow?.minimize());
electron.ipcMain.on("chat-maximize", () => {
  if (!chatWindow) return;
  if (chatWindow.isMaximized()) {
    chatWindow.unmaximize();
    chatWindow.webContents.send("chat-maximized", false);
  } else {
    chatWindow.maximize();
    chatWindow.webContents.send("chat-maximized", true);
  }
});
electron.ipcMain.on("chat-close", () => {
  chatWindow?.close();
  chatWindow = null;
});
electron.ipcMain.handle("open-twitch-chat", (_e, channel) => {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.focus();
    return;
  }
  chatWindow = new electron.BrowserWindow({
    width: 360,
    height: 720,
    minWidth: 280,
    minHeight: 400,
    title: `Chat — ${channel}`,
    backgroundColor: "#0e0e10",
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      webviewTag: true,
      session: electron.session.fromPartition("persist:twitch-chat")
    }
  });
  const chatHtmlPath = electron.app.isPackaged ? path.join(process.resourcesPath, "app.asar", "src", "chat.html") : path.join(electron.app.getAppPath(), "src", "chat.html");
  chatWindow.loadFile(chatHtmlPath, { query: { channel } });
  chatWindow.on("maximize", () => chatWindow?.webContents.send("chat-maximized", true));
  chatWindow.on("unmaximize", () => chatWindow?.webContents.send("chat-maximized", false));
  chatWindow.on("closed", () => {
    chatWindow = null;
  });
});
const CURRENT_VERSION = electron.app.getVersion();
const GITHUB_RELEASES_API = "https://api.github.com/repos/Bzden4ik/YouDownload/releases/latest";
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = electron.net.request({ url, method: "GET" });
    req.setHeader("User-Agent", `YouDownload/${CURRENT_VERSION}`);
    req.setHeader("Accept", "application/vnd.github+json");
    let body = "";
    req.on("response", (res) => {
      res.on("data", (chunk) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}
function compareVersions(a, b) {
  const normalize = (v) => v.replace(/^v/, "").split(".").map(Number);
  const [aMaj, aMin, aPatch] = normalize(a);
  const [bMaj, bMin, bPatch] = normalize(b);
  if (aMaj !== bMaj) return bMaj - aMaj;
  if (aMin !== bMin) return bMin - aMin;
  return (bPatch ?? 0) - (aPatch ?? 0);
}
electron.ipcMain.handle("check-for-updates", async () => {
  try {
    const release = await fetchJson(GITHUB_RELEASES_API);
    const latest = release.tag_name.replace(/^v/, "");
    const current = CURRENT_VERSION.replace(/^v/, "");
    const hasUpdate = compareVersions(current, latest) > 0;
    if (!hasUpdate) return { hasUpdate: false, currentVersion: current, latestVersion: latest };
    const asset = release.assets.find(
      (a) => a.name.toLowerCase().endsWith(".exe") && a.name.toLowerCase().includes("setup")
    );
    return {
      hasUpdate: true,
      currentVersion: current,
      latestVersion: latest,
      releaseName: release.name,
      releaseNotes: release.body,
      downloadUrl: asset?.browser_download_url ?? release.html_url,
      assetName: asset?.name ?? "",
      assetSize: asset?.size ?? 0
    };
  } catch (err) {
    return { hasUpdate: false, error: String(err) };
  }
});
electron.ipcMain.handle("download-and-install-update", async (event, downloadUrl, assetName) => {
  try {
    const tmpDir = electron.app.getPath("temp");
    const installerPath = path.join(tmpDir, assetName || "YouDownload-update.exe");
    await new Promise((resolve, reject) => {
      const req = electron.net.request({ url: downloadUrl, method: "GET" });
      req.setHeader("User-Agent", `YouDownload/${CURRENT_VERSION}`);
      let received = 0;
      let total = 0;
      const chunks = [];
      req.on("response", (res) => {
        total = parseInt(res.headers["content-length"] ?? "0", 10);
        res.on("data", (chunk) => {
          chunks.push(chunk);
          received += chunk.length;
          if (total > 0) {
            const pct = Math.round(received / total * 100);
            event.sender.send("update-download-progress", pct);
          }
        });
        res.on("end", () => {
          fs.writeFileSync(installerPath, Buffer.concat(chunks));
          resolve();
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
    event.sender.send("update-download-progress", 100);
    child_process.spawn(installerPath, [], { detached: true, stdio: "ignore" }).unref();
    setTimeout(() => electron.app.quit(), 1500);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});
async function saveSessionCookies() {
  const ses = electron.session.fromPartition("persist:yt-cookies");
  const yt = await ses.cookies.get({ domain: "youtube.com" });
  const goo = await ses.cookies.get({ domain: "google.com" });
  const all = [...yt, ...goo];
  if (all.length === 0) return;
  const lines = ["# Netscape HTTP Cookie File", ""];
  for (const c of all) {
    const domain = c.domain ?? "";
    const hostOnly = domain.startsWith(".") ? "TRUE" : "FALSE";
    const secure = c.secure ? "TRUE" : "FALSE";
    const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0;
    lines.push(`${domain}	${hostOnly}	${c.path ?? "/"}	${secure}	${expiry}	${c.name}	${c.value}`);
  }
  fs.writeFileSync(getWritableCookiesPath(), lines.join("\n"), "utf-8");
}
async function autoRefreshCookies() {
  try {
    await saveSessionCookies();
  } catch {
  }
}
async function autoRefreshVkCookies() {
  try {
    const ses = electron.session.fromPartition("persist:vk-cookies");
    const existing = await ses.cookies.get({ domain: "vk.com", name: "remixsid" });
    if (existing.length === 0) return;
    const vk = await ses.cookies.get({ domain: "vk.com" });
    if (vk.length === 0) return;
    const lines = ["# Netscape HTTP Cookie File", ""];
    for (const c of vk) {
      const domain = c.domain ?? "";
      const hostOnly = domain.startsWith(".") ? "TRUE" : "FALSE";
      const secure = c.secure ? "TRUE" : "FALSE";
      const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0;
      lines.push(`${domain}	${hostOnly}	${c.path ?? "/"}	${secure}	${expiry}	${c.name}	${c.value}`);
    }
    fs.writeFileSync(getVkCookiesPath(), lines.join("\n"), "utf-8");
  } catch {
  }
}
electron.app.commandLine.appendSwitch("enable-gpu-rasterization");
electron.app.commandLine.appendSwitch("enable-zero-copy");
electron.app.commandLine.appendSwitch("ignore-gpu-blocklist");
electron.app.commandLine.appendSwitch("disable-software-rasterizer");
electron.app.commandLine.appendSwitch("use-angle", "d3d11");
electron.app.commandLine.appendSwitch("enable-features", [
  "D3D11VideoDecoder",
  // аппаратный декодинг H.264/AVC через D3D11
  "VaapiVideoDecoder",
  // fallback для Intel/AMD через VAAPI
  "PlatformHEVCDecoderSupport",
  // HEVC/H.265 если стрим в этом формате
  "HardwareMediaKeyHandling",
  "CanvasOopRasterization",
  "EnableDrDc"
  // Double-buffered rendering — меньше разрывов
].join(","));
electron.app.commandLine.appendSwitch("disable-gpu-vsync");
electron.app.commandLine.appendSwitch("enable-hardware-overlays", "single-fullscreen,single-on-top,underlay");
electron.app.commandLine.appendSwitch("renderer-process-limit", "100");
electron.app.commandLine.appendSwitch("disable-renderer-backgrounding");
electron.app.whenReady().then(async () => {
  electron.session.fromPartition("persist:preview").setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ["media", "autoplay", "fullscreen", "mediaKeySystem"];
    callback(allowed.includes(permission));
  });
  const ytPreviewSession = electron.session.fromPartition("persist:yt-preview");
  const YT_AD_PATTERNS = [
    "*://*.doubleclick.net/*",
    "*://doubleclick.net/*",
    "*://*.googlesyndication.com/*",
    "*://*.googleadservices.com/*",
    "*://*.google-analytics.com/*",
    "*://www.googletagmanager.com/*",
    "*://*.googletagservices.com/*",
    "*://*.adsystem.com/*",
    "*://securepubads.g.doubleclick.net/*",
    "*://static.doubleclick.net/*",
    "*://ad.doubleclick.net/*",
    "*://www.youtube.com/pagead/*",
    "*://www.youtube.com/api/stats/ads*",
    "*://www.youtube.com/ptracking*",
    "*://www.youtube.com/adview*",
    "*://www.youtube.com/ad_data_204*",
    "*://www.youtube.com/youtubei/v1/log_event*",
    // Рекламные видеопотоки через googlevideo
    "*://*.googlevideo.com/videoplayback?*ctier=L*",
    "*://*.googlevideo.com/videoplayback?*oad=1*",
    // Дополнительные рекламные эндпоинты YouTube
    "*://www.youtube.com/youtubei/v1/next?*adunit*",
    "*://www.youtube.com/get_video_info?*adformat*"
  ];
  ytPreviewSession.webRequest.onBeforeRequest(
    { urls: YT_AD_PATTERNS },
    (_details, callback) => callback({ cancel: true })
  );
  ytPreviewSession.webRequest.onHeadersReceived({ urls: ["*://www.youtube.com/*"] }, (details, callback) => {
    const headers = details.responseHeaders ?? {};
    delete headers["content-security-policy"];
    delete headers["Content-Security-Policy"];
    callback({ responseHeaders: headers });
  });
  ytPreviewSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ["media", "autoplay", "fullscreen", "mediaKeySystem"];
    callback(allowed.includes(permission));
  });
  electron.app.on("web-contents-created", (_, wc) => {
    wc.on("did-finish-load", () => injectTwitchOverrideCSS(wc));
    wc.on("did-frame-finish-load", () => injectTwitchOverrideCSS(wc));
  });
  startPreviewServer();
  createWindow();
  ensureCookiesWritable();
  initYtDlp().catch(() => {
  });
  setTimeout(() => {
    autoRefreshCookies().catch(() => {
    });
    autoRefreshVkCookies().catch(() => {
    });
  }, 3e3);
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
