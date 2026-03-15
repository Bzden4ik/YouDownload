import { useState, useEffect, useCallback, useRef } from 'react'
import { type Lang, type Translations, translations } from './i18n'
import {
  loadState, saveState, loadHistory, appendHistory, clearHistory,
  type PersistedDownload
} from './storage'

// ═══════════════════════ TYPES ═══════════════════════

interface VideoInfo {
  id: string
  title: string
  thumbnail?: string
  duration?: number
  view_count?: number
  uploader?: string
  description?: string
  webpage_url?: string
}

type DownloadStatus = 'pending' | 'downloading' | 'processing' | 'complete' | 'error' | 'cancelled'
type FormatType = 'video' | 'audio'
type VideoQuality = '2160' | '1440' | '1080' | '720' | '480' | '360'
type AudioQuality = 'mp3_best' | 'mp3_192' | 'mp3_128' | 'm4a'
type Theme = 'fleet' | 'apathy'
type View = 'download' | 'history' | 'settings'

interface DownloadItem {
  id: string
  url: string
  title: string
  thumbnail?: string
  formatLabel: string
  status: DownloadStatus
  progress: number
  speed?: string
  eta?: string
  error?: string
  createdAt: number
}

interface AppSettings {
  downloadPath: string
  defaultFormat: string
  defaultQuality: string
  concurrentDownloads: number
}

// ═══════════════════════ HELPERS ═══════════════════════

const genId = () => `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

function formatDur(s?: number): string {
  if (!s) return '--:--'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`
}

function formatViews(n: number | undefined, t: Translations): string {
  if (!n) return ''
  if (n >= 1_000_000) return `${(n/1_000_000).toFixed(1)}M ${t.views}`
  if (n >= 1_000)     return `${(n/1_000).toFixed(0)}K ${t.views}`
  return `${n} ${t.views}`
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
  if (quality === '2160') return ['-f','bestvideo[height<=2160]+bestaudio/best','--merge-output-format','mp4']
  if (quality === '1440') return ['-f','bestvideo[height<=1440]+bestaudio/best','--merge-output-format','mp4']
  if (quality === '1080') return ['-f','bestvideo[height<=1080]+bestaudio/best','--merge-output-format','mp4']
  if (quality === '720')  return ['-f','bestvideo[height<=720]+bestaudio/best','--merge-output-format','mp4']
  if (quality === '480')  return ['-f','bestvideo[height<=480]+bestaudio/best','--merge-output-format','mp4']
  return ['-f','bestvideo[height<=360]+bestaudio/best','--merge-output-format','mp4']
}

