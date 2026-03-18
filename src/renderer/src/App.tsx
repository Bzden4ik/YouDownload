import { useState, useEffect, useCallback, useRef } from 'react'
import { type Lang, type Translations, translations } from './i18n'
import { loadState, saveState, loadHistory, appendHistory, clearHistory, type PersistedDownload } from './storage'

// ═══════════════════════ TYPES ═══════════════════════

interface VideoFormat {
  format_id: string
  ext?: string
  height?: number
  width?: number
  vcodec?: string
  acodec?: string
  tbr?: number
  filesize?: number
}

interface VideoInfo {
  id: string; title: string; thumbnail?: string; duration?: number
  view_count?: number; uploader?: string; description?: string; webpage_url?: string
  formats?: VideoFormat[]
}
interface PlaylistEntry { id: string; title: string; url?: string; webpage_url?: string; thumbnail?: string; duration?: number }

type DownloadStatus = 'pending' | 'downloading' | 'processing' | 'complete' | 'error' | 'cancelled'
type FormatType = 'video' | 'audio'
type VideoQuality = '2160' | '1440' | '1080' | '720' | '480' | '360' | '240' | '144'
type TwitchQuality = 'source' | '1080p60' | '720p60' | '480p' | '360p' | '160p'
type AudioQuality = 'mp3_best' | 'mp3_192' | 'mp3_128' | 'm4a'
type Theme = 'fleet' | 'apathy'
type View = 'download' | 'history' | 'settings'

interface UpdateInfo {
  hasUpdate?: boolean
  currentVersion?: string
  latestVersion?: string
  releaseName?: string
  downloadUrl?: string
  assetName?: string
  assetSize?: number
  error?: string
}
type Platform = 'youtube' | 'twitch'

interface DownloadItem { id: string; url: string; title: string; thumbnail?: string; formatLabel: string; status: DownloadStatus; progress: number; speed?: string; eta?: string; error?: string; createdAt: number }
interface AppSettings { downloadPath: string; defaultFormat: string; defaultQuality: string; concurrentDownloads: number; cookiesFromBrowser: string; cookiesFile: string }

// ═══════════════════════ HELPERS ═══════════════════════

const genId = () => `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const isPlaylistUrl = (url: string) => /[?&]list=/.test(url)

function isCookieError(err: string): boolean {
  const l = err.toLowerCase()
  return l.includes('cookie') || l.includes('sign in') || l.includes('login') || l.includes('403')
    || l.includes('age-restricted') || l.includes('private') || l.includes('members')
    || l.includes('dpapi') || l.includes('chrome cookie') || l.includes('could not copy')
    || l.includes('requires authentication') || l.includes('confirm your age') || l.includes('not available')
}

function formatDur(s?: number): string {
  if (!s) return '--:--'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`
}

function formatViews(n: number | undefined, t: Translations): string {
  if (!n) return ''
  if (n >= 1_000_000) return `${(n/1_000_000).toFixed(1)}M ${t.views}`
  if (n >= 1_000) return `${(n/1_000).toFixed(0)}K ${t.views}`
  return `${n} ${t.views}`
}

function detectPlatform(url: string): Platform { return url.includes('twitch.tv') ? 'twitch' : 'youtube' }

function isTwitchChannelUrl(url: string): boolean {
  if (!url.includes('twitch.tv')) return false
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    if (!parts.length || parts[0] === 'videos') return false
    if (parts.length === 1) return true
    if (parts.length === 2 && (parts[1] === 'videos' || parts[1] === 'clips')) return true
    return false
  } catch { return false }
}

function getTwitchChannelName(url: string): string {
  try { return new URL(url).pathname.split('/').filter(Boolean)[0] ?? '' } catch { return '' }
}

/** Extract available video heights from yt-dlp formats, sorted desc */
function getAvailableQualities(formats?: VideoFormat[]): VideoQuality[] {
  const ALL: VideoQuality[] = ['2160', '1440', '1080', '720', '480', '360', '240', '144']
  if (!formats || formats.length === 0) return ALL

  // Collect all unique heights that have a video stream
  const heights = new Set<number>()
  for (const f of formats) {
    if (f.height && f.vcodec && f.vcodec !== 'none') {
      heights.add(f.height)
    }
  }
  if (heights.size === 0) return ALL

  const maxH = Math.max(...heights)

  // Return all standard qualities up to the max available
  return ALL.filter(q => parseInt(q) <= maxH)
}

function getFormatArgs(type: FormatType, quality: VideoQuality | AudioQuality): string[] {
  if (type === 'audio') {
    const map: Record<AudioQuality, string[]> = {
      mp3_best: ['-f','bestaudio','-x','--audio-format','mp3','--audio-quality','0'],
      mp3_192:  ['-f','bestaudio','-x','--audio-format','mp3','--audio-quality','192K'],
      mp3_128:  ['-f','bestaudio','-x','--audio-format','mp3','--audio-quality','128K'],
      m4a:      ['-f','bestaudio[ext=m4a]/bestaudio'],
    }
    return map[quality as AudioQuality] ?? map.mp3_best
  }
  const q = quality as VideoQuality
  return ['-f',`bestvideo[height<=${q}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${q}]+bestaudio/bestvideo+bestaudio`,'--merge-output-format','mp4']
}

function getFormatLabel(type: FormatType, quality: VideoQuality | AudioQuality): string {
  if (type === 'audio') {
    const m: Record<AudioQuality,string> = { mp3_best:'MP3 · Best', mp3_192:'MP3 · 192k', mp3_128:'MP3 · 128k', m4a:'M4A · Best' }
    return m[quality as AudioQuality] ?? 'Audio'
  }
  const m: Record<VideoQuality,string> = { '2160':'4K · UHD','1440':'1440p · 2K','1080':'1080p · FHD','720':'720p · HD','480':'480p · SD','360':'360p','240':'240p','144':'144p' }
  return m[quality as VideoQuality] ?? quality
}

function getTwitchFormatArgs(type: FormatType, quality: TwitchQuality): string[] {
  if (type === 'audio') return ['-f','audio_only/bestaudio','-x','--audio-format','mp3','--audio-quality','0']
  const map: Record<TwitchQuality,string> = { source:'best', '1080p60':'1080p60/1080p/best', '720p60':'720p60/720p/best', '480p':'480p/best', '360p':'360p/best', '160p':'160p/best' }
  return ['-f', map[quality]]
}

function getTwitchFormatLabel(type: FormatType, quality: TwitchQuality): string {
  if (type === 'audio') return 'MP3 · Best'
  const m: Record<TwitchQuality,string> = { source:'Source', '1080p60':'1080p60', '720p60':'720p60', '480p':'480p', '360p':'360p', '160p':'160p' }
  return m[quality] ?? quality
}

// ═══════════════════════ WINDOW API TYPE ═══════════════════════

