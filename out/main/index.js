"use strict";
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
    history: []
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
    const videoId = url.searchParams.get("id") ?? "";
    const channelName = url.searchParams.get("channel") ?? "";
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
function getBaseArgs(cookiesFromBrowser, cookiesFile, url) {
  const explicit = cookiesFile && fs.existsSync(cookiesFile) ? cookiesFile : null;
  const writable = fs.existsSync(getWritableCookiesPath()) ? getWritableCookiesPath() : null;
  const activeCookies = explicit ?? writable;
  const isTwitch = url?.includes("twitch.tv") ?? false;
  const isVK = (url?.includes("vk.com") || url?.includes("vkvideo.ru")) ?? false;
  const isMusicYT = url?.includes("music.youtube.com") ?? false;
  const args = [
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--skip-unavailable-fragments",
    "--remote-components",
    "ejs:github"
  ];
  const ffmpegPath = findFfmpeg();
  if (ffmpegPath) {
    const ffmpegDir = path.join(ffmpegPath, "..");
    args.push("--ffmpeg-location", ffmpegDir);
  }
  if (!isTwitch && !isVK) {
    if (isMusicYT) {
      const playerClient = activeCookies ? "android_music" : "ios";
      args.push("--extractor-args", `youtube:player_client=${playerClient}`);
    } else if (!activeCookies) {
      args.push("--extractor-args", "youtube:player_client=ios");
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
    webPreferences: { preload: path.join(__dirname, "../preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: true }
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
function enrichFfmpegError(raw) {
  const lower = raw.toLowerCase();
  if (lower.includes("ffmpeg is not installed") || lower.includes("ffmpeg not found")) {
    return "ffmpeg not installed. Install it: winget install ffmpeg  (then restart the app). Or place ffmpeg.exe in the same folder as yt-dlp.exe.";
  }
  return raw;
}
function cleanYtDlpError(raw) {
  const lines = raw.split("\n");
  const errors = lines.filter((l) => l.trimStart().startsWith("ERROR:"));
  if (errors.length > 0) {
    return errors.map((l) => l.replace(/^.*?ERROR:\s*/, "")).join(" | ");
  }
  const cleaned = lines.filter((l) => !l.trimStart().startsWith("WARNING:")).join("\n").trim();
  return cleaned || raw;
}
electron.ipcMain.handle("fetch-video-info", async (_e, rawUrl) => {
  if (!ytDlpWrap) return { success: false, error: "yt-dlp not initialized" };
  const url = normalizeVkUrl(rawUrl);
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
electron.ipcMain.handle("fetch-twitch-channel", async (_e, channelName, type) => {
  const url = type === "vods" ? `https://www.twitch.tv/${channelName}/videos?filter=archives&sort=time` : `https://www.twitch.tv/${channelName}/clips?filter=clips&range=all`;
  try {
    const result = child_process.spawnSync(
      getYtDlpPath(),
      [url, "--flat-playlist", "--dump-json", "--yes-playlist", "--no-warnings"],
      { encoding: "utf8", timeout: 3e4 }
    );
    const entries = (result.stdout || "").trim().split("\n").filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
    return { success: true, entries };
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
  const outDir = payload.downloadPath || s.downloadPath;
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
  if (isSectionDownload && payload.sectionDuration && payload.sectionDuration > 0) {
    const startTime = Date.now();
    const expectedMs = payload.sectionDuration * 1e3 * 1.3;
    sectionTimer = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const pct = Math.min(elapsed / expectedMs * 95, 95);
      event.sender.send("download-progress", { id: payload.id, progress: pct, speed: "", eta: "", status: "downloading" });
    }, 800);
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
        if (sectionTimer) return;
        const pct = data.match(/(\d+\.?\d*)%/)?.[1];
        const speed = data.match(/at\s+([\d.]+\s*\S+\/s)/)?.[1];
        const eta = data.match(/ETA\s+([\d:]+)/)?.[1];
        event.sender.send("download-progress", { id: payload.id, progress: pct ? parseFloat(pct) : 0, speed: speed ?? "", eta: eta ?? "", status: "downloading" });
      }
    });
    emitter.on("error", (err) => {
      if (sectionTimer) {
        clearInterval(sectionTimer);
        sectionTimer = null;
      }
      const dl = activeDownloads.get(payload.id);
      if (!dl?.cancelled) {
        const msg = enrichFfmpegError(cleanYtDlpError(err.message));
        event.sender.send("download-error", { id: payload.id, error: msg });
      }
      activeDownloads.delete(payload.id);
    });
    emitter.on("close", () => {
      if (sectionTimer) {
        clearInterval(sectionTimer);
        sectionTimer = null;
      }
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
  const ses = electron.session.fromPartition("persist:yt-cookies");
  const existing = await ses.cookies.get({ domain: "youtube.com", name: "SID" });
  if (existing.length === 0) return;
  const win = new electron.BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true }
  });
  try {
    await Promise.race([
      new Promise((resolve) => win.webContents.once("did-finish-load", resolve)),
      new Promise((resolve) => setTimeout(resolve, 12e3))
    ]);
    win.loadURL("https://www.youtube.com");
    await Promise.race([
      new Promise((resolve) => win.webContents.once("did-finish-load", resolve)),
      new Promise((resolve) => setTimeout(resolve, 12e3))
    ]);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await saveSessionCookies();
  } catch {
  } finally {
    win.destroy();
  }
}
async function autoRefreshVkCookies() {
  const ses = electron.session.fromPartition("persist:vk-cookies");
  const existing = await ses.cookies.get({ domain: "vk.com", name: "remixsid" });
  if (existing.length === 0) return;
  const win = new electron.BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true }
  });
  try {
    win.loadURL("https://vk.com");
    await Promise.race([
      new Promise((resolve) => win.webContents.once("did-finish-load", resolve)),
      new Promise((resolve) => setTimeout(resolve, 12e3))
    ]);
    await new Promise((resolve) => setTimeout(resolve, 2e3));
    const vk = await ses.cookies.get({ domain: "vk.com" });
    if (vk.length > 0) {
      const lines = ["# Netscape HTTP Cookie File", ""];
      for (const c of vk) {
        const domain = c.domain ?? "";
        const hostOnly = domain.startsWith(".") ? "TRUE" : "FALSE";
        const secure = c.secure ? "TRUE" : "FALSE";
        const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0;
        lines.push(`${domain}	${hostOnly}	${c.path ?? "/"}	${secure}	${expiry}	${c.name}	${c.value}`);
      }
      fs.writeFileSync(getVkCookiesPath(), lines.join("\n"), "utf-8");
    }
  } catch {
  } finally {
    win.destroy();
  }
}
electron.app.whenReady().then(async () => {
  electron.session.fromPartition("persist:preview").setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ["media", "autoplay", "fullscreen"];
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