function getFormatLabel(type: FormatType, quality: VideoQuality | AudioQuality): string {
  if (type === 'audio') {
    const m: Record<AudioQuality, string> = {
      mp3_best: 'MP3 · Best', mp3_192: 'MP3 · 192k', mp3_128: 'MP3 · 128k', m4a: 'M4A · Best'
    }
    return m[quality as AudioQuality] ?? 'Audio'
  }
  const m: Record<VideoQuality, string> = {
    '2160':'4K · UHD','1440':'1440p · 2K','1080':'1080p · FHD','720':'720p · HD','480':'480p · SD','360':'360p'
  }
  return m[quality as VideoQuality] ?? quality
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
      fetchVideoInfo: (url: string) => Promise<{ success: boolean; data?: VideoInfo; error?: string }>
      startDownload: (p: { id: string; url: string; formatArgs: string[]; downloadPath: string }) => Promise<{ success: boolean; error?: string }>
      cancelDownload: (id: string) => Promise<{ success: boolean }>
      openFolder: (path: string) => Promise<void>
      onDownloadProgress: (cb: (d: { id: string; progress: number; speed: string; eta: string }) => void) => () => void
      onDownloadComplete: (cb: (d: { id: string }) => void) => () => void
      onDownloadError: (cb: (d: { id: string; error: string }) => void) => () => void
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
  view: View; onChange: (v: View) => void; activeCount: number
  lang: Lang; onLangToggle: () => void
}) {
  const t = translations[lang]
  const NAV_ITEMS: { id: View; label: string; icon: JSX.Element }[] = [
    {
      id: 'download', label: t.nav_download,
      icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 16l-4-4h2.5V4h3v8H16l-4 4z"/><path d="M20 18H4"/></svg>
    },
    {
      id: 'history', label: t.nav_history,
      icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg>
    },
    {
      id: 'settings', label: t.nav_settings,
      icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
    }
  ]
  return (
    <aside className="sidebar">
      <div className="sb-logo">
        <StarLogo size={30} cls="sb-star"/>
        <div className="sb-wordmark">
          <span className="sb-you">YOU</span>
          <span className="sb-dl">DOWNLOAD</span>
        </div>
      </div>

      <div className="sb-divider"/>

      <nav className="sb-nav">
        {NAV_ITEMS.map(item => (
          <button key={item.id} className={`sb-item ${view === item.id ? 'sb-item-active' : ''}`} onClick={() => onChange(item.id)}>
            <span className="sb-indicator"/>
            <span className="sb-icon">{item.icon}</span>
            <span className="sb-label">{item.label}</span>
            {item.id === 'download' && activeCount > 0 && (
              <span className="sb-badge">{activeCount}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="sb-footer">
        <button className="lang-toggle" onClick={onLangToggle} title="Switch language">
          <span className={`lang-opt ${lang === 'en' ? 'lang-opt-on' : ''}`}>EN</span>
          <span className="lang-sep"/>
          <span className={`lang-opt ${lang === 'ru' ? 'lang-opt-on' : ''}`}>RU</span>
        </button>
        <div className="sb-status-row">
          <span className="sb-dot"/>
          <span className="sb-ready">{t.status_ready}</span>
        </div>
        <div className="sb-version">v1.0.0</div>
      </div>
    </aside>
  )
}

// ═══════════════════════ URL INPUT ═══════════════════════

function UrlInput({ onFetch, loading, t }: { onFetch: (url: string) => void; loading: boolean; t: Translations }) {
  const [url, setUrl] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = () => { if (url.trim() && !loading) onFetch(url.trim()) }

  const pasteFromClipboard = async () => {
    try {
      const t = await navigator.clipboard.readText()
      if (t.includes('youtube.com') || t.includes('youtu.be') || t.includes('music.youtube')) {
        setUrl(t)
        setTimeout(() => onFetch(t.trim()), 80)
      } else {
        setUrl(t)
      }
    } catch { /* clipboard blocked */ }
  }

  return (
    <div className="url-section">
      <div className="section-eyebrow">
        <span className="eyebrow-line"/><span>{t.paste_url}</span><span className="eyebrow-line"/>
      </div>
      <div className="url-row">
        <div className="url-icon">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
        </div>
        <input
          ref={inputRef}
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          className="url-input"
          placeholder="https://youtube.com/watch?v=..."
          spellCheck={false}
          autoComplete="off"
        />
        <button className="btn-paste" onClick={pasteFromClipboard} title="Paste from clipboard">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          <span>{t.btn_paste}</span>
        </button>
        <button className="btn-fetch" onClick={submit} disabled={!url.trim() || loading}>
          {loading ? <span className="spin"/> : (
            <>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <span>{t.btn_fetch}</span>
            </>
          )}
        </button>
      </div>
      <p className="url-hint">{t.url_hint}</p>
    </div>
  )
}

// ═══════════════════════ VIDEO INFO CARD ═══════════════════════

function VideoInfoCard({ info, loading, t }: { info: VideoInfo | null; loading: boolean; t: Translations }) {
  if (loading) return (
    <div className="vi-card vi-skeleton">
      <div className="skel-thumb"/>
      <div className="skel-body">
        <div className="skel-line w80"/>
        <div className="skel-line w55"/>
        <div className="skel-line w35"/>
      </div>
    </div>
  )
  if (!info) return null
  return (
    <div className="vi-card">
      <div className="vi-thumb-wrap">
        {info.thumbnail
          ? <img src={info.thumbnail} alt="" className="vi-thumb"/>
          : <div className="vi-thumb-ph"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>
        }
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

function FormatSelector({ onDownload, disabled, t, initType, initVq, initAq, onFormatChange }: {
  onDownload: (type: FormatType, q: string) => void
  disabled: boolean
  t: Translations
  initType: FormatType
  initVq: VideoQuality
  initAq: AudioQuality
  onFormatChange: (type: FormatType, vq: VideoQuality, aq: AudioQuality) => void
}) {
  const [ftype, setFtype] = useState<FormatType>(initType)
  const [vq, setVq]       = useState<VideoQuality>(initVq)
  const [aq, setAq]       = useState<AudioQuality>(initAq)

  const setFtypeAndSave = (v: FormatType)    => { setFtype(v); onFormatChange(v,   vq,  aq)  }
  const setVqAndSave    = (v: VideoQuality)  => { setVq(v);    onFormatChange(ftype, v,  aq)  }
  const setAqAndSave    = (v: AudioQuality)  => { setAq(v);    onFormatChange(ftype, vq, v)   }

  const VQ: { v: VideoQuality; label: string; badge: string }[] = [
    { v:'2160', label:'4K',     badge:'UHD' },
    { v:'1440', label:'1440p',  badge:'2K'  },
    { v:'1080', label:'1080p',  badge:'FHD' },
    { v:'720',  label:'720p',   badge:'HD'  },
    { v:'480',  label:'480p',   badge:'SD'  },
    { v:'360',  label:'360p',   badge:''    },
  ]
  const AQ: { v: AudioQuality; fmt: string; sub: string }[] = [
    { v:'mp3_best', fmt:'MP3', sub:'Best'    },
    { v:'mp3_192',  fmt:'MP3', sub:'192 kbps'},
    { v:'mp3_128',  fmt:'MP3', sub:'128 kbps'},
    { v:'m4a',      fmt:'M4A', sub:'Best'    },
  ]

  const go = () => onDownload(ftype, ftype === 'video' ? vq : aq)

  return (
    <div className="fmt-section">
      <div className="fmt-tabs">
        <button className={`fmt-tab ${ftype==='video'?'fmt-tab-on':''}`} onClick={() => setFtypeAndSave('video')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
          {t.fmt_video}
        </button>
        <button className={`fmt-tab ${ftype==='audio'?'fmt-tab-on':''}`} onClick={() => setFtypeAndSave('audio')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          {t.fmt_audio}
        </button>
      </div>

      <div className="quality-grid">
        {ftype === 'video'
          ? VQ.map(q => (
              <button key={q.v} className={`q-btn ${vq===q.v?'q-btn-on':''}`} onClick={() => setVqAndSave(q.v)}>
                <span className="q-main">{q.label}</span>
                {q.badge && <span className="q-badge">{q.badge}</span>}
              </button>
            ))
          : AQ.map(q => (
              <button key={q.v} className={`q-btn ${aq===q.v?'q-btn-on':''}`} onClick={() => setAqAndSave(q.v)}>
                <span className="q-main">{q.fmt}</span>
                <span className="q-sub">{q.sub}</span>
              </button>
            ))
        }
      </div>

      <button className="dl-now-btn" onClick={go} disabled={disabled}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 16l-4-4h2.5V4h3v8H16l-4 4z"/><path d="M20 18H4"/>
        </svg>
        <span>{ftype === 'audio' ? t.btn_download_audio : t.btn_download_video}</span>
        <span className="dl-now-q">
          {ftype==='video'
            ? VQ.find(q=>q.v===vq)?.label
            : AQ.find(q=>q.v===aq)?.sub
          }
        </span>
      </button>
    </div>
  )
}

// ═══════════════════════ DOWNLOAD CARD ═══════════════════════

const STATUS_COLOR: Record<DownloadStatus, string> = {
  pending: '#60A5FA', downloading: '#4ADE80', processing: '#FACC15',
  complete: '#4ADE80', error: '#EF4444', cancelled: '#475569'
}
const STATUS_LABEL = (t: Translations): Record<DownloadStatus, string> => ({
  pending:     t.st_pending,
  downloading: t.st_downloading,
  processing:  t.st_processing,
  complete:    t.st_complete,
  error:       t.st_error,
  cancelled:   t.st_cancelled,
})

function DownloadCard({ item, onCancel, onOpen, t }: {
  item: DownloadItem; onCancel: (id: string) => void; onOpen: (id: string) => void; t: Translations
}) {
  const c = STATUS_COLOR[item.status]
  const labels = STATUS_LABEL(t)
  const showBar = item.status === 'downloading' || item.status === 'processing' || item.status === 'complete'

  return (
    <div className={`dl-card dl-${item.status}`}>
      {item.thumbnail && <img src={item.thumbnail} alt="" className="dl-thumb"/>}
      <div className="dl-body">
        <div className="dl-top">
          <span className="dl-title" title={item.title}>{item.title}</span>
          <div className="dl-acts">
            {(item.status === 'downloading' || item.status === 'pending') && (
              <button className="dl-act" onClick={() => onCancel(item.id)} title="Cancel">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="9"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                </svg>
              </button>
            )}
            {item.status === 'complete' && (
              <button className="dl-act dl-act-open" onClick={() => onOpen(item.id)} title="Open folder">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="dl-info-row">
          <span className="dl-fmt">{item.formatLabel}</span>
          <span className="dl-status-tag" style={{ color: c }}>
            <span className="dl-sdot" style={{ background: c }}/>
            {labels[item.status]}
          </span>
          {item.speed && <span className="dl-speed">{item.speed}</span>}
          {item.eta   && <span className="dl-eta">{t.eta} {item.eta}</span>}
          {item.status === 'downloading' && <span className="dl-pct">{Math.round(item.progress)}%</span>}
        </div>

        {showBar && (
          <div className="dl-track">
            <div className="dl-bar" style={{ width: `${item.status==='complete'?100:item.progress}%`, background: c }}/>
            {item.status === 'downloading' && (
              <div className="dl-glow" style={{ left: `${item.progress}%`, background: c }}/>
            )}
          </div>
        )}

        {item.error && <div className="dl-err">{item.error}</div>}
      </div>
    </div>
  )
}

// ═══════════════════════ HISTORY VIEW ═══════════════════════

function HistoryView({ downloads, t, onClear }: { downloads: DownloadItem[]; t: Translations; onClear: () => void }) {
  const done = downloads.filter(d => ['complete','error','cancelled'].includes(d.status))
  if (!done.length) return (
    <div className="hist-empty">
      <StarLogo size={52} cls="hist-empty-star"/>
      <p>{t.hist_empty}</p>
    </div>
  )
  return (
    <div className="hist-view">
      <div className="hist-head">
        <h2 className="section-title">{t.hist_title}</h2>
        <span className="hist-count">{done.length} {t.hist_items}</span>
        {done.length > 0 && (
          <button className="hist-clear" onClick={onClear} title={t.hist_clear}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
            </svg>
            {t.hist_clear}
          </button>
        )}
      </div>
      <div className="hist-list">
        {done.map(d => (
          <div key={d.id} className={`hist-item hist-${d.status}`}>
            {d.thumbnail && <img src={d.thumbnail} alt="" className="hist-thumb"/>}
            <div className="hist-meta">
              <span className="hist-title">{d.title}</span>
              <span className="hist-fmt">{d.formatLabel}</span>
            </div>
            <span className="hist-icon" style={{ color: STATUS_COLOR[d.status] }}>
              {d.status==='complete' ? '✓' : d.status==='error' ? '✗' : '–'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════ GLOW ORBS (Apathy theme) ═══════════════════════

function GlowOrbs() {
  return (
    <div className="ap-orbs" aria-hidden>
      <div className="ap-orb ap-orb-1"/>
      <div className="ap-orb ap-orb-2"/>
      <div className="ap-orb ap-orb-3"/>
    </div>
  )
}

// ═══════════════════════ THEME PREVIEW CARDS ═══════════════════════

function ThemeCards({ current, onChange, t }: { current: Theme; onChange: (th: Theme) => void; t: Translations }) {
  return (
    <div className="theme-cards">

      {/* Fleet */}
      <button className={`theme-card ${current==='fleet'?'theme-card-on':''}`} onClick={() => onChange('fleet')}>
        <div className="tc-preview tc-fleet">
          <div className="tc-fleet-sb">
            <div className="tc-fleet-dot"/>
            <div className="tc-fleet-line active"/>
            <div className="tc-fleet-line"/>
            <div className="tc-fleet-line"/>
          </div>
          <div className="tc-fleet-main">
            <div className="tc-fleet-bar"><div className="tc-fleet-bar-fill"/></div>
            <div className="tc-fleet-accent"/>
            <div className="tc-fleet-bar" style={{width:'70%'}}><div className="tc-fleet-bar-fill" style={{width:'35%', background:'#38BDF8'}}/></div>
          </div>
        </div>
        <div className="tc-footer">
          <span className="tc-name">{t.theme_fleet}</span>
          <span className="tc-check"><svg viewBox="0 0 10 8" fill="none"><polyline points="1 4 3.5 6.5 9 1" stroke="#000" strokeWidth="1.5" strokeLinecap="round"/></svg></span>
        </div>
      </button>

      {/* Apathy */}
      <button className={`theme-card ${current==='apathy'?'theme-card-on':''}`} onClick={() => onChange('apathy')}>
        <div className="tc-preview tc-apathy">
          <div className="tc-ap-orb1"/>
          <div className="tc-ap-orb2"/>
          <div className="tc-ap-sb">
            <div className="tc-ap-dot"/>
            <div className="tc-ap-line active"/>
            <div className="tc-ap-line"/>
            <div className="tc-ap-line"/>
          </div>
          <div className="tc-ap-main">
            <div className="tc-ap-bar"><div className="tc-ap-bar-fill"/></div>
            <div className="tc-ap-accent"/>
            <div className="tc-ap-bar" style={{width:'70%'}}><div className="tc-ap-bar-fill" style={{width:'35%', background:'#4D7CFF'}}/></div>
          </div>
        </div>
        <div className="tc-footer">
          <span className="tc-name">{t.theme_apathy}</span>
          <span className="tc-check"><svg viewBox="0 0 10 8" fill="none"><polyline points="1 4 3.5 6.5 9 1" stroke="#000" strokeWidth="1.5" strokeLinecap="round"/></svg></span>
        </div>
      </button>

    </div>
  )
}

// ═══════════════════════ SETTINGS VIEW ═══════════════════════

function SettingsView({ settings, onSave, onPickFolder, t, theme, onThemeChange }: {
  settings: AppSettings; onSave: (s: AppSettings) => void; onPickFolder: () => void
  t: Translations; theme: Theme; onThemeChange: (th: Theme) => void
}) {
  const [local, setLocal] = useState(settings)
  useEffect(() => setLocal(settings), [settings])

  return (
    <div className="settings-view">
      <h2 className="section-title">{t.set_title}</h2>

      <div className="set-group">
        <div className="set-label">{t.set_theme}</div>
        <ThemeCards current={theme} onChange={onThemeChange} t={t}/>
      </div>

      <div className="set-group">
        <div className="set-label">{t.set_folder_label}</div>
        <div className="set-row">
          <input className="set-input" value={local.downloadPath} readOnly onChange={() => {}}/>
          <button className="set-browse" onClick={onPickFolder}>{t.set_folder_browse}</button>
        </div>
      </div>

      <div className="set-group">
        <div className="set-label">{t.set_concurrent}</div>
        <div className="set-radios">
          {[1,2,3,5].map(n => (
            <button
              key={n}
              className={`set-radio ${local.concurrentDownloads===n?'set-radio-on':''}`}
              onClick={() => setLocal(p=>({...p, concurrentDownloads: n}))}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <button className="set-save" onClick={() => onSave(local)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
        </svg>
        {t.set_save}
      </button>
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

        {error && (
          <div className="setup-err">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>{error}</span>
          </div>
        )}

        {loading
          ? (
            <div className="setup-loading">
              <span className="setup-spin"/>
              <span>{t.setup_loading}</span>
            </div>
          )
          : (
            <div className="setup-btns">
              <button className="setup-btn" onClick={onSetup}>
                {error ? t.setup_retry : t.setup_init}
              </button>
              {error && (
                <p className="setup-manual">
                  {t.setup_manual}<br/>
                  <code>winget install yt-dlp</code>
                </p>
              )}
            </div>
          )
        }
      </div>
    </div>
  )
}

// ═══════════════════════ MAIN APP ═══════════════════════

export default function App() {
  const [view, setView]             = useState<View>('download')
  const [lang, setLang]             = useState<Lang>('en')
  const [theme, setTheme]           = useState<Theme>('fleet')
  const [initFmt, setInitFmt]       = useState<{ type: FormatType; vq: VideoQuality; aq: AudioQuality }>({ type:'video', vq:'1080', aq:'mp3_best' })
  const [settings, setSettings]     = useState<AppSettings>({ downloadPath:'', defaultFormat:'mp4', defaultQuality:'1080', concurrentDownloads:3 })
  const [downloads, setDownloads]   = useState<DownloadItem[]>([])
  const [videoInfo, setVideoInfo]   = useState<VideoInfo | null>(null)
  const [fetching, setFetching]     = useState(false)
  const [fetchErr, setFetchErr]     = useState('')
  const [ready, setReady]           = useState(false)
  const [showSetup, setShowSetup]   = useState(false)
  const [setupBusy, setSetupBusy]   = useState(false)
  const [setupError, setSetupError] = useState('')
  const [appLoaded, setAppLoaded]   = useState(false)
  const urlRef = useRef('')

  const t = translations[lang]

  const toggleLang = () => {
    const next = lang === 'en' ? 'ru' : 'en'
    setLang(next as Lang)
    saveState({ lang: next as Lang })
  }

  const handleThemeChange = (th: Theme) => {
    setTheme(th)
    saveState({ theme: th })
    document.documentElement.setAttribute('data-theme', th === 'apathy' ? 'apathy' : '')
  }

  // init — load everything from electron-store
  useEffect(() => {
    (async () => {
      if (!window.api) return

      // Load persisted app state
      const s = await loadState()
      setLang(s.lang)
      setTheme(s.theme ?? 'fleet')
      document.documentElement.setAttribute('data-theme', s.theme === 'apathy' ? 'apathy' : '')
      setInitFmt({ type: s.formatType, vq: s.videoQuality as VideoQuality, aq: s.audioQuality as AudioQuality })

      // Load electron settings (download path from there)
      const elSettings = await window.api.getSettings()
      const resolvedPath = s.downloadPath || elSettings.downloadPath
      setSettings({ ...elSettings, downloadPath: resolvedPath, concurrentDownloads: s.concurrentDownloads || elSettings.concurrentDownloads })

      // Load history
      const hist = await loadHistory()
      setDownloads(hist.map(h => ({ ...h, progress: 100, speed: undefined, eta: undefined, error: undefined })))

      setAppLoaded(true)

      // Check yt-dlp
      const { exists } = await window.api.checkYtDlp()
      if (exists) { setReady(true) } else { setShowSetup(true) }
    })()
  }, [])

  // IPC listeners
  useEffect(() => {
    if (!window.api) return
    const u1 = window.api.onDownloadProgress(d => {
      setDownloads(p => p.map(x => x.id===d.id ? {...x, progress:d.progress, speed:d.speed, eta:d.eta, status:'downloading'} : x))
    })
    const u2 = window.api.onDownloadComplete(d => {
      setDownloads(p => {
        const updated = p.map(x => x.id===d.id ? {...x, status:'complete' as const, progress:100} : x)
        const item = updated.find(x => x.id === d.id)
        if (item) appendHistory({ id:item.id, url:item.url, title:item.title, thumbnail:item.thumbnail, formatLabel:item.formatLabel, status:'complete', createdAt:item.createdAt })
        return updated
      })
    })
    const u3 = window.api.onDownloadError(d => {
      setDownloads(p => {
        const updated = p.map(x => x.id===d.id ? {...x, status:'error' as const, error:d.error} : x)
        const item = updated.find(x => x.id === d.id)
        if (item) appendHistory({ id:item.id, url:item.url, title:item.title, thumbnail:item.thumbnail, formatLabel:item.formatLabel, status:'error', createdAt:item.createdAt })
        return updated
      })
    })
    return () => { u1(); u2(); u3() }
  }, [])

  const handleSetup = async () => {
    setSetupBusy(true)
    setSetupError('')
    try {
      const r = await window.api.setupYtDlp()
      if (r.success) {
        setReady(true)
        setShowSetup(false)
      } else {
        setSetupError(r.error || 'Download failed. Check your internet connection.')
      }
    } catch (err) {
      setSetupError(String(err))
    } finally {
      setSetupBusy(false)
    }
  }

  const handleFetch = useCallback(async (url: string) => {
    if (!window.api || !ready) return
    setFetching(true); setFetchErr(''); setVideoInfo(null)
    urlRef.current = url
    const r = await window.api.fetchVideoInfo(url)
    setFetching(false)
    if (r.success && r.data) { setVideoInfo(r.data) }
    else { setFetchErr(r.error || 'Failed to fetch info') }
  }, [ready])

  const handleDownload = useCallback(async (type: FormatType, quality: string) => {
    if (!videoInfo || !window.api) return
    const id = genId()
    const formatArgs = getFormatArgs(type, quality as VideoQuality | AudioQuality)
    const formatLabel = getFormatLabel(type, quality as VideoQuality | AudioQuality)

    setDownloads(p => [{
      id, url: urlRef.current, title: videoInfo.title, thumbnail: videoInfo.thumbnail,
      formatLabel, status:'pending', progress:0, createdAt: Date.now()
    }, ...p])

    const r = await window.api.startDownload({ id, url: urlRef.current, formatArgs, downloadPath: settings.downloadPath })
    if (!r.success) {
      setDownloads(p => p.map(x => x.id===id ? {...x, status:'error', error: r.error} : x))
    }
  }, [videoInfo, settings.downloadPath])

  const handleCancel = useCallback(async (id: string) => {
    await window.api?.cancelDownload(id)
    setDownloads(p => {
      const updated = p.map(x => x.id===id ? {...x, status:'cancelled' as const} : x)
      const item = updated.find(x => x.id === id)
      if (item) appendHistory({ id:item.id, url:item.url, title:item.title, thumbnail:item.thumbnail, formatLabel:item.formatLabel, status:'cancelled', createdAt:item.createdAt })
      return updated
    })
  }, [])

  const handleOpen = useCallback(async (id: string) => {
    await window.api?.openFolder(settings.downloadPath)
  }, [settings.downloadPath])

  const handleSaveSettings = async (s: AppSettings) => {
    setSettings(s)
    await saveState({ downloadPath: s.downloadPath, concurrentDownloads: s.concurrentDownloads })
    await window.api?.saveSettings(s)
  }

  const handlePickFolder = async () => {
    const p = await window.api?.selectDownloadFolder()
    if (p) {
      setSettings(prev => ({...prev, downloadPath: p}))
      await saveState({ downloadPath: p })
    }
  }
  const activeCount = downloads.filter(d => d.status==='downloading'||d.status==='pending').length

  return (
    <div className="app">
      {theme === 'apathy' && <GlowOrbs/>}
      {showSetup && <SetupOverlay onSetup={handleSetup} loading={setupBusy} error={setupError} t={t}/>}

      <TitleBar/>

      <div className="app-body">
        <Sidebar view={view} onChange={setView} activeCount={activeCount} lang={lang} onLangToggle={toggleLang}/>

        <main className="main">
          {view === 'download' && (
            <div className="dl-view">
              <UrlInput onFetch={handleFetch} loading={fetching} t={t}/>

              {fetchErr && (
                <div className="fetch-err">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  {fetchErr}
                </div>
              )}

              {(videoInfo || fetching) && (
                <>
                  <VideoInfoCard info={videoInfo} loading={fetching} t={t}/>
                  <FormatSelector
                    key="fmt-selector"
                    onDownload={handleDownload}
                    disabled={!videoInfo || fetching}
                    t={t}
                    initType={initFmt.type}
                    initVq={initFmt.vq}
                    initAq={initFmt.aq}
                    onFormatChange={(type, vq, aq) => saveState({ formatType: type, videoQuality: vq, audioQuality: aq })}
                  />
                </>
              )}

              {downloads.length > 0 && (
                <div className="queue-section">
                  <div className="queue-head">
                    <span className="section-eyebrow-sm">{t.lbl_downloads}</span>
                    {activeCount > 0 && <span className="queue-badge">{activeCount} {t.lbl_active}</span>}
                  </div>
                  <div className="queue-list">
                    {downloads.slice(0, 15).map(d => (
                      <DownloadCard key={d.id} item={d} onCancel={handleCancel} onOpen={handleOpen} t={t}/>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {view === 'history' && <HistoryView downloads={downloads} t={t} onClear={async () => { await clearHistory(); setDownloads(p => p.filter(d => d.status === 'downloading' || d.status === 'pending')) }}/>}
          {view === 'settings' && <SettingsView settings={settings} onSave={handleSaveSettings} onPickFolder={handlePickFolder} t={t} theme={theme} onThemeChange={handleThemeChange}/>}
        </main>
      </div>
    </div>
  )
}