declare global {
  interface Window {
    api: {
      minimize: () => void; maximize: () => void; close: () => void
      getSettings: () => Promise<AppSettings>
      saveSettings: (s: AppSettings) => Promise<boolean>
      selectDownloadFolder: () => Promise<string | null>
      getAppState: () => Promise<Record<string, unknown>>
      saveAppState: (patch: Record<string, unknown>) => Promise<boolean>
      getHistory: () => Promise<PersistedDownload[]>
      appendHistory: (item: PersistedDownload) => Promise<boolean>
      clearHistory: () => Promise<boolean>
      checkYtDlp: () => Promise<{ exists: boolean; path: string }>
      setupYtDlp: () => Promise<{ success: boolean; error?: string }>
      updateYtDlp: () => Promise<{ success: boolean; error?: string }>
      detectBrowser: () => Promise<string | null>
      checkYtSession: () => Promise<{ loggedIn: boolean }>
      extractBrowserCookies: () => Promise<{ success: boolean; error?: string }>
      fetchVideoInfo: (url: string) => Promise<{ success: boolean; data?: VideoInfo; error?: string }>
      fetchPlaylistInfo: (url: string) => Promise<{ success: boolean; entries?: PlaylistEntry[]; error?: string }>
      fetchTwitchChannel: (channelName: string, type: 'vods' | 'clips') => Promise<{ success: boolean; entries?: PlaylistEntry[]; error?: string }>
      startDownload: (p: { id: string; url: string; formatArgs: string[]; downloadPath: string }) => Promise<{ success: boolean; error?: string }>
      cancelDownload: (id: string) => Promise<{ success: boolean }>
      openFolder: (path: string) => Promise<void>
      onDownloadProgress: (cb: (d: { id: string; progress: number; speed: string; eta: string }) => void) => () => void
      onDownloadComplete: (cb: (d: { id: string }) => void) => () => void
      onDownloadError: (cb: (d: { id: string; error: string }) => void) => () => void
      // Updates
      checkForUpdates: () => Promise<UpdateInfo>
      downloadAndInstallUpdate: (url: string, name: string) => Promise<{ success: boolean; error?: string }>
      onUpdateAvailable: (cb: (d: UpdateInfo) => void) => () => void
      onUpdateDownloadProgress: (cb: (pct: number) => void) => () => void
    }
  }
}

// ═══════════════════════ STAR LOGO ═══════════════════════

function StarLogo({ size = 32, cls = '' }: { size?: number; cls?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={cls} fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="16" cy="16" r="14.5" stroke="currentColor" strokeWidth="0.8" opacity="0.35"/>
      <circle cx="16" cy="16" r="11" stroke="currentColor" strokeWidth="0.4" opacity="0.2"/>
      <path d="M16 1.5 L17.8 14.2 L30.5 16 L17.8 17.8 L16 30.5 L14.2 17.8 L1.5 16 L14.2 14.2 Z" fill="currentColor"/>
    </svg>
  )
}

// ═══════════════════════ TITLE BAR ═══════════════════════

function TitleBar() {
  return (
    <div className="titlebar">
      <div className="titlebar-drag">
        <StarLogo size={14} cls="tb-star"/>
        <span className="tb-name">YouDownload</span>
      </div>
      <div className="titlebar-controls">
        <button className="wc-btn wc-min" onClick={() => window.api?.minimize()} aria-label="Minimize">
          <svg width="11" height="1" viewBox="0 0 11 1"><rect width="11" height="1.2" fill="currentColor"/></svg>
        </button>
        <button className="wc-btn wc-max" onClick={() => window.api?.maximize()} aria-label="Maximize">
          <svg width="11" height="11" viewBox="0 0 11 11"><rect x=".5" y=".5" width="10" height="10" stroke="currentColor" strokeWidth="1.1" fill="none"/></svg>
        </button>
        <button className="wc-btn wc-close" onClick={() => window.api?.close()} aria-label="Close">
          <svg width="11" height="11" viewBox="0 0 11 11">
            <line x1=".5" y1=".5" x2="10.5" y2="10.5" stroke="currentColor" strokeWidth="1.2"/>
            <line x1="10.5" y1=".5" x2=".5" y2="10.5" stroke="currentColor" strokeWidth="1.2"/>
          </svg>
        </button>
      </div>
    </div>
  )
}

// ═══════════════════════ SIDEBAR ═══════════════════════

function Sidebar({ view, onChange, activeCount, lang, onLangToggle }: {
  view: View; onChange: (v: View) => void; activeCount: number; lang: Lang; onLangToggle: () => void
}) {
  const t = translations[lang]
  const NAV: { id: View; label: string; icon: JSX.Element }[] = [
    { id:'download', label:t.nav_download, icon:<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 16l-4-4h2.5V4h3v8H16l-4 4z"/><path d="M20 18H4"/></svg> },
    { id:'history',  label:t.nav_history,  icon:<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg> },
    { id:'settings', label:t.nav_settings, icon:<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg> },
  ]
  return (
    <aside className="sidebar">
      <div className="sb-logo">
        <StarLogo size={30} cls="sb-star"/>
        <div className="sb-wordmark"><span className="sb-you">YOU</span><span className="sb-dl">DOWNLOAD</span></div>
      </div>
      <div className="sb-divider"/>
      <nav className="sb-nav">
        {NAV.map(item => (
          <button key={item.id} className={`sb-item ${view===item.id?'sb-item-active':''}`} onClick={() => onChange(item.id)}>
            <span className="sb-indicator"/><span className="sb-icon">{item.icon}</span>
            <span className="sb-label">{item.label}</span>
            {item.id==='download' && activeCount>0 && <span className="sb-badge">{activeCount}</span>}
          </button>
        ))}
      </nav>
      <div className="sb-footer">
        <button className="lang-toggle" onClick={onLangToggle}>
          <span className={`lang-opt ${lang==='en'?'lang-opt-on':''}`}>EN</span>
          <span className="lang-sep"/>
          <span className={`lang-opt ${lang==='ru'?'lang-opt-on':''}`}>RU</span>
        </button>
        <div className="sb-status-row"><span className="sb-dot"/><span className="sb-ready">{t.status_ready}</span></div>
        <div className="sb-version">v1.0.2</div>
      </div>
    </aside>
  )
}

// ═══════════════════════ URL INPUT ═══════════════════════

function UrlInput({ onFetch, loading, t, platform, onPlatformChange }: {
  onFetch: (url: string) => void; loading: boolean; t: Translations; platform: Platform; onPlatformChange: (p: Platform) => void
}) {
  const [url, setUrl] = useState('')
  const submit = () => { if (url.trim() && !loading) onFetch(url.trim()) }
  const handleChange = (val: string) => { setUrl(val); const d = detectPlatform(val); if (d !== platform) onPlatformChange(d) }
  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      handleChange(text)
      if (text.includes('youtube.com') || text.includes('youtu.be') || text.includes('music.youtube') || text.includes('twitch.tv'))
        setTimeout(() => onFetch(text.trim()), 80)
    } catch { /* blocked */ }
  }
  const placeholder = platform === 'twitch' ? 'https://twitch.tv/channelname  or  twitch.tv/videos/...' : 'https://youtube.com/watch?v=...'
  return (
    <div className="url-section">
      <div className="platform-switcher">
        <button className={`platform-btn ${platform==='youtube'?'platform-btn-on':''}`} onClick={() => onPlatformChange('youtube')}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8zM9.7 15.5V8.5l6.3 3.5-6.3 3.5z"/></svg>
          YouTube
        </button>
        <button className={`platform-btn ${platform==='twitch'?'platform-btn-on platform-btn-twitch':''}`} onClick={() => onPlatformChange('twitch')}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M11.6 6H13v4.5h-1.4V6zm3.8 0H17v4.5h-1.4V6zM2.2 0L0 5.4V21h5.4v3h3l3-3h4.5L24 12.6V0H2.2zm20.4 11.7-3.6 3.6h-5.4l-3 3v-3H5.4V1.4h17.2v10.3z"/></svg>
          Twitch
        </button>
      </div>
      <div className="section-eyebrow"><span className="eyebrow-line"/><span>{t.paste_url}</span><span className="eyebrow-line"/></div>
      <div className="url-row">
        <div className="url-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></div>
        <input type="text" value={url} onChange={e => handleChange(e.target.value)} onKeyDown={e => e.key==='Enter' && submit()} className="url-input" placeholder={placeholder} spellCheck={false} autoComplete="off"/>
        <button className="btn-paste" onClick={pasteFromClipboard}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>{t.btn_paste}</span></button>
        <button className="btn-fetch" onClick={submit} disabled={!url.trim() || loading}>
          {loading ? <span className="spin"/> : <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><span>{t.btn_fetch}</span></>}
        </button>
      </div>
      <p className="url-hint">{platform==='twitch' ? t.twitch_hint : t.url_hint}</p>
    </div>
  )
}

