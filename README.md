<div align="center">

<img src="resources/icon.svg" width="96" height="96" alt="YouDownload Logo"/>

# YouDownload

**Futuristic desktop downloader for YouTube & 1000+ sites**

[![Release](https://img.shields.io/github/v/release/warfa/YouDownload?style=flat-square&color=4ADE80)](https://github.com/Bzden4ik/YouDownload/releases/tag/1.0.0)
[![Platform](https://img.shields.io/badge/platform-Windows-blue?style=flat-square)](https://github.com/warfa/YouDownload/releases)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-33-47848F?style=flat-square&logo=electron)](https://www.electronjs.org/)

</div>

---

## Features

- **Video download** — 4K / 1440p / 1080p / 720p / 480p / 360p
- **Audio extraction** — MP3 (best / 192k / 128k) and M4A
- **YouTube Music** support
- **Shorts & Playlists** support
- **1000+ sites** via yt-dlp engine
- **Real-time progress** — speed, ETA, progress bar
- **Download history** — persisted across sessions
- **Two themes** — FleetWatch (green/cyan) and Vulnerable Apathy (pink/blue glassmorphism)
- **English / Russian** interface
- **All settings saved** between launches

---

## Screenshots

| FleetWatch Theme | Vulnerable Apathy Theme |
|---|---|
| Dark futuristic UI with green accents | Glassmorphism with neon pink/blue orbs |

---

## Download

Go to [**Releases**](https://github.com/warfa/YouDownload/releases) and download the latest installer.

```
YouDownload Setup 1.0.0.exe
```

Run it, follow the installer, done.

---

## Requirements

- **Windows 10 / 11** x64
- **Internet connection** on first launch (downloads yt-dlp engine ~10 MB)
- **ffmpeg** *(optional but recommended)* — required for merging video+audio at 1080p and above

### Install ffmpeg

```powershell
winget install Gyan.FFmpeg
```

Or download from [ffmpeg.org](https://ffmpeg.org/download.html) and add to PATH.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Electron 33](https://www.electronjs.org/) |
| Frontend | React 18 + TypeScript |
| Bundler | electron-vite |
| Downloader | [yt-dlp](https://github.com/yt-dlp/yt-dlp) via yt-dlp-wrap |
| Storage | electron-store |
| Fonts | Orbitron, Barlow Condensed, Syncopate, Space Grotesk, Azeret Mono |

---

## Build from Source

```bash
git clone https://github.com/warfa/YouDownload.git
cd YouDownload

# Install dependencies
npm install --include=dev

# Run in dev mode
npm run dev

# Generate icons (requires sharp-cli: npm install -g sharp-cli)
npm run build:icon

# Build installer
npm run package
```

Output: `dist/YouDownload Setup 1.0.0.exe`

---

## Project Structure

```
YouDownload/
├── src/
│   ├── main/          # Electron main process (IPC, yt-dlp, electron-store)
│   ├── preload/       # Context bridge (exposes API to renderer)
│   └── renderer/      # React app
│       └── src/
│           ├── App.tsx           # Main component + all UI
│           ├── i18n.ts           # EN/RU translations
│           ├── storage.ts        # Persistent state via IPC
│           ├── globals.css       # FleetWatch theme
│           └── theme-apathy.css  # Vulnerable Apathy theme
├── resources/
│   └── icon.svg       # Source icon
├── build/             # Generated icons (icon.ico, icon.png)
├── scripts/
│   └── gen-icon.mjs   # Icon generation script
└── bin/               # yt-dlp binary (downloaded on first launch)
```

---

## License

MIT — feel free to fork, modify, and distribute.