// ═══════════════════════ VIDEO INFO CARD ═══════════════════════

function VideoInfoCard({ info, loading, t }: { info: VideoInfo | null; loading: boolean; t: Translations }) {
  if (loading) return (
    <div className="vi-card vi-skeleton">
      <div className="skel-thumb"/><div className="skel-body"><div className="skel-line w80"/><div className="skel-line w55"/><div className="skel-line w35"/></div>
    </div>
  )
  if (!info) return null
  return (
    <div className="vi-card">
      <div className="vi-thumb-wrap">
        {info.thumbnail ? <img src={info.thumbnail} alt="" className="vi-thumb"/> : <div className="vi-thumb-ph"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>}
        <div className="vi-dur">{formatDur(info.duration)}</div>
      </div>
      <div className="vi-meta">
        <h3 className="vi-title">{info.title}</h3>
        <div className="vi-stats">
          {info.uploader && <span className="vi-channel">@{info.uploader}</span>}
          {info.view_count ? <><span className="vi-dot">·</span><span className="vi-views">{formatViews(info.view_count, t)}</span></> : null}
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════ FORMAT SELECTOR ═══════════════════════

function FormatSelector({ onDownload, onDownloadAll, disabled, t, initType, initVq, initAq, onFormatChange, playlist, platform, availableQualities }: {
  onDownload: (type: FormatType, q: string) => void; onDownloadAll?: (type: FormatType, q: string) => void
  disabled: boolean; t: Translations; initType: FormatType; initVq: VideoQuality; initAq: AudioQuality
  onFormatChange: (type: FormatType, vq: VideoQuality, aq: AudioQuality) => void
  playlist?: PlaylistEntry[] | null; platform?: Platform
  availableQualities?: VideoQuality[]
}) {
  const [ftype, setFtype] = useState<FormatType>(initType)
  const [vq, setVq] = useState<VideoQuality>(initVq)
  const [aq, setAq] = useState<AudioQuality>(initAq)
  const [tq, setTq] = useState<TwitchQuality>('source')
  const isTwitch = platform === 'twitch'
  const setFtypeAndSave = (v: FormatType) => { setFtype(v); onFormatChange(v, vq, aq) }
  const setVqAndSave = (v: VideoQuality) => { setVq(v); onFormatChange(ftype, v, aq) }
  const setAqAndSave = (v: AudioQuality) => { setAq(v); onFormatChange(ftype, vq, v) }

  // Full list with labels
  const ALL_VQ: { v: VideoQuality; l: string; b: string }[] = [
    { v:'2160', l:'4K',    b:'UHD' },
    { v:'1440', l:'1440p', b:'2K'  },
    { v:'1080', l:'1080p', b:'FHD' },
    { v:'720',  l:'720p',  b:'HD'  },
    { v:'480',  l:'480p',  b:'SD'  },
    { v:'360',  l:'360p',  b:''    },
    { v:'240',  l:'240p',  b:''    },
    { v:'144',  l:'144p',  b:''    },
  ]

  // Filter to only available qualities (if provided), else show all
  const VQ = availableQualities && availableQualities.length > 0
    ? ALL_VQ.filter(q => availableQualities.includes(q.v))
    : ALL_VQ

  // If current vq is not in filtered list — snap to best available
  const safeVq: VideoQuality = VQ.find(q => q.v === vq) ? vq : (VQ[0]?.v ?? '1080')

  const TQ = [{ v:'source' as TwitchQuality, l:'Source', b:'MAX' },{ v:'1080p60' as TwitchQuality, l:'1080p', b:'60fps' },{ v:'720p60' as TwitchQuality, l:'720p', b:'60fps' },{ v:'480p' as TwitchQuality, l:'480p', b:'' },{ v:'360p' as TwitchQuality, l:'360p', b:'' },{ v:'160p' as TwitchQuality, l:'160p', b:'' }]
  const AQ = [{ v:'mp3_best' as AudioQuality, f:'MP3', s:'Best' },{ v:'mp3_192' as AudioQuality, f:'MP3', s:'192 kbps' },{ v:'mp3_128' as AudioQuality, f:'MP3', s:'128 kbps' },{ v:'m4a' as AudioQuality, f:'M4A', s:'Best' }]
  const go = () => onDownload(ftype, isTwitch ? (ftype==='video'?tq:'mp3_best') : (ftype==='video'?safeVq:aq))
  const ql = isTwitch ? (ftype==='video'?TQ.find(q=>q.v===tq)?.l:'MP3') : (ftype==='video'?VQ.find(q=>q.v===safeVq)?.l:AQ.find(q=>q.v===aq)?.s)

  return (
    <div className="fmt-section">
      <div className="fmt-tabs">
        <button className={`fmt-tab ${ftype==='video'?'fmt-tab-on':''}`} onClick={() => setFtypeAndSave('video')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>{t.fmt_video}
        </button>
        <button className={`fmt-tab ${ftype==='audio'?'fmt-tab-on':''}`} onClick={() => setFtypeAndSave('audio')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>{t.fmt_audio}
        </button>
      </div>
      <div className="quality-grid">
        {ftype==='audio' ? AQ.map(q=><button key={q.v} className={`q-btn ${aq===q.v?'q-btn-on':''}`} onClick={()=>setAqAndSave(q.v)}><span className="q-main">{q.f}</span><span className="q-sub">{q.s}</span></button>)
         : isTwitch ? TQ.map(q=><button key={q.v} className={`q-btn ${tq===q.v?'q-btn-on':''}`} onClick={()=>setTq(q.v)}><span className="q-main">{q.l}</span>{q.b&&<span className="q-badge">{q.b}</span>}</button>)
         : VQ.map(q=><button key={q.v} className={`q-btn ${safeVq===q.v?'q-btn-on':''}`} onClick={()=>setVqAndSave(q.v)}><span className="q-main">{q.l}</span>{q.b&&<span className="q-badge">{q.b}</span>}</button>)}
      </div>
      <button className="dl-now-btn" onClick={go} disabled={disabled}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 16l-4-4h2.5V4h3v8H16l-4 4z"/><path d="M20 18H4"/></svg>
        <span>{ftype==='audio'?t.btn_download_audio:t.btn_download_video}</span>
        <span className="dl-now-q">{ql}</span>
      </button>
      {playlist && playlist.length>1 && onDownloadAll && (
        <button className="dl-all-btn" onClick={()=>onDownloadAll(ftype,ftype==='video'?vq:aq)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
          <span>{t.playlist_download_all}</span><span className="dl-now-q">{playlist.length} {t.playlist_count}</span>
        </button>
      )}
    </div>
  )
}

// ═══════════════════════ TWITCH CHANNEL BROWSER ═══════════════════════

interface TwitchSelected { entry: PlaylistEntry; url: string; tab: 'vods'|'clips' }

function TwitchChannelBrowser({ channelName, t, onSelect, onDownloadMulti }: {
  channelName: string; t: Translations
  onSelect: (entry: PlaylistEntry, url: string) => void
  onDownloadMulti: (items: TwitchSelected[]) => void
}) {
  const [tab, setTab] = useState<'vods'|'clips'>('vods')
  const [allEntries, setAllEntries] = useState<Record<string, PlaylistEntry[]>>({ vods:[], clips:[] })
  const [loading, setLoading] = useState(false)
  const loadedRef = useRef<Record<string,boolean>>({})
  const [selected, setSelected] = useState<Record<string, TwitchSelected>>({})

  const load = async (type: 'vods'|'clips') => {
    if (loadedRef.current[type]) return
    loadedRef.current[type] = true  // помечаем сразу — нет stale closure
    setLoading(true)
    const r = await window.api?.fetchTwitchChannel(channelName, type)
    setAllEntries(p => ({...p, [type]: r?.success && r.entries ? r.entries : []}))
    setLoading(false)
  }

  useEffect(() => {
    loadedRef.current = {}  // сбрасываем кеш при смене канала
    setAllEntries({ vods:[], clips:[] })
    setTab('vods')
    load('vods')
  }, [channelName])
  const switchTab = (type: 'vods'|'clips') => { setTab(type); load(type) }

  const toggleSelect = (entry: PlaylistEntry, url: string) => {
    setSelected(p => {
      if (p[entry.id]) { const n = {...p}; delete n[entry.id]; return n }
      return {...p, [entry.id]: { entry, url, tab }}
    })
  }

  const selectedList = Object.values(selected)
  const entries = allEntries[tab]

  return (
    <div className="twitch-browser">
      <div className="twitch-browser-head">
        <div className="twitch-channel-name">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="#9146FF"><path d="M11.6 6H13v4.5h-1.4V6zm3.8 0H17v4.5h-1.4V6zM2.2 0L0 5.4V21h5.4v3h3l3-3h4.5L24 12.6V0H2.2zm20.4 11.7-3.6 3.6h-5.4l-3 3v-3H5.4V1.4h17.2v10.3z"/></svg>
          <span>{channelName}</span>
        </div>
        <div className="twitch-tabs">
          <button className={`twitch-tab ${tab==='vods'?'twitch-tab-on':''}`} onClick={() => switchTab('vods')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            {t.twitch_channel_vods}
            {Object.values(selected).filter(s=>s.tab==='vods').length > 0 && (
              <span className="twitch-tab-badge">{Object.values(selected).filter(s=>s.tab==='vods').length}</span>
            )}
          </button>
          <button className={`twitch-tab ${tab==='clips'?'twitch-tab-on':''}`} onClick={() => switchTab('clips')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="20" y1="14" x2="4" y2="14"/><line x1="4" y1="10" x2="20" y2="10"/></svg>
            {t.twitch_channel_clips}
            {Object.values(selected).filter(s=>s.tab==='clips').length > 0 && (
              <span className="twitch-tab-badge">{Object.values(selected).filter(s=>s.tab==='clips').length}</span>
            )}
          </button>
        </div>
      </div>

      {/* Панель выбранных */}
      {selectedList.length > 0 && (
        <div className="twitch-selection-bar">
          <span className="twitch-sel-count">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            {t.twitch_selected}: <b>{selectedList.length}</b>
          </span>
          <div className="twitch-sel-actions">
            <button className="twitch-sel-clear" onClick={() => setSelected({})}>
              {t.twitch_sel_clear}
            </button>
            <button className="twitch-sel-download" onClick={() => onDownloadMulti(selectedList)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 16l-4-4h2.5V4h3v8H16l-4 4z"/><path d="M20 18H4"/></svg>
              {t.twitch_sel_download}
            </button>
          </div>
        </div>
      )}

      <div className="twitch-list">
        {loading && <div className="twitch-loading"><span className="spin"/><span>{t.twitch_loading}</span></div>}
        {!loading && entries.length===0 && loadedRef.current[tab] && <div className="twitch-empty">{t.twitch_empty}</div>}
        {entries.map(entry => {
          const videoUrl = entry.url || entry.webpage_url || `https://www.twitch.tv/videos/${entry.id}`
          const isSelected = !!selected[entry.id]
          return (
            <div key={entry.id} className={`twitch-entry ${isSelected?'twitch-entry-selected':''}`}>
              <button className={`twitch-checkbox ${isSelected?'twitch-checkbox-on':''}`} onClick={() => toggleSelect(entry, videoUrl)} title="Выбрать">
                {isSelected && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
              </button>
              <button className="twitch-entry-inner" onClick={() => onSelect(entry, videoUrl)}>
                <div className="twitch-entry-thumb">
                  {entry.thumbnail ? <img src={entry.thumbnail} alt=""/> : <div className="twitch-entry-thumb-ph"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>}
                  {entry.duration && <span className="twitch-entry-dur">{formatDur(entry.duration)}</span>}
                </div>
                <div className="twitch-entry-meta"><span className="twitch-entry-title">{entry.title}</span></div>
                <svg className="twitch-entry-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════ DOWNLOAD CARD ═══════════════════════

const STATUS_COLOR: Record<DownloadStatus,string> = { pending:'#60A5FA', downloading:'#4ADE80', processing:'#FACC15', complete:'#4ADE80', error:'#EF4444', cancelled:'#475569' }
const STATUS_LABEL = (t: Translations): Record<DownloadStatus,string> => ({ pending:t.st_pending, downloading:t.st_downloading, processing:t.st_processing, complete:t.st_complete, error:t.st_error, cancelled:t.st_cancelled })

function DownloadCard({ item, onCancel, onOpen, onCookieHint, t }: {
  item: DownloadItem; onCancel: (id: string) => void; onOpen: (id: string) => void; onCookieHint: () => void; t: Translations
}) {
  const c = STATUS_COLOR[item.status]
  const labels = STATUS_LABEL(t)
  const showBar = item.status==='downloading' || item.status==='processing' || item.status==='complete'
  return (
    <div className={`dl-card dl-${item.status}`}>
      {item.thumbnail && <img src={item.thumbnail} alt="" className="dl-thumb"/>}
      <div className="dl-body">
        <div className="dl-top">
          <span className="dl-title" title={item.title}>{item.title}</span>
          <div className="dl-acts">
            {(item.status==='downloading'||item.status==='pending') && <button className="dl-act" onClick={()=>onCancel(item.id)} title="Cancel"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></button>}
            {item.status==='complete' && <button className="dl-act dl-act-open" onClick={()=>onOpen(item.id)} title="Open folder"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button>}
          </div>
        </div>
        <div className="dl-info-row">
          <span className="dl-fmt">{item.formatLabel}</span>
          <span className="dl-status-tag" style={{color:c}}><span className="dl-sdot" style={{background:c}}/>{labels[item.status]}</span>
          {item.speed && <span className="dl-speed">{item.speed}</span>}
          {item.eta && <span className="dl-eta">{t.eta} {item.eta}</span>}
          {item.status==='downloading' && <span className="dl-pct">{Math.round(item.progress)}%</span>}
        </div>
        {showBar && (
          <div className="dl-track">
            <div className="dl-bar" style={{width:`${item.status==='complete'?100:item.progress}%`,background:c}}/>
            {item.status==='downloading' && <div className="dl-glow" style={{left:`${item.progress}%`,background:c}}/>}
          </div>
        )}
        {item.error && (
          <div className="dl-err-wrap">
            <span className="dl-err">{item.error}</span>
            {isCookieError(item.error) && (
              <button className="dl-cookie-hint" onClick={onCookieHint}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                {t.err_cookie_hint}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════ HISTORY VIEW ═══════════════════════

function HistoryView({ downloads, t, onClear }: { downloads: DownloadItem[]; t: Translations; onClear: () => void }) {
  const done = downloads.filter(d => ['complete','error','cancelled'].includes(d.status))
  if (!done.length) return <div className="hist-empty"><StarLogo size={52} cls="hist-empty-star"/><p>{t.hist_empty}</p></div>
  return (
    <div className="hist-view">
      <div className="hist-head">
        <h2 className="section-title">{t.hist_title}</h2>
        <span className="hist-count">{done.length} {t.hist_items}</span>
        <button className="hist-clear" onClick={onClear}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>{t.hist_clear}</button>
      </div>
      <div className="hist-list">
        {done.map(d => (
          <div key={d.id} className={`hist-item hist-${d.status}`}>
            {d.thumbnail && <img src={d.thumbnail} alt="" className="hist-thumb"/>}
            <div className="hist-meta"><span className="hist-title">{d.title}</span><span className="hist-fmt">{d.formatLabel}</span></div>
            <span className="hist-icon" style={{color:STATUS_COLOR[d.status]}}>{d.status==='complete'?'✓':d.status==='error'?'✗':'–'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════ GLOW ORBS ═══════════════════════

function GlowOrbs() {
  return <div className="ap-orbs" aria-hidden><div className="ap-orb ap-orb-1"/><div className="ap-orb ap-orb-2"/><div className="ap-orb ap-orb-3"/></div>
}

// ═══════════════════════ THEME CARDS ═══════════════════════

function ThemeCards({ current, onChange, t }: { current: Theme; onChange: (th: Theme) => void; t: Translations }) {
  return (
    <div className="theme-cards">
      <button className={`theme-card ${current==='fleet'?'theme-card-on':''}`} onClick={() => onChange('fleet')}>
        <div className="tc-preview tc-fleet">
          <div className="tc-fleet-sb"><div className="tc-fleet-dot"/><div className="tc-fleet-line active"/><div className="tc-fleet-line"/><div className="tc-fleet-line"/></div>
          <div className="tc-fleet-main"><div className="tc-fleet-bar"><div className="tc-fleet-bar-fill"/></div><div className="tc-fleet-accent"/><div className="tc-fleet-bar" style={{width:'70%'}}><div className="tc-fleet-bar-fill" style={{width:'35%',background:'#38BDF8'}}/></div></div>
        </div>
        <div className="tc-footer"><span className="tc-name">{t.theme_fleet}</span><span className="tc-check"><svg viewBox="0 0 10 8" fill="none"><polyline points="1 4 3.5 6.5 9 1" stroke="#000" strokeWidth="1.5" strokeLinecap="round"/></svg></span></div>
      </button>
      <button className={`theme-card ${current==='apathy'?'theme-card-on':''}`} onClick={() => onChange('apathy')}>
        <div className="tc-preview tc-apathy">
          <div className="tc-ap-orb1"/><div className="tc-ap-orb2"/>
          <div className="tc-ap-sb"><div className="tc-ap-dot"/><div className="tc-ap-line active"/><div className="tc-ap-line"/><div className="tc-ap-line"/></div>
          <div className="tc-ap-main"><div className="tc-ap-bar"><div className="tc-ap-bar-fill"/></div><div className="tc-ap-accent"/><div className="tc-ap-bar" style={{width:'70%'}}><div className="tc-ap-bar-fill" style={{width:'35%',background:'#4D7CFF'}}/></div></div>
        </div>
        <div className="tc-footer"><span className="tc-name">{t.theme_apathy}</span><span className="tc-check"><svg viewBox="0 0 10 8" fill="none"><polyline points="1 4 3.5 6.5 9 1" stroke="#000" strokeWidth="1.5" strokeLinecap="round"/></svg></span></div>
      </button>
    </div>
  )
}

// ═══════════════════════ SETTINGS VIEW ═══════════════════════

function SettingsView({ settings, onSave, onPickFolder, t, theme, onThemeChange, highlightCookies, autoCheckUpdates, onAutoCheckChange, onManualCheck }: {
  settings: AppSettings; onSave: (s: AppSettings) => void; onPickFolder: () => void
  t: Translations; theme: Theme; onThemeChange: (th: Theme) => void; highlightCookies: boolean
  autoCheckUpdates: boolean; onAutoCheckChange: (v: boolean) => void
  onManualCheck: () => void
}) {
  const [local, setLocal] = useState(settings)
  const [updateState, setUpdateState] = useState<'idle'|'busy'|'ok'|'fail'>('idle')
  const [checkState, setCheckState] = useState<'idle'|'busy'|'ok'>('idle')
  const [extractState, setExtractState] = useState<'idle'|'busy'|'ok'|'fail'>('idle')
  const [extractError, setExtractError] = useState('')
  const [ytLoggedIn, setYtLoggedIn] = useState(false)
  const cookiesRef = useRef<HTMLDivElement>(null)

  useEffect(() => { window.api?.checkYtSession().then(r => setYtLoggedIn(r.loggedIn)).catch(()=>{}) }, [])
  useEffect(() => { if (highlightCookies && cookiesRef.current) cookiesRef.current.scrollIntoView({ behavior:'smooth', block:'center' }) }, [highlightCookies])
  useEffect(() => setLocal(settings), [settings])

  const handleUpdate = async () => {
    setUpdateState('busy')
    const r = await window.api?.updateYtDlp()
    setUpdateState(r?.success?'ok':'fail')
    setTimeout(() => setUpdateState('idle'), 3000)
  }
  const handleManualCheck = async () => {
    setCheckState('busy')
    await onManualCheck()
    setCheckState('ok')
    setTimeout(() => setCheckState('idle'), 3000)
  }
  const handleExtract = async () => {
    if (local.cookiesFromBrowser==='none') return
    setExtractState('busy'); setExtractError('')
    const r = await window.api?.extractBrowserCookies()
    if (r?.success) { setExtractState('ok'); setYtLoggedIn(true) }
    else { setExtractState('fail'); setExtractError(r?.error||'') }
    setTimeout(() => setExtractState('idle'), 5000)
  }

  return (
    <div className="settings-view">
      <h2 className="section-title">{t.set_title}</h2>
      <div className="set-group"><div className="set-label">{t.set_theme}</div><ThemeCards current={theme} onChange={onThemeChange} t={t}/></div>
      <div className="set-group">
        <div className="set-label">{t.set_folder_label}</div>
        <div className="set-row"><input className="set-input" value={local.downloadPath} readOnly onChange={()=>{}}/><button className="set-browse" onClick={onPickFolder}>{t.set_folder_browse}</button></div>
      </div>
      <div className="set-group">
        <div className="set-label">{t.set_concurrent}</div>
        <div className="set-radios">{[1,2,3,5].map(n=><button key={n} className={`set-radio ${local.concurrentDownloads===n?'set-radio-on':''}`} onClick={()=>setLocal(p=>({...p,concurrentDownloads:n}))}>{n}</button>)}</div>
      </div>
      <div className="set-group">
        <div className="set-label">{t.set_cookies}</div>
        <p className="set-hint">{t.set_cookies_hint}</p>
        <div className="set-radios" style={{flexWrap:'wrap',gap:'6px'}}>
          {(['none','edge','firefox','brave'] as const).map(b=><button key={b} className={`set-radio ${local.cookiesFromBrowser===b?'set-radio-on':''}`} style={{minWidth:'64px',textTransform:'capitalize'}} onClick={()=>setLocal(p=>({...p,cookiesFromBrowser:b}))}>{b==='none'?'Off':b}</button>)}
        </div>
      </div>
      <div ref={cookiesRef} className={`set-group ${highlightCookies?'set-group-highlight':''}`}>
        <div className="set-label">{t.set_extract_cookies}</div>
        <p className="set-hint">{t.set_extract_cookies_hint}</p>
        <button className={`set-extract-btn ${extractState==='ok'?'set-extract-ok':extractState==='fail'?'set-extract-fail':''}`} onClick={handleExtract} disabled={extractState==='busy'}>
          {extractState==='busy' ? <><span className="spin"/>{t.set_extracting}</>
           : extractState==='ok' ? <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>{t.set_extract_ok}</>
           : extractState==='fail' ? <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>{t.set_extract_fail}</>
           : <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>{t.set_extract_cookies}{ytLoggedIn&&<span className="set-extract-browser">✓ signed in</span>}</>}
        </button>
        {extractState==='fail' && extractError && <p className="set-extract-error">{extractError}</p>}
      </div>
      <div className="set-group">
        <div className="set-label">{t.set_auto_update}</div>
        <div className="set-update-row">
          <button
            className={`set-toggle ${autoCheckUpdates ? 'set-toggle-on' : ''}`}
            onClick={() => onAutoCheckChange(!autoCheckUpdates)}
          >
            <span className="set-toggle-thumb"/>
          </button>
          <span className="set-toggle-label">{autoCheckUpdates ? 'ON' : 'OFF'}</span>
          <button
            className="set-check-btn"
            onClick={handleManualCheck}
            disabled={checkState === 'busy'}
          >
            {checkState === 'busy' ? <><span className="spin"/>{t.set_checking}</>
             : checkState === 'ok'  ? <span style={{color:'var(--g)'}}>{t.set_no_update}</span>
             : <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>{t.set_check_update}</>}
          </button>
        </div>
      </div>

      <button className="set-save" onClick={()=>onSave(local)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
        {t.set_save}
      </button>
      <button className="set-update-btn" onClick={handleUpdate} disabled={updateState==='busy'}>
        {updateState==='busy'?<><span className="spin"/>{t.set_updating}</>:updateState==='ok'?<span style={{color:'var(--g)'}}>{t.set_updated}</span>:updateState==='fail'?<span style={{color:'var(--r)'}}>{t.set_update_failed}</span>:<><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>{t.set_update_ytdlp}</>}
      </button>
    </div>
  )
}

// ═══════════════════════ UPDATE BANNER ═══════════════════════

function UpdateBanner({ info, t, onDismiss }: { info: UpdateInfo; t: Translations; onDismiss: () => void }) {
  const [countdown, setCountdown] = useState(15)
  const [dlProgress, setDlProgress] = useState(-1)
  const [visible, setVisible] = useState(false)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopCountdown = () => {
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null }
  }

  useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)))

    countdownRef.current = setInterval(() => setCountdown(n => {
      if (n <= 1) { stopCountdown(); onDismiss(); return 0 }
      return n - 1
    }), 1000)

    const unsub = window.api?.onUpdateDownloadProgress?.(pct => setDlProgress(pct))
    return () => { stopCountdown(); unsub?.() }
  }, [])

  const handleInstall = async () => {
    if (!info.downloadUrl) return
    stopCountdown()   // ← stop countdown when download starts
    setDlProgress(0)
    await window.api?.downloadAndInstallUpdate(info.downloadUrl, info.assetName ?? 'YouDownload-setup.exe')
  }

  const handleDismiss = () => {
    stopCountdown()
    setVisible(false)
    setTimeout(onDismiss, 400)
  }

  return (
    <div className={`upd-banner ${visible ? 'upd-banner-in' : ''}`}>
      <div className="upd-banner-glow"/>
      <div className="upd-banner-inner">
        <div className="upd-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
        </div>
        <div className="upd-content">
          <div className="upd-title">{t.upd_available}</div>
          <div className="upd-subtitle">
            {t.upd_version} <span className="upd-ver-old">{info.currentVersion}</span>
            {' → '}
            <span className="upd-ver-new">v{info.latestVersion}</span>
          </div>
          {dlProgress >= 0 && (
            <div className="upd-progress-wrap">
              <div className="upd-progress-bar" style={{ width: `${dlProgress}%` }}/>
              <span className="upd-progress-pct">{dlProgress}%</span>
            </div>
          )}
        </div>
        <div className="upd-actions">
          {dlProgress < 0 ? (
            <button className="upd-btn-install" onClick={handleInstall}>
              {t.upd_download}
            </button>
          ) : (
            <span className="upd-dl-label">{t.upd_downloading}</span>
          )}
          <button className="upd-btn-dismiss" onClick={handleDismiss}>
            {t.upd_dismiss}
            {dlProgress < 0 && <span className="upd-countdown"> {countdown}{t.upd_sec}</span>}
          </button>
        </div>
      </div>
      <div className="upd-timer-bar">
        <div className="upd-timer-fill" style={{ animationDuration: '15s' }}/>
      </div>
    </div>
  )
}

// ═══════════════════════ SETUP OVERLAY ═══════════════════════

function SetupOverlay({ onSetup, loading, error, t }: { onSetup: () => void; loading: boolean; error: string; t: Translations }) {
  return (
    <div className="setup-overlay">
      <div className="setup-card">
        <StarLogo size={72} cls="setup-star"/>
        <h1 className="setup-name">YouDownload</h1>
        <p className="setup-sub">{t.setup_sub}</p>
        {error && <div className="setup-err"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span>{error}</span></div>}
        {loading
          ? <div className="setup-loading"><span className="setup-spin"/><span>{t.setup_loading}</span></div>
          : <div className="setup-btns">
              <button className="setup-btn" onClick={onSetup}>{error?t.setup_retry:t.setup_init}</button>
              {error && <p className="setup-manual">{t.setup_manual}<br/><code>winget install yt-dlp</code></p>}
            </div>
        }
      </div>
    </div>
  )
}

// ═══════════════════════ MAIN APP ═══════════════════════

export default function App() {
  const [view, setView] = useState<View>('download')
  const [lang, setLang] = useState<Lang>('en')
  const [theme, setTheme] = useState<Theme>('fleet')
  const [initFmt, setInitFmt] = useState<{ type: FormatType; vq: VideoQuality; aq: AudioQuality }>({ type:'video', vq:'1080', aq:'mp3_best' })
  const [settings, setSettings] = useState<AppSettings>({ downloadPath:'', defaultFormat:'mp4', defaultQuality:'1080', concurrentDownloads:3, cookiesFromBrowser:'none', cookiesFile:'' })
  const [downloads, setDownloads] = useState<DownloadItem[]>([])
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null)
  const [fetching, setFetching] = useState(false)
  const [fetchErr, setFetchErr] = useState('')
  const [ready, setReady] = useState(false)
  const [showSetup, setShowSetup] = useState(false)
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupError, setSetupError] = useState('')
  const [highlightCookies, setHighlightCookies] = useState(false)
  const [playlist, setPlaylist] = useState<PlaylistEntry[] | null>(null)
  const [playlistLoading, setPlaylistLoading] = useState(false)
  const [platform, setPlatform] = useState<Platform>('youtube')
  const [twitchChannel, setTwitchChannel] = useState<string | null>(null)
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(true)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const urlRef = useRef('')
  const t = translations[lang]

  const toggleLang = () => { const n = lang==='en'?'ru':'en'; setLang(n as Lang); saveState({ lang: n as Lang }) }
  const handleThemeChange = (th: Theme) => { setTheme(th); saveState({ theme: th }); document.documentElement.setAttribute('data-theme', th==='apathy'?'apathy':'') }

  useEffect(() => {
    (async () => {
      if (!window.api) return
      const s = await loadState()
      setLang(s.lang); setTheme(s.theme ?? 'fleet')
      document.documentElement.setAttribute('data-theme', s.theme==='apathy'?'apathy':'')
      setInitFmt({ type:s.formatType, vq:s.videoQuality as VideoQuality, aq:s.audioQuality as AudioQuality })
      setAutoCheckUpdates(s.autoCheckUpdates !== false)
      const elSettings = await window.api.getSettings()
      setSettings({ ...elSettings, downloadPath:s.downloadPath||elSettings.downloadPath, concurrentDownloads:s.concurrentDownloads||elSettings.concurrentDownloads })
      const hist = await loadHistory()
      setDownloads(hist.map(h => ({ ...h, progress:100, speed:undefined, eta:undefined, error:undefined })))
      const { exists } = await window.api.checkYtDlp()
      if (exists) { setReady(true) } else { setShowSetup(true) }
    })()
  }, [])

  useEffect(() => {
    if (!window.api) return
    const u1 = window.api.onDownloadProgress(d => setDownloads(p => p.map(x => x.id===d.id ? {...x,progress:d.progress,speed:d.speed,eta:d.eta,status:'downloading'} : x)))
    const u2 = window.api.onDownloadComplete(d => setDownloads(p => {
      const updated = p.map(x => x.id===d.id ? {...x,status:'complete' as const,progress:100} : x)
      const item = updated.find(x => x.id===d.id)
      if (item) appendHistory({ id:item.id,url:item.url,title:item.title,thumbnail:item.thumbnail,formatLabel:item.formatLabel,status:'complete',createdAt:item.createdAt })
      return updated
    }))
    const u3 = window.api.onDownloadError(d => setDownloads(p => {
      const updated = p.map(x => x.id===d.id ? {...x,status:'error' as const,error:d.error} : x)
      const item = updated.find(x => x.id===d.id)
      if (item) appendHistory({ id:item.id,url:item.url,title:item.title,thumbnail:item.thumbnail,formatLabel:item.formatLabel,status:'error',createdAt:item.createdAt })
      return updated
    }))
    return () => { u1(); u2(); u3() }
  }, [])

  // Update listeners — push from main
  useEffect(() => {
    if (!window.api) return
    const unsub = window.api.onUpdateAvailable?.((info: UpdateInfo) => {
      if (autoCheckUpdates) setUpdateInfo(info)
    })
    return () => unsub?.()
  }, [autoCheckUpdates])

  // Auto-check on startup after app is loaded
  useEffect(() => {
    if (!autoCheckUpdates) return
    const timer = setTimeout(async () => {
      try {
        const r = await window.api?.checkForUpdates()
        if (r?.hasUpdate) setUpdateInfo(r)
      } catch { /* non-critical */ }
    }, 4000)   // 4s after component mount — renderer is definitely ready
    return () => clearTimeout(timer)
  }, [])  // run once on mount

  const handleAutoCheckChange = (v: boolean) => {
    setAutoCheckUpdates(v)
    saveState({ autoCheckUpdates: v })
  }

  const handleManualCheck = async () => {
    const r = await window.api?.checkForUpdates()
    if (r?.hasUpdate) setUpdateInfo(r)
    else setUpdateInfo(null)
    return r
  }

  const handleSetup = async () => {
    setSetupBusy(true); setSetupError('')
    try {
      const r = await window.api.setupYtDlp()
      if (r.success) { setReady(true); setShowSetup(false) }
      else setSetupError(r.error || 'Download failed. Check your internet connection.')
    } catch (err) { setSetupError(String(err)) }
    finally { setSetupBusy(false) }
  }

  const handleFetch = useCallback(async (url: string) => {
    if (!window.api || !ready) return
    setFetching(true); setFetchErr(''); setVideoInfo(null); setPlaylist(null); setTwitchChannel(null)
    urlRef.current = url
    setPlatform(detectPlatform(url))
    if (isTwitchChannelUrl(url)) { setFetching(false); setTwitchChannel(getTwitchChannelName(url)); return }
    const r = await window.api.fetchVideoInfo(url)
    setFetching(false)
    if (r.success && r.data) {
      setVideoInfo(r.data)
      if (isPlaylistUrl(url) && !url.includes('twitch.tv')) {
        setPlaylistLoading(true)
        window.api.fetchPlaylistInfo(url).then(pr => {
          if (pr.success && pr.entries && pr.entries.length>1) setPlaylist(pr.entries)
          setPlaylistLoading(false)
        }).catch(() => setPlaylistLoading(false))
      }
    } else { setFetchErr(r.error || 'Failed to fetch info') }
  }, [ready])

  const handleDownload = useCallback(async (type: FormatType, quality: string) => {
    if (!videoInfo || !window.api) return
    const id = genId()
    const isTwitch = platform === 'twitch'
    const formatArgs = isTwitch ? getTwitchFormatArgs(type, quality as TwitchQuality) : getFormatArgs(type, quality as VideoQuality | AudioQuality)
    const formatLabel = isTwitch ? getTwitchFormatLabel(type, quality as TwitchQuality) : getFormatLabel(type, quality as VideoQuality | AudioQuality)
    setDownloads(p => [{ id, url:urlRef.current, title:videoInfo.title, thumbnail:videoInfo.thumbnail, formatLabel, status:'pending', progress:0, createdAt:Date.now() }, ...p])
    let downloadUrl = urlRef.current
    if (!isTwitch && downloadUrl.includes('music.youtube.com') && type==='video') downloadUrl = downloadUrl.replace('music.youtube.com','www.youtube.com')
    const r = await window.api.startDownload({ id, url:downloadUrl, formatArgs, downloadPath:settings.downloadPath })
    if (!r.success) setDownloads(p => p.map(x => x.id===id ? {...x,status:'error',error:r.error} : x))
  }, [videoInfo, settings.downloadPath, platform])

  const handleDownloadAll = useCallback(async (type: FormatType, quality: string) => {
    if (!playlist || !window.api) return
    const formatArgs = getFormatArgs(type, quality as VideoQuality | AudioQuality)
    const formatLabel = getFormatLabel(type, quality as VideoQuality | AudioQuality)
    for (const entry of playlist) {
      const id = genId()
      const base = urlRef.current.includes('music.youtube') ? 'https://music.youtube.com' : 'https://www.youtube.com'
      const rawUrl = entry.url || entry.webpage_url || ''
      const videoUrl = rawUrl.startsWith('http') ? rawUrl : `${base}/watch?v=${entry.id}`
      setDownloads(p => [{ id, url:videoUrl, title:entry.title, thumbnail:entry.thumbnail, formatLabel, status:'pending', progress:0, createdAt:Date.now() }, ...p])
      window.api.startDownload({ id, url:videoUrl, formatArgs, downloadPath:settings.downloadPath })
    }
  }, [playlist, settings.downloadPath])

  const handleTwitchSelect = useCallback((entry: PlaylistEntry, url: string) => {
    setTwitchChannel(null)
    urlRef.current = url
    setVideoInfo({ id:entry.id, title:entry.title, thumbnail:entry.thumbnail, duration:entry.duration, webpage_url:url })
  }, [])

  const handleTwitchMulti = useCallback((items: TwitchSelected[]) => {
    if (!window.api) return
    // Для мульти-скачивания используем Source качество (лучшее)
    const formatArgs = getTwitchFormatArgs('video', 'source')
    const formatLabel = 'Source · Twitch'
    for (const { entry, url } of items) {
      const id = genId()
      setDownloads(p => [{ id, url, title:entry.title, thumbnail:entry.thumbnail, formatLabel, status:'pending', progress:0, createdAt:Date.now() }, ...p])
      window.api.startDownload({ id, url, formatArgs, downloadPath:settings.downloadPath })
    }
    setTwitchChannel(null)
  }, [settings.downloadPath])

  const handleCookieHint = useCallback(() => { setView('settings'); setHighlightCookies(true); setTimeout(() => setHighlightCookies(false), 2500) }, [])

  const handleCancel = useCallback(async (id: string) => {
    await window.api?.cancelDownload(id)
    setDownloads(p => {
      const updated = p.map(x => x.id===id ? {...x,status:'cancelled' as const} : x)
      const item = updated.find(x => x.id===id)
      if (item) appendHistory({ id:item.id,url:item.url,title:item.title,thumbnail:item.thumbnail,formatLabel:item.formatLabel,status:'cancelled',createdAt:item.createdAt })
      return updated
    })
  }, [])

  const handleOpen = useCallback(async () => { await window.api?.openFolder(settings.downloadPath) }, [settings.downloadPath])
  const handleSaveSettings = async (s: AppSettings) => { setSettings(s); await saveState({ downloadPath:s.downloadPath, concurrentDownloads:s.concurrentDownloads }); await window.api?.saveSettings(s) }
  const handlePickFolder = async () => { const p = await window.api?.selectDownloadFolder(); if (p) { setSettings(prev=>({...prev,downloadPath:p})); await saveState({ downloadPath:p }) } }
  const activeCount = downloads.filter(d => d.status==='downloading'||d.status==='pending').length

  return (
    <div className="app">
      {theme==='apathy' && <GlowOrbs/>}
      {showSetup && <SetupOverlay onSetup={handleSetup} loading={setupBusy} error={setupError} t={t}/>}
      {updateInfo?.hasUpdate && <UpdateBanner info={updateInfo} t={t} onDismiss={() => setUpdateInfo(null)}/>}
      <TitleBar/>
      <div className="app-body">
        <Sidebar view={view} onChange={setView} activeCount={activeCount} lang={lang} onLangToggle={toggleLang}/>
        <main className="main">
          {view==='download' && (
            <div className="dl-view">
              <UrlInput onFetch={handleFetch} loading={fetching} t={t} platform={platform} onPlatformChange={setPlatform}/>

              {fetchErr && <div className="fetch-err"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>{fetchErr}{isCookieError(fetchErr) && <button className="dl-cookie-hint" style={{marginLeft:'10px'}} onClick={handleCookieHint}>{t.err_cookie_hint}</button>}</div>}

              {/* Twitch channel browser */}
              {twitchChannel && (
                <TwitchChannelBrowser channelName={twitchChannel} t={t} onSelect={handleTwitchSelect} onDownloadMulti={handleTwitchMulti}/>
              )}

              {(videoInfo || fetching) && (
                <>
                  <VideoInfoCard info={videoInfo} loading={fetching} t={t}/>
                  {(playlistLoading || playlist) && (
                    <div className="playlist-banner">
                      <div className="playlist-banner-left">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                        {playlistLoading
                          ? <span className="playlist-loading-text">{t.playlist_loading}<span className="spin" style={{marginLeft:8}}/></span>
                          : <span>{t.playlist_detected} · <b>{playlist?.length}</b> {t.playlist_count}</span>}
                      </div>
                    </div>
                  )}
                  <FormatSelector key="fmt-selector" onDownload={handleDownload} onDownloadAll={handleDownloadAll} playlist={playlist} platform={platform} disabled={!videoInfo||fetching} t={t} initType={initFmt.type} initVq={initFmt.vq} initAq={initFmt.aq} onFormatChange={(type,vq,aq)=>saveState({formatType:type,videoQuality:vq,audioQuality:aq})} availableQualities={videoInfo ? getAvailableQualities(videoInfo.formats) : undefined}/>
                </>
              )}

              {downloads.length>0 && (
                <div className="queue-section">
                  <div className="queue-head"><span className="section-eyebrow-sm">{t.lbl_downloads}</span>{activeCount>0&&<span className="queue-badge">{activeCount} {t.lbl_active}</span>}</div>
                  <div className="queue-list">{downloads.slice(0,15).map(d=><DownloadCard key={d.id} item={d} onCancel={handleCancel} onOpen={handleOpen} onCookieHint={handleCookieHint} t={t}/>)}</div>
                </div>
              )}
            </div>
          )}
          {view==='history' && <HistoryView downloads={downloads} t={t} onClear={async()=>{ await clearHistory(); setDownloads(p=>p.filter(d=>d.status==='downloading'||d.status==='pending')) }}/>}
          {view==='settings' && <SettingsView settings={settings} onSave={handleSaveSettings} onPickFolder={handlePickFolder} t={t} theme={theme} onThemeChange={handleThemeChange} highlightCookies={highlightCookies} autoCheckUpdates={autoCheckUpdates} onAutoCheckChange={handleAutoCheckChange} onManualCheck={handleManualCheck}/>}
        </main>
      </div>
    </div>
  )
}
