import { useState, useEffect, useCallback, useRef } from 'react'
import { type Lang, type Translations, translations } from './i18n'
import { loadState, saveState, loadHistory, appendHistory, clearHistory, loadStreamSessions, saveStreamSessions, loadFavStreamers, saveFavStreamers, type PersistedDownload, type StreamSession } from './storage'

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
type View = 'download' | 'history' | 'settings' | 'stream'

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
type Platform = 'youtube' | 'twitch' | 'vk'

interface DownloadItem { id: string; url: string; title: string; thumbnail?: string; formatLabel: string; status: DownloadStatus; progress: number; speed?: string; eta?: string; error?: string; createdAt: number }
interface AppSettings { downloadPath: string; defaultFormat: string; defaultQuality: string; concurrentDownloads: number; cookiesFromBrowser: string; cookiesFile: string }
interface StreamMarker { id: string; name: string; description: string; streamPos: number; createdAt: number }
interface LiveStream { login: string; displayName: string; avatar: string; title: string; viewers: number; game: string }

// ═══════════════════════ HELPERS ═══════════════════════

const genId = () => `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const isPlaylistUrl = (url: string) => /[?&]list=/.test(url)

function isCookieError(err: string): boolean {
  const l = err.toLowerCase()
  return l.includes('cookie') || l.includes('sign in') || l.includes('login') || l.includes('403')
    || l.includes('age-restricted') || l.includes('private') || l.includes('members')
    || l.includes('dpapi') || l.includes('chrome cookie') || l.includes('could not copy')
    || l.includes('requires authentication') || l.includes('confirm your age') || l.includes('not available')
    || l.includes('access restricted')
}

function isAgeGate(err: string): boolean {
  return err === 'age_gate'
}

function isSslError(err: string): boolean {
  return err === 'ssl_error'
}

function isStaleError(err: string): boolean {
  return err === 'stale_cookies'
}

function isFfmpegError(err: string): boolean {
  const l = err.toLowerCase()
  return l.includes('ffmpeg') && (l.includes('not installed') || l.includes('not found') || l.includes('aborting') || l.includes('is not installed'))
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

/** Format cache age for tooltip: "2h ago", "3d ago", "just now" */
function formatCacheAge(fetchedAt: number): string {
  const diffMs = Date.now() - fetchedAt
  const mins = Math.floor(diffMs / 60000)
  const hours = Math.floor(diffMs / 3600000)
  const days = Math.floor(diffMs / 86400000)
  if (days >= 1) return `${days}d ago`
  if (hours >= 1) return `${hours}h ago`
  if (mins >= 1) return `${mins}m ago`
  return 'just now'
}

function detectPlatform(url: string): Platform {
  if (url.includes('twitch.tv')) return 'twitch'
  if (url.includes('vk.com') || url.includes('vkvideo.ru')) return 'vk'
  return 'youtube'
}

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
  return ['-f',`bestvideo[height<=${q}]+bestaudio/bestvideo[height<=${q}]+bestaudio[ext=m4a]/bestvideo+bestaudio`,'--merge-output-format','mp4','--remux-video','mp4']
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
  // Twitch HLS is already a single pre-merged stream — no remux needed (avoids ffmpeg dependency)
  const map: Record<TwitchQuality,string> = { source:'best', '1080p60':'1080p60/1080p/best', '720p60':'720p60/720p/best', '480p':'480p/best', '360p':'360p/best', '160p':'160p/best' }
  return ['-f', map[quality]]
}

function getTwitchFormatLabel(type: FormatType, quality: TwitchQuality): string {
  if (type === 'audio') return 'MP3 · Best'
  const m: Record<TwitchQuality,string> = { source:'Source', '1080p60':'1080p60', '720p60':'720p60', '480p':'480p', '360p':'360p', '160p':'160p' }
  return m[quality] ?? quality
}

function secsToTimestamp(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
}

/** Parse HH:MM:SS, MM:SS or plain seconds string → seconds number. Returns null on bad input. */
function parseTimestamp(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  const parts = s.split(':').map(p => parseFloat(p))
  if (parts.some(p => isNaN(p))) return null
  if (parts.length === 3) return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2])
  if (parts.length === 2) return Math.round(parts[0] * 60 + parts[1])
  if (parts.length === 1) return Math.round(parts[0])
  return null
}

// ═══════════════════════ TIME RANGE SLIDER ═══════════════════════

function TimeRangePicker({ duration, startSec, endSec, onChange }: {
  duration: number; startSec: number; endSec: number
  onChange: (s: number, e: number) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef<'start' | 'end' | null>(null)

  const pct = (v: number) => Math.max(0, Math.min(100, (v / duration) * 100))

  const posToSec = (clientX: number): number => {
    if (!trackRef.current) return 0
    const rect = trackRef.current.getBoundingClientRect()
    return Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration)
  }

  const startDrag = (handle: 'start' | 'end') => (e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = handle
    const onMove = (me: MouseEvent) => {
      const sec = posToSec(me.clientX)
      if (draggingRef.current === 'start') onChange(Math.max(0, Math.min(sec, endSec - 1)), endSec)
      else onChange(startSec, Math.min(duration, Math.max(sec, startSec + 1)))
    }
    const onUp = () => { draggingRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const clickTrack = (e: React.MouseEvent) => {
    if (draggingRef.current) return
    const sec = posToSec(e.clientX)
    if (Math.abs(sec - startSec) <= Math.abs(sec - endSec)) onChange(Math.max(0, Math.min(sec, endSec - 1)), endSec)
    else onChange(startSec, Math.min(duration, Math.max(sec, startSec + 1)))
  }

  const selDur = endSec - startSec
  const startPct = pct(startSec)
  const endPct = pct(endSec)

  return (
    <div className="tr-slider-wrap">
      <div className="tr-slider-meta">
        <span className="tr-sel-label">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          {secsToTimestamp(startSec)}
        </span>
        <span className="tr-sel-dur">{secsToTimestamp(selDur)}</span>
        <span className="tr-sel-label">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
          {secsToTimestamp(endSec)}
        </span>
      </div>
      <div className="tr-track-outer" ref={trackRef} onClick={clickTrack}>
        <div className="tr-track-bg"/>
        <div className="tr-track-fill" style={{ left:`${startPct}%`, width:`${endPct - startPct}%` }}/>
        <div className="tr-handle tr-handle-s" style={{ left:`${startPct}%` }} onMouseDown={startDrag('start')}>
          <div className="tr-handle-pip"/>
          <div className="tr-handle-label tr-label-top">{secsToTimestamp(startSec)}</div>
        </div>
        <div className="tr-handle tr-handle-e" style={{ left:`${endPct}%` }} onMouseDown={startDrag('end')}>
          <div className="tr-handle-pip"/>
          <div className="tr-handle-label tr-label-top">{secsToTimestamp(endSec)}</div>
        </div>
      </div>
      <div className="tr-edge-labels">
        <span>00:00:00</span>
        <span>{secsToTimestamp(duration)}</span>
      </div>
    </div>
  )
}

// ═══════════════════════ VIDEO PLAYER PANEL ═══════════════════════



function extractEmbedId(url: string, platform: Platform): string | null {
  if (platform === 'twitch') {
    const m = url.match(/twitch\.tv\/videos?\/([0-9]+)/)
    return m?.[1] ?? null
  }
  const m = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/)
  return m?.[1] ?? null
}

function VideoPlayerPanel({ url, platform, duration, onDownload, onClose, t }: {
  url: string; platform: Platform; duration?: number
  onDownload: (type: FormatType, quality: string, timeRange: { start: number; end: number }) => void
  onClose: () => void; t: Translations
}) {
  const webviewRef = useRef<any>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef<'start' | 'end' | 'head' | null>(null)
  const resizingRef = useRef<string | null>(null)
  const resizeStartRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const saveSizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [panelSize, setPanelSize] = useState<{ width: number | null; height: number | null }>({ width: null, height: null })

  // Load saved panel size on mount
  useEffect(() => {
    window.api.getAppState().then((s: Record<string, unknown>) => {
      const w = typeof s.playerPanelWidth  === 'number' ? s.playerPanelWidth  : null
      const h = typeof s.playerPanelHeight === 'number' ? s.playerPanelHeight : null
      if (w || h) setPanelSize({ width: w, height: h })
    }).catch(() => {})
  }, [])
  const isSeekingRef = useRef(false)
  const seekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [startSec, setStartSec] = useState(0)
  const [endSec, setEndSec] = useState(duration ?? 0)
  const [ftype, setFtype] = useState<FormatType>('video')
  const [embedUrl, setEmbedUrl] = useState<string | null>(null)
  // Manual time inputs
  const [manualStart, setManualStart] = useState('')
  const [manualEnd, setManualEnd] = useState('')
  const [manualSeek, setManualSeek] = useState('')
  const [manualStartErr, setManualStartErr] = useState(false)
  const [manualEndErr, setManualEndErr] = useState(false)
  const [manualSeekErr, setManualSeekErr] = useState(false)

  /** Форматирует ввод цифр в маску HH:MM:SS по мере набора */
  const formatTimeInput = (prev: string, next: string): string => {
    // Если удаляем — просто убираем последний символ без маски
    if (next.length < prev.replace(/:/g, '').length) {
      const digits = prev.replace(/:/g, '')
      const shorter = digits.slice(0, -1)
      if (shorter.length === 0) return ''
      if (shorter.length <= 2) return shorter
      if (shorter.length <= 4) return shorter.slice(0,2) + ':' + shorter.slice(2)
      return shorter.slice(0,2) + ':' + shorter.slice(2,4) + ':' + shorter.slice(4,6)
    }
    // Только цифры
    const digits = next.replace(/[^0-9]/g, '').slice(0, 6)
    if (digits.length === 0) return ''
    if (digits.length <= 2) return digits
    if (digits.length <= 4) return digits.slice(0,2) + ':' + digits.slice(2)
    return digits.slice(0,2) + ':' + digits.slice(2,4) + ':' + digits.slice(4,6)
  }

  const dur = duration ?? 0

  // ── Resize logic ──────────────────────────────────────────────────────────
  const startResize = (dir: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const panel = panelRef.current
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    resizingRef.current = dir
    resizeStartRef.current = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height }

    const onMove = (me: MouseEvent) => {
      const s = resizeStartRef.current!
      const dx = me.clientX - s.x
      const dy = me.clientY - s.y
      let newW = s.w
      let newH = s.h
      const dir = resizingRef.current!
      if (dir.includes('e')) newW = Math.max(340, s.w + dx)
      if (dir.includes('w')) newW = Math.max(340, s.w - dx)
      if (dir.includes('s')) newH = Math.max(300, s.h + dy)
      if (dir.includes('n')) newH = Math.max(300, s.h - dy)
      setPanelSize({ width: newW, height: newH })
      // Debounce save — 600ms after last move
      if (saveSizeTimerRef.current) clearTimeout(saveSizeTimerRef.current)
      saveSizeTimerRef.current = setTimeout(() => {
        window.api.saveAppState({ playerPanelWidth: Math.round(newW), playerPanelHeight: Math.round(newH) } as any).catch(() => {})
      }, 600)
    }
    const onUp = () => {
      resizingRef.current = null
      resizeStartRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Build embed URL — for Twitch, use our local HTTP server so parent=localhost is valid
  useEffect(() => {
    if (platform === 'twitch') {
      const id = extractEmbedId(url, platform)
      if (!id) { setEmbedUrl(null); return }
      window.api.getPreviewPort().then(port => {
        setEmbedUrl(`http://localhost:${port}/?id=${id}`)
      }).catch(() => {
        // Fallback if IPC fails
        setEmbedUrl(`https://player.twitch.tv/?video=${id}&parent=localhost&autoplay=false`)
      })
    } else {
      // Use our local preview server with YouTube IFrame API — avoids Error 153,
      // correct origin, no embed restrictions, full player control via __ytXxx helpers
      const id = extractEmbedId(url, platform)
      if (!id) { setEmbedUrl(null); return }
      window.api.getPreviewPort().then(port => {
        setEmbedUrl(`http://localhost:${port}/?yt=${id}`)
      }).catch(() => { setEmbedUrl(null) })
    }
  }, [url, platform])

  // dom-ready: hide Twitch/YouTube overlay UI via CSS injection
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const onReady = async () => {
      setReady(true)
      const isYtLocal = embedUrl?.includes('?yt=')
      try {
        if (platform === 'youtube' && !isYtLocal) {
          // Full YouTube page: hide page chrome, keep only the player area
          await wv.insertCSS(`
            html, body { margin: 0; padding: 0; background: #000 !important; overflow: hidden; }
            .ytp-ad-module, .video-ads, .ytp-ad-overlay-container,
            .ytp-ad-text-overlay, .ytp-ad-image-overlay,
            .ytp-ad-player-overlay-instream-info,
            .ytp-ad-skip-button-container, .ytp-ad-visit-advertiser-button,
            .ytp-ad-progress, .ytp-ad-progress-list,
            .ytp-cards-button, .ytp-watermark,
            .ytp-share-button, .ytp-subtitles-button { display: none !important; }
          `)
        } else if (platform === 'youtube' && isYtLocal) {
          // IFrame API local page: nothing to inject, player handles itself
        } else {
          // Twitch: hide subscribe/follow/mature banners
          await wv.insertCSS(`
            html, body { margin: 0 !important; padding: 0 !important; background: #000 !important; }
            [data-a-target="player-overlay-mature-accept"],
            [data-test-selector="subscribe-button__subscribe-button"],
            .channel-info-bar, .top-bar {
              display: none !important;
            }
          `)
        }
      } catch { /* ignore */ }

      // For YouTube IFrame API: wait for player init then sync state
      if (platform === 'youtube' && isYtLocal) {
        setTimeout(async () => {
          try {
            const result = await wv.executeJavaScript(`(()=>{try{return typeof window.__ytIsPlaying==='function'?window.__ytIsPlaying():false}catch(e){return false}})()`)
            setPlaying(!!result)
          } catch {}
        }, 3000)
      } else if (platform === 'youtube') {
        setTimeout(async () => {
          try {
            const result = await wv.executeJavaScript(`(()=>{try{const mp=document.getElementById('movie_player');if(mp&&typeof mp.getPlayerState==='function')return mp.getPlayerState()===1;const v=document.querySelector('video');return v?!v.paused:false}catch(e){return false}})()`)
            setPlaying(!!result)
          } catch {}
        }, 3000)
      } else {
        // Twitch: just sync state after a delay
        setTimeout(async () => {
          try {
            const result = await wv.executeJavaScript(`(()=>{try{if(window.__twitchPlayer&&typeof window.__twitchPlayer.isPaused==='function')return !window.__twitchPlayer.isPaused();const v=document.querySelector('video');return v?!v.paused:false}catch(e){return false}})()`)
            setPlaying(!!result)
          } catch {}
        }, 2000)
      }
    }

    wv.addEventListener('dom-ready', onReady)
    return () => wv.removeEventListener('dom-ready', onReady)
  }, [embedUrl, platform])

  // Poll currentTime — for Twitch via localhost the <video> is inside an iframe,
  // so we query inside the iframe's contentDocument
  useEffect(() => {
    if (!ready) return
    const isTwitchLocal = embedUrl?.startsWith('http://localhost') && !embedUrl.includes('?yt=')
    const isYtLocal = embedUrl?.includes('?yt=')
    const js = isTwitchLocal
      ? `(()=>{try{if(window.__twitchPlayer&&typeof window.__twitchPlayer.getCurrentTime==='function')return Math.floor(window.__twitchPlayer.getCurrentTime());return -1}catch(e){return -1}})()`
      : isYtLocal
        ? `(()=>{try{return typeof window.__ytGetTime==='function'?window.__ytGetTime():-1}catch(e){return -1}})()`
        : `(()=>{try{const mp=document.getElementById('movie_player');if(mp&&typeof mp.getCurrentTime==='function')return Math.floor(mp.getCurrentTime());const v=document.querySelector('video');return v?Math.floor(v.currentTime):-1}catch(e){return -1}})()`
    const iv = setInterval(async () => {
      if (isSeekingRef.current) return
      try {
        const ct = await webviewRef.current?.executeJavaScript(js)
        if (typeof ct === 'number' && ct >= 0) setCurrentTime(ct)
      } catch { /* ignore */ }
    }, 500)
    return () => clearInterval(iv)
  }, [ready, embedUrl])

  const seekTo = async (sec: number) => {
    const wv = webviewRef.current
    if (!wv) return
    const isTwitchLocal = embedUrl?.startsWith('http://localhost') && !embedUrl.includes('?yt=')
    const isYtLocal = embedUrl?.includes('?yt=')
    const s = Math.round(sec)
    const js = isTwitchLocal
      ? `(()=>{try{if(window.__twitchPlayer&&typeof window.__twitchPlayer.seek==='function'){window.__twitchPlayer.seek(${s});}}catch(e){}})()`
      : isYtLocal
        ? `(()=>{try{if(typeof window.__ytSeek==='function')window.__ytSeek(${s});}catch(e){}})()`
        : `(()=>{try{
            const mp=document.getElementById('movie_player');
            if(mp&&typeof mp.seekTo==='function'){mp.seekTo(${s},true);return;}
            const v=document.querySelector('video');
            if(v){
              const wasPlaying=!v.paused;
              v.currentTime=${s};
              if(wasPlaying){setTimeout(()=>{if(v.paused)v.play().catch(()=>{})},200);}
            }
          }catch(e){}})()`
    try { await wv.executeJavaScript(js) } catch {}
  }

  /** Seek + заморозить polling пока плеер не достигнет цели (±3s) или макс 8s */
  const seekWithLock = (sec: number) => {
    if (seekTimerRef.current) clearTimeout(seekTimerRef.current)
    isSeekingRef.current = true
    setCurrentTime(sec)
    seekTo(sec)
    // Снимаем блокировку только когда плеер реально добрался до нужной позиции
    const started = Date.now()
    const isTwitchLocal = embedUrl?.startsWith('http://localhost') && !embedUrl.includes('?yt=')
    const isYtLocal = embedUrl?.includes('?yt=')
    const checkJs = isTwitchLocal
      ? `(()=>{try{if(window.__twitchPlayer&&typeof window.__twitchPlayer.getCurrentTime==='function')return Math.floor(window.__twitchPlayer.getCurrentTime());return -1}catch(e){return -1}})()`
      : isYtLocal
        ? `(()=>{try{return typeof window.__ytGetTime==='function'?window.__ytGetTime():-1}catch(e){return -1}})()`
        : `(()=>{try{const mp=document.getElementById('movie_player');if(mp&&typeof mp.getCurrentTime==='function')return Math.floor(mp.getCurrentTime());const v=document.querySelector('video');return v?Math.floor(v.currentTime):-1}catch(e){return -1}})()`
    const poll = setInterval(async () => {
      try {
        const ct = await webviewRef.current?.executeJavaScript(checkJs)
        if (typeof ct === 'number' && ct >= 0 && Math.abs(ct - sec) <= 3) {
          clearInterval(poll)
          seekTimerRef.current = null
          isSeekingRef.current = false
          return
        }
      } catch { /* ignore */ }
      if (Date.now() - started > 8000) {
        clearInterval(poll)
        seekTimerRef.current = null
        isSeekingRef.current = false
      }
    }, 300)
    seekTimerRef.current = poll as unknown as ReturnType<typeof setTimeout>
  }

  const togglePlay = async () => {
    const wv = webviewRef.current
    if (!wv) return
    const isTwitchLocal = embedUrl?.startsWith('http://localhost') && !embedUrl.includes('?yt=')
    const isYtLocal = embedUrl?.includes('?yt=')
    // Read actual player state
    let isActuallyPlaying = playing
    try {
      const checkJs = isTwitchLocal
        ? `(()=>{try{if(window.__twitchPlayer&&typeof window.__twitchPlayer.isPaused==='function')return !window.__twitchPlayer.isPaused();return false}catch(e){return false}})()`
        : isYtLocal
          ? `(()=>{try{return typeof window.__ytIsPlaying==='function'?window.__ytIsPlaying():false}catch(e){return false}})()`
          : `(()=>{try{const mp=document.getElementById('movie_player');if(mp&&typeof mp.getPlayerState==='function')return mp.getPlayerState()===1;const v=document.querySelector('video');return v?!v.paused&&!v.ended:false}catch(e){return false}})()`
      const result = await wv.executeJavaScript(checkJs)
      if (typeof result === 'boolean') isActuallyPlaying = result
    } catch {}
    const willPause = isActuallyPlaying
    const js = isTwitchLocal
      ? `(()=>{try{if(window.__twitchPlayer){${willPause}?window.__twitchPlayer.pause():window.__twitchPlayer.play();}return 'ok'}catch(e){return 'err'}})()`
      : isYtLocal
        ? `(()=>{try{${willPause}?(typeof window.__ytPause==='function'&&window.__ytPause()):(typeof window.__ytPlay==='function'&&window.__ytPlay());return 'ok'}catch(e){return 'err'}})()`
        : `(()=>{try{
            const mp=document.getElementById('movie_player');
            if(mp){${willPause}?(mp.pauseVideo&&mp.pauseVideo()):(mp.playVideo&&mp.playVideo());return 'ok';}
            const v=document.querySelector('video');
            if(v){${willPause}?v.pause():v.play().catch(()=>{});return 'ok';}
            return 'noop';
          }catch(e){return 'err'}})()`
    try { await wv.executeJavaScript(js) } catch {}
    setPlaying(!willPause)
    // Verify after 500ms and correct if needed
    setTimeout(async () => {
      try {
        const verifyJs = isTwitchLocal
          ? `(()=>{try{if(window.__twitchPlayer&&typeof window.__twitchPlayer.isPaused==='function')return !window.__twitchPlayer.isPaused();return false}catch(e){return false}})()`
          : isYtLocal
            ? `(()=>{try{return typeof window.__ytIsPlaying==='function'?window.__ytIsPlaying():false}catch(e){return false}})()`
            : `(()=>{try{const mp=document.getElementById('movie_player');if(mp&&typeof mp.getPlayerState==='function')return mp.getPlayerState()===1;const v=document.querySelector('video');return v?!v.paused&&!v.ended:false}catch(e){return false}})()`
        const actual = await wv.executeJavaScript(verifyJs)
        if (typeof actual === 'boolean') setPlaying(actual)
      } catch {}
    }, 500)
  }

  const getTime = async (): Promise<number> => {
    try {
      const isTwitchLocal = embedUrl?.startsWith('http://localhost') && !embedUrl.includes('?yt=')
      const isYtLocal = embedUrl?.includes('?yt=')
      const js = isTwitchLocal
        ? `(()=>{try{if(window.__twitchPlayer&&typeof window.__twitchPlayer.getCurrentTime==='function')return Math.floor(window.__twitchPlayer.getCurrentTime());return -1}catch(e){return -1}})()`
        : isYtLocal
          ? `(()=>{try{return typeof window.__ytGetTime==='function'?window.__ytGetTime():-1}catch(e){return -1}})()`
          : `(()=>{try{const mp=document.getElementById('movie_player');if(mp&&typeof mp.getCurrentTime==='function')return Math.floor(mp.getCurrentTime());const v=document.querySelector('video');return v?Math.floor(v.currentTime):-1}catch(e){return -1}})()`
      const ct = await webviewRef.current?.executeJavaScript(js)
      return typeof ct === 'number' && ct >= 0 ? ct : -1
    } catch { return -1 }
  }

  const markStart = async () => {
    const ct = await getTime()
    if (ct < 0) return
    const s = Math.floor(ct)
    setStartSec(s)
    if (endSec <= s) setEndSec(Math.min(s + 30, dur || s + 30))
  }

  const markEnd = async () => {
    const ct = await getTime()
    if (ct < 0) return
    const e = Math.ceil(ct)
    setEndSec(e)
    if (startSec >= e) setStartSec(Math.max(0, e - 30))
  }

  // Apply manual start input
  const applyManualStart = () => {
    const v = parseTimestamp(manualStart)
    if (v === null || v < 0) { setManualStartErr(true); return }
    setManualStartErr(false)
    setManualStart('')
    const clamped = Math.max(0, Math.min(v, (dur > 0 ? dur : 999999) - 1))
    setStartSec(clamped)
    if (endSec <= clamped) setEndSec(Math.min(clamped + 30, dur > 0 ? dur : clamped + 30))
  }

  // Apply manual end input
  const applyManualEnd = () => {
    const v = parseTimestamp(manualEnd)
    if (v === null || v <= 0) { setManualEndErr(true); return }
    setManualEndErr(false)
    setManualEnd('')
    const clamped = dur > 0 ? Math.min(v, dur) : v
    setEndSec(clamped)
    if (startSec >= clamped) setStartSec(Math.max(0, clamped - 30))
  }

  // Apply manual seek input
  const applyManualSeek = () => {
    const v = parseTimestamp(manualSeek)
    if (v === null || v < 0) { setManualSeekErr(true); return }
    setManualSeekErr(false)
    setManualSeek('')
    seekWithLock(v)
  }

  // ── Drag logic for timeline handles ──
  const posToSec = (clientX: number): number => {
    if (!trackRef.current || dur <= 0) return 0
    const rect = trackRef.current.getBoundingClientRect()
    return Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * dur)
  }

  const startDrag = (handle: 'start' | 'end' | 'head') => (e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = handle
    const onMove = (me: MouseEvent) => {
      const sec = posToSec(me.clientX)
      if (draggingRef.current === 'start') {
        setStartSec(Math.max(0, Math.min(sec, endSec - 1)))
      } else if (draggingRef.current === 'end') {
        setEndSec(Math.min(dur || 999999, Math.max(sec, startSec + 1)))
      } else {
        // dragging playhead — seek
        seekWithLock(sec)
      }
    }
    const onUp = () => {
      draggingRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const clickTrack = (e: React.MouseEvent<HTMLDivElement>) => {
    if (draggingRef.current || dur <= 0) return
    const sec = posToSec(e.clientX)
    seekWithLock(sec)
  }

  const pct = (v: number) => dur > 0 ? Math.max(0, Math.min(100, (v / dur) * 100)) : 0
  const selectedDur = Math.max(0, endSec - startSec)
  const dlQuality = ftype === 'audio' ? 'mp3_best' : (platform === 'twitch' ? 'source' : '1080')

  if (!embedUrl) return null

  const panelStyle: React.CSSProperties = {
    ...(panelSize.width  ? { width:  panelSize.width  + 'px' } : {}),
    ...(panelSize.height ? { height: panelSize.height + 'px' } : {}),
  }

  return (
    <div className="vp-panel" ref={panelRef} style={panelStyle}>
      {/* Resize handles */}
      {(['nw','n','ne','e','se','s','sw','w'] as const).map(dir => (
        <div key={dir} className={`vp-resize-handle vp-rh-${dir}`} onMouseDown={startResize(dir)} />
      ))}
      {/* Header */}
      <div className="vp-head">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <span className="vp-title">{t.vp_title}</span>
        <span className="vp-cur">{secsToTimestamp(currentTime)}</span>
        <button className="vp-close" onClick={onClose}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      {/* Embedded player */}
      <div className="vp-player-wrap">
        {!ready && <div className="vp-loading"><span className="spin"/><span>{t.vp_loading}</span></div>}
        <webview ref={webviewRef} src={embedUrl} className="vp-webview"
          partition="persist:preview"
          allowpopups={false}
          useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
          style={{ visibility: ready ? 'visible' : 'hidden', width: '100%', height: '100%' }}/>
      </div>

      {/* Timeline — drag handles + playhead */}
      <div className="vp-timeline">
        <div className="vp-tl-info">
          <button className="vp-play-ctrl" onClick={togglePlay} disabled={!ready} title={playing ? 'Pause' : 'Play'}>
            {playing
              ? <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="3" width="4" height="18" rx="1"/><rect x="15" y="3" width="4" height="18" rx="1"/></svg>
              : <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            }
          </button>
          <span className="vp-tl-cur">{secsToTimestamp(currentTime)}</span>
          <span className="vp-tl-sel-info">
            <button className="vp-ts" onClick={() => seekTo(startSec)} title={t.vp_seek_hint}>{secsToTimestamp(startSec)}</button>
            <span className="vp-tl-arrow">→</span>
            <button className="vp-ts" onClick={() => seekTo(endSec)} title={t.vp_seek_hint}>{secsToTimestamp(endSec)}</button>
            {dur > 0 && <span className="vp-sel-dur">{secsToTimestamp(selectedDur)}</span>}
          </span>
          {dur > 0 && <span className="vp-tl-total">{secsToTimestamp(dur)}</span>}
        </div>

        <div className="vp-tl-track" ref={trackRef} onClick={clickTrack}>
          <div className="vp-tl-bg"/>
          {/* Selected range fill */}
          <div className="vp-tl-sel" style={{ left:`${pct(startSec)}%`, width:`${pct(endSec)-pct(startSec)}%` }}/>
          {/* Playhead */}
          <div className="vp-tl-head" style={{ left:`${pct(currentTime)}%` }} onMouseDown={startDrag('head')}/>
          {/* Start handle */}
          <div className="vp-tl-handle vp-tl-handle-s" style={{ left:`${pct(startSec)}%` }} onMouseDown={startDrag('start')} onClick={e => e.stopPropagation()}>
            <div className="vp-tl-handle-pip vp-pip-s"/>
            <div className="vp-tl-handle-label">{secsToTimestamp(startSec)}</div>
          </div>
          {/* End handle */}
          <div className="vp-tl-handle vp-tl-handle-e" style={{ left:`${pct(endSec)}%` }} onMouseDown={startDrag('end')} onClick={e => e.stopPropagation()}>
            <div className="vp-tl-handle-pip vp-pip-e"/>
            <div className="vp-tl-handle-label vp-label-right">{secsToTimestamp(endSec)}</div>
          </div>
        </div>

        <div className="vp-tl-edge-labels">
          <span>00:00:00</span>
          {dur > 0 && <span>{secsToTimestamp(dur)}</span>}
        </div>
      </div>

      {/* Mark + download row */}
      <div className="vp-footer">
        <div className="vp-button-flow transparent">
          <div className="vp-fmt-row-buttonBack">
            <button className="vp-mark-btn vp-mark-s" onClick={markStart} disabled={!ready}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="4" y="3" width="3" height="18" rx="1" fill="currentColor" stroke="none"/><line x1="7" y1="12" x2="20" y2="12"/></svg>
              {t.vp_mark_start}
            </button>
          </div>
                  {/* Row 2: manual time inputs */}
        <div className="vp-footer-row2">
          <div className="vp-time-group">
            <span className="vp-time-label">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="3" width="3" height="18" rx="1"/></svg>
              {t.vp_input_start}
            </span>
            <div className={`vp-time-field ${manualStartErr ? 'vp-time-err' : ''}`}>
              <input className="vp-time-input" type="text" placeholder="00:00:00"
                value={manualStart}
                onChange={e => { setManualStart(v => formatTimeInput(v, e.target.value)); setManualStartErr(false) }}
                onKeyDown={e => e.key === 'Enter' && applyManualStart()}
              />
              <button className="vp-time-apply" onClick={applyManualStart} title="Apply">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              </button>
            </div>
          </div>

          <div className="vp-time-group">
            <span className="vp-time-label">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="17" y="3" width="3" height="18" rx="1"/></svg>
              {t.vp_input_end}
            </span>
            <div className={`vp-time-field ${manualEndErr ? 'vp-time-err' : ''}`}>
              <input className="vp-time-input" type="text" placeholder="00:00:00"
                value={manualEnd}
                onChange={e => { setManualEnd(v => formatTimeInput(v, e.target.value)); setManualEndErr(false) }}
                onKeyDown={e => e.key === 'Enter' && applyManualEnd()}
              />
              <button className="vp-time-apply" onClick={applyManualEnd} title="Apply">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              </button>
            </div>
          </div>

          <div className="vp-time-group">
            <span className="vp-time-label">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg>
              {t.vp_input_seek}
            </span>
            <div className={`vp-time-field ${manualSeekErr ? 'vp-time-err' : ''}`}>
              <input className="vp-time-input" type="text" placeholder="00:00:00"
                value={manualSeek}
                onChange={e => { setManualSeek(v => formatTimeInput(v, e.target.value)); setManualSeekErr(false) }}
                onKeyDown={e => e.key === 'Enter' && applyManualSeek()}
              />
              <button className="vp-time-apply" onClick={applyManualSeek} title="Go">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              </button>
            </div>
          </div>

          <span className="vp-time-hint">HH:MM:SS</span>
        </div>
          <div className="vp-fmt-row-buttonBack">
            <button className="vp-mark-btn vp-mark-e" onClick={markEnd} disabled={!ready}>
              {t.vp_mark_end}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="17" y="3" width="3" height="18" rx="1" fill="currentColor" stroke="none"/><line x1="4" y1="12" x2="17" y2="12"/></svg>
            </button>
          </div>
        </div>
        <div className="vp-fmt-pow">
          <div className="vp-fmt-row">
            <button className={`vp-fmt-tab ${ftype==='video'?'vp-fmt-on':''}`} onClick={() => setFtype('video')}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
              Video
            </button>
            <button className={`vp-fmt-tab ${ftype==='audio'?'vp-fmt-on':''}`} onClick={() => setFtype('audio')}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
              Audio
            </button>
          </div>
        </div>
        <div className="vp-fmt-row-buttonBack">
          <button className="vp-dl-btn" disabled={selectedDur <= 0}
            onClick={() => onDownload(ftype, dlQuality, { start: startSec, end: dur > 0 && endSec >= dur ? -1 : endSec })}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 16l-4-4h2.5V4h3v8H16l-4 4z"/><path d="M20 18H4"/></svg>
            {t.vp_download}
            <span className="vp-dl-range">{secsToTimestamp(startSec)} → {secsToTimestamp(endSec)}</span>
          </button>
        </div>
      </div>
    </div>
  )
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
      checkVkSession: () => Promise<{ loggedIn: boolean }>
      extractVkCookies: () => Promise<{ success: boolean; error?: string }>
      checkTwitchSession: () => Promise<{ loggedIn: boolean }>
      extractTwitchCookies: () => Promise<{ success: boolean; error?: string }>
      fetchVideoInfo: (url: string) => Promise<{ success: boolean; data?: VideoInfo; error?: string }>
      fetchPlaylistInfo: (url: string) => Promise<{ success: boolean; entries?: PlaylistEntry[]; error?: string }>
      fetchTwitchChannel: (channelName: string, type: 'vods' | 'clips', refresh?: boolean) => Promise<{ success: boolean; entries?: PlaylistEntry[]; fromCache?: boolean; pinned?: boolean; fetchedAt?: number; error?: string }>
      getTwitchCacheMeta: (channelName: string) => Promise<{ vods: { fetchedAt: number; pinned: boolean } | null; clips: { fetchedAt: number; pinned: boolean } | null }>
      setTwitchChannelPin: (channelName: string, pinned: boolean) => Promise<{ success: boolean }>
      startDownload: (p: { id: string; url: string; formatArgs: string[]; downloadPath: string; sectionDuration?: number }) => Promise<{ success: boolean; error?: string }>
      cancelDownload: (id: string) => Promise<{ success: boolean }>
      openFolder: (path: string) => Promise<void>
      openExternal: (url: string) => Promise<void>
      openTwitchChat: (channel: string) => Promise<void>
      fetchTwitchFollowedLive: () => Promise<{ success: boolean; streams?: LiveStream[]; me?: { login: string; displayName: string; avatar: string }; error?: string }>
      getPreviewPort: () => Promise<number>
      onDownloadProgress: (cb: (d: { id: string; progress: number; speed: string; eta: string; hint?: string }) => void) => () => void
      onDownloadComplete: (cb: (d: { id: string }) => void) => () => void
      onDownloadError: (cb: (d: { id: string; error: string }) => void) => () => void
      // Updates
      checkForUpdates: () => Promise<UpdateInfo>
      downloadAndInstallUpdate: (url: string, name: string) => Promise<{ success: boolean; error?: string }>
      onUpdateAvailable: (cb: (d: UpdateInfo) => void) => () => void
      onUpdateDownloadProgress: (cb: (pct: number) => void) => () => void
      // ffmpeg
      checkFfmpeg: () => Promise<{ exists: boolean; path: string }>
      downloadFfmpeg: () => Promise<{ success: boolean; path?: string; error?: string }>
      onFfmpegDownloadProgress: (cb: (d: { step: string }) => void) => () => void
      // cookies staleness
      getCookiesStale: () => Promise<boolean>
      resetCookiesStale: () => Promise<boolean>
      selectCookiesFile: () => Promise<string | null>
      debugListFormats: (url: string) => Promise<{ stdout: string; stderr: string }>
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

function Sidebar({ view, onChange, activeCount, lang, onLangToggle, collapsed, onToggleCollapse }: {
  view: View; onChange: (v: View) => void; activeCount: number; lang: Lang; onLangToggle: () => void
  collapsed: boolean; onToggleCollapse: () => void
}) {
  const t = translations[lang]
  const NAV: { id: View; label: string; icon: JSX.Element }[] = [
    { id:'download', label:t.nav_download, icon:<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 16l-4-4h2.5V4h3v8H16l-4 4z"/><path d="M20 18H4"/></svg> },
    { id:'stream',   label:t.nav_stream,   icon:<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/></svg> },
    { id:'history',  label:t.nav_history,  icon:<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg> },
    { id:'settings', label:t.nav_settings, icon:<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg> },
  ]
  return (
    <aside className={`sidebar${collapsed?' sb-collapsed':''}`}>
      <div className="sb-logo">
        <StarLogo size={30} cls="sb-star"/>
        {!collapsed && <div className="sb-wordmark"><span className="sb-you">YOU</span><span className="sb-dl">DOWNLOAD</span></div>}
        <button className="sb-toggle" onClick={onToggleCollapse} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            {collapsed
              ? <polyline points="9 18 15 12 9 6"/>
              : <polyline points="15 18 9 12 15 6"/>}
          </svg>
        </button>
      </div>
      <div className="sb-divider"/>
      <nav className="sb-nav">
        {NAV.map(item => (
          <button key={item.id} className={`sb-item ${view===item.id?'sb-item-active':''}`} onClick={() => onChange(item.id)}
            title={collapsed ? item.label : undefined}>
            <span className="sb-indicator"/><span className="sb-icon">{item.icon}</span>
            {!collapsed && <span className="sb-label">{item.label}</span>}
            {item.id==='download' && activeCount>0 && <span className="sb-badge">{activeCount}</span>}
          </button>
        ))}
      </nav>
      <div className="sb-footer">
        {!collapsed && (
          <button className="lang-toggle" onClick={onLangToggle}>
            <span className={`lang-opt ${lang==='en'?'lang-opt-on':''}`}>EN</span>
            <span className="lang-sep"/>
            <span className={`lang-opt ${lang==='ru'?'lang-opt-on':''}`}>RU</span>
          </button>
        )}
        {collapsed && (
          <button className="lang-toggle" onClick={onLangToggle} title={lang === 'en' ? 'Switch to RU' : 'Switch to EN'}
            style={{justifyContent:'center', padding:'5px 0'}}>
            <span className="lang-opt lang-opt-on" style={{flex:'unset', padding:'4px 6px'}}>{lang.toUpperCase()}</span>
          </button>
        )}
        <div className="sb-status-row"><span className="sb-dot"/>{!collapsed && <span className="sb-ready">{t.status_ready}</span>}</div>
        {!collapsed && <div className="sb-version">v1.1.1</div>}
      </div>
    </aside>
  )
}

// ═══════════════════════ URL INPUT ═══════════════════════

/** Если введён просто ник (без http и точек) — считаем Twitch-никнеймом */
function normalizeTwitchInput(val: string): string {
  const v = val.trim()
  if (!v) return v
  if (v.startsWith('http://') || v.startsWith('https://')) return v
  // Содержит точку — скорее всего домен, добавляем https://
  if (v.includes('.')) return `https://${v}`
  // Чистый никнейм — подставляем Twitch
  return `https://www.twitch.tv/${v}`
}

function UrlInput({ onFetch, loading, t, platform, onPlatformChange }: {
  onFetch: (url: string) => void; loading: boolean; t: Translations; platform: Platform; onPlatformChange: (p: Platform) => void
}) {
  const [url, setUrl] = useState('')
  const submit = () => {
    if (!url.trim() || loading) return
    const normalized = normalizeTwitchInput(url.trim())
    if (normalized !== url) setUrl(normalized)
    onFetch(normalized)
  }
  const handleChange = (val: string) => { setUrl(val); const d = detectPlatform(val); if (d !== platform) onPlatformChange(d) }
  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      handleChange(text)
      if (text.includes('youtube.com') || text.includes('youtu.be') || text.includes('music.youtube') || text.includes('twitch.tv') || text.includes('vk.com') || text.includes('vkvideo.ru'))
        setTimeout(() => onFetch(normalizeTwitchInput(text.trim())), 80)
    } catch { /* blocked */ }
  }
  const placeholder = platform === 'twitch' ? 'simfonira  or  twitch.tv/videos/...' : platform === 'vk' ? 'https://vk.com/video-123456_789  or  vkvideo.ru/...' : 'https://youtube.com/watch?v=...'
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
        <button className={`platform-btn ${platform==='vk'?'platform-btn-on platform-btn-vk':''}`} onClick={() => onPlatformChange('vk')}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M21.3 0H2.7C1.2 0 0 1.2 0 2.7v18.6C0 22.8 1.2 24 2.7 24h18.6c1.5 0 2.7-1.2 2.7-2.7V2.7C24 1.2 22.8 0 21.3 0zm-1.6 16.9h-2c-.8 0-1-.6-2.3-1.9-1.1-1.2-1.6-1.3-1.9-1.3-.4 0-.5.1-.5.7v1.7c0 .5-.2.8-1.4.8-2 0-4.2-1.2-5.8-3.5C4.3 10.6 3.6 8 3.6 7.5c0-.3.1-.5.7-.5h2c.5 0 .7.2.9.8.9 2.5 2.5 4.7 3.1 4.7.2 0 .3-.1.3-.7V9c-.1-1.5-.9-1.6-.9-2.1 0-.3.2-.5.6-.5h3.1c.4 0 .6.2.6.8v3.5c0 .4.2.6.3.6.2 0 .4-.1.8-.5 1.3-1.5 2.2-3.7 2.2-3.7.1-.3.4-.6.9-.6h2c.6 0 .7.3.6.8-.3 1.2-2.8 4.8-2.8 4.8-.2.3-.3.5 0 .9.2.3.9.9 1.4 1.5.9.9 1.5 1.7 1.7 2.2.2.5-.1.8-.6.8z"/></svg>
          VK
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
      <p className="url-hint">{platform==='twitch' ? t.twitch_hint : platform==='vk' ? t.vk_hint : t.url_hint}</p>
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

function FormatSelector({ onDownload, onDownloadAll, disabled, t, initType, initVq, initAq, onFormatChange, playlist, platform, availableQualities, duration, onOpenPlayer }: {
  onDownload: (type: FormatType, q: string, timeRange?: { start: number; end: number }) => void; onDownloadAll?: (type: FormatType, q: string) => void
  disabled: boolean; t: Translations; initType: FormatType; initVq: VideoQuality; initAq: AudioQuality
  onFormatChange: (type: FormatType, vq: VideoQuality, aq: AudioQuality) => void
  playlist?: PlaylistEntry[] | null; platform?: Platform
  availableQualities?: VideoQuality[]; duration?: number
  onOpenPlayer?: () => void
}) {
  const [ftype, setFtype] = useState<FormatType>(initType)
  const [vq, setVq] = useState<VideoQuality>(initVq)
  const [aq, setAq] = useState<AudioQuality>(initAq)
  const [tq, setTq] = useState<TwitchQuality>('source')
  const [useTimeRange, setUseTimeRange] = useState(false)
  const [trStart, setTrStart] = useState(0)
  const [trEnd, setTrEnd] = useState(duration ?? 0)

  useEffect(() => {
    if (duration && duration > 0) setTrEnd(duration)
  }, [duration])
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
  const go = () => {
    const timeRange = (useTimeRange && isTwitch && duration && duration > 0)
      ? { start: trStart, end: trEnd >= duration ? -1 : trEnd }
      : undefined
    onDownload(ftype, isTwitch ? (ftype==='video'?tq:'mp3_best') : (ftype==='video'?safeVq:aq), timeRange)
  }
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
      {(platform === 'twitch' || platform === 'youtube') && onOpenPlayer && (
        <button className="vp-open-btn" onClick={onOpenPlayer}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          {t.vp_open_player}
        </button>
      )}
      {isTwitch && !onOpenPlayer && (
        <div className="time-range-section">
          <div className="time-range-header">
            <button className={`time-range-toggle ${useTimeRange?'time-range-toggle-on':''}`} onClick={()=>setUseTimeRange(v=>!v)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg>
              <span>{t.time_range_toggle}</span>
              <svg className={`tr-arrow${useTimeRange?' tr-arrow-open':''}`} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
          </div>
          {useTimeRange && (
            <div className="time-range-body">
              {duration && duration > 0
                ? <TimeRangePicker duration={duration} startSec={trStart} endSec={trEnd} onChange={(s,e)=>{setTrStart(s);setTrEnd(e)}}/>
                : <p className="tr-no-dur">{t.time_range_no_duration}</p>
              }
            </div>
          )}
        </div>
      )}
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

/** Extract a JS Date from a PlaylistEntry.
 *  yt-dlp may return: upload_date "YYYYMMDD", timestamp (unix), release_timestamp,
 *  epoch, modified_date, or ISO strings in various fields. */
function entryDate(entry: PlaylistEntry): Date | null {
  const e = entry as any

  // Unix timestamp fields (seconds)
  for (const key of ['timestamp', 'release_timestamp', 'epoch', 'modified_timestamp']) {
    if (typeof e[key] === 'number' && e[key] > 0) return new Date(e[key] * 1000)
  }

  // YYYYMMDD string fields
  for (const key of ['upload_date', 'release_date', 'modified_date']) {
    const v: string | undefined = e[key]
    if (v && /^\d{8}$/.test(v)) {
      return new Date(`${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}`)
    }
  }

  // ISO date strings (e.g. "2024-03-15T20:00:00Z")
  for (const key of ['upload_date_str', 'start_time', 'created_at']) {
    const v: string | undefined = e[key]
    if (v && v.includes('-')) {
      const d = new Date(v)
      if (!isNaN(d.getTime())) return d
    }
  }

  return null
}

/** Format a Date as YYYY-MM-DD for display */
function fmtDateYMD(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function TwitchChannelBrowser({ channelName, t, onSelect, onDownloadMulti }: {
  channelName: string; t: Translations
  onSelect: (entry: PlaylistEntry, url: string) => void
  onDownloadMulti: (items: TwitchSelected[]) => void
}) {
  const [tab, setTab] = useState<'vods'|'clips'>('vods')
  const [allEntries, setAllEntries] = useState<Record<string, PlaylistEntry[]>>({ vods:[], clips:[] })
  const [loadingTab, setLoadingTab] = useState<'vods'|'clips'|null>(null)
  const [fromCache, setFromCache] = useState<Record<string, boolean>>({ vods: false, clips: false })
  const [fetchedAt, setFetchedAt] = useState<Record<string, number | null>>({ vods: null, clips: null })
  const [pinned, setPinned] = useState(false)
  const [refreshingTab, setRefreshingTab] = useState<'vods'|'clips'|null>(null)
  const loadedRef = useRef<Record<string,boolean>>({})
  // Счётчик поколений: при смене канала инкрементируется — старые ответы игнорируются
  const genRef = useRef(0)
  const [selected, setSelected] = useState<Record<string, TwitchSelected>>({})
  const [searchQuery, setSearchQuery] = useState('')
  // Date filter state
  const [dateMode, setDateMode] = useState<'range'|'exact'>('range')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dateExact, setDateExact] = useState('')
  const [showDateFilter, setShowDateFilter] = useState(false)

  const load = async (type: 'vods'|'clips', forceRefresh = false) => {
    if (loadedRef.current[type] && !forceRefresh) return
    loadedRef.current[type] = true
    const myGen = genRef.current

    if (forceRefresh) {
      setRefreshingTab(type)
    } else {
      setLoadingTab(type)
    }

    const r = await window.api?.fetchTwitchChannel(channelName, type, forceRefresh)
    if (genRef.current !== myGen) return

    if (r?.success && r.entries) {
      setAllEntries(p => ({...p, [type]: r.entries}))
      setFromCache(p => ({...p, [type]: !!r.fromCache}))
      if (r.fetchedAt) setFetchedAt(p => ({...p, [type]: r.fetchedAt!}))
      // NOTE: we do NOT set pinned from fetchTwitchChannel response —
      // pin state is managed exclusively by getTwitchCacheMeta + togglePin
      // to avoid race conditions when switching channels.

      // If result came from cache, silently refresh in background
      if (r.fromCache && !forceRefresh) {
        window.api?.fetchTwitchChannel(channelName, type, true).then(fresh => {
          if (genRef.current !== myGen) return
          if (fresh?.success && fresh.entries) {
            setAllEntries(p => ({...p, [type]: fresh.entries}))
            setFromCache(p => ({...p, [type]: false}))
            if (fresh.fetchedAt) setFetchedAt(p => ({...p, [type]: fresh.fetchedAt!}))
          }
        }).catch(() => {})
      }
    }

    setLoadingTab(null)
    setRefreshingTab(null)
  }

  // Toggle pin for this channel — persists across sessions
  const togglePin = async () => {
    const next = !pinned
    setPinned(next)
    await window.api?.setTwitchChannelPin(channelName, next)
  }

  useEffect(() => {
    genRef.current++
    loadedRef.current = {}
    setAllEntries({ vods:[], clips:[] })
    setFromCache({ vods: false, clips: false })
    setFetchedAt({ vods: null, clips: null })
    // Reset pin first, then fetch the real value — prevents stale state from prev channel
    setPinned(false)
    setLoadingTab(null)
    setRefreshingTab(null)
    setSearchQuery('')
    setDateFrom('')
    setDateTo('')
    setDateExact('')
    setShowDateFilter(false)
    setTab('vods')
    // Fetch pin status first so it's ready before the user can interact
    window.api?.getTwitchCacheMeta(channelName).then(meta => {
      // Only update if we're still on this channel (gen guard)
      const isPinned = !!(meta?.vods?.pinned || meta?.clips?.pinned)
      setPinned(isPinned)
      if (meta?.vods?.fetchedAt) setFetchedAt(p => ({...p, vods: meta.vods!.fetchedAt}))
      if (meta?.clips?.fetchedAt) setFetchedAt(p => ({...p, clips: meta.clips!.fetchedAt}))
    }).catch(() => {})
    load('vods')
  }, [channelName])
  const switchTab = (type: 'vods'|'clips') => { setTab(type); load(type) }
  const loading = loadingTab !== null
  const refreshing = refreshingTab === tab

  const toggleSelect = (entry: PlaylistEntry, url: string) => {
    setSelected(p => {
      if (p[entry.id]) { const n = {...p}; delete n[entry.id]; return n }
      return {...p, [entry.id]: { entry, url, tab }}
    })
  }

  const selectedList = Object.values(selected)
  // Text search filter
  const afterSearch = searchQuery.trim()
    ? allEntries[tab].filter(e => e.title?.toLowerCase().includes(searchQuery.toLowerCase()))
    : allEntries[tab]

  // Date filter
  const dateFilterActive = (dateMode === 'exact' && dateExact) || (dateMode === 'range' && (dateFrom || dateTo))
  const entries = dateFilterActive ? afterSearch.filter(e => {
    const d = entryDate(e)
    if (!d) return false
    const ds = fmtDateYMD(d)
    if (dateMode === 'exact') return ds === dateExact
    if (dateFrom && ds < dateFrom) return false
    if (dateTo && ds > dateTo) return false
    return true
  }) : afterSearch

  return (
    <div className="twitch-browser">
      <div className="twitch-browser-head">
        <div className="twitch-channel-name">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="#9146FF"><path d="M11.6 6H13v4.5h-1.4V6zm3.8 0H17v4.5h-1.4V6zM2.2 0L0 5.4V21h5.4v3h3l3-3h4.5L24 12.6V0H2.2zm20.4 11.7-3.6 3.6h-5.4l-3 3v-3H5.4V1.4h17.2v10.3z"/></svg>
          <span>{channelName}</span>
        </div>
        <button className="twitch-open-btn" onClick={() => window.api?.openExternal(`https://www.twitch.tv/${channelName}/videos`)} title="Open on Twitch">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          Twitch
        </button>
        {/* Pin toggle — keeps cache forever, survives app restart */}
        <button
          className={`twitch-pin-btn${pinned ? ' twitch-pin-on' : ''}`}
          onClick={togglePin}
          title={pinned ? t.twitch_pinned_hint : t.twitch_pin_hint}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
          </svg>
          <span>{pinned ? t.twitch_pinned : t.twitch_pin}</span>
        </button>
        <button
          className={`twitch-refresh-btn${refreshing ? ' twitch-refresh-spin' : ''}${fromCache[tab] ? ' twitch-refresh-cached' : ''}`}
          onClick={() => load(tab, true)}
          disabled={loading || refreshing}
          title={
            fromCache[tab] && fetchedAt[tab]
              ? `Cached ${formatCacheAge(fetchedAt[tab]!)} — click to refresh`
              : 'Refresh'
          }
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          {fromCache[tab] && !refreshing && <span className="twitch-cache-dot" title="From cache"/>}
        </button>
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
      <div className="twitch-search">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input
          className="twitch-search-input"
          type="text"
          placeholder={t.twitch_search_placeholder}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
        {searchQuery && <button className="twitch-search-clear" onClick={() => setSearchQuery('')}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>}
      </div>

      {/* Date filter */}
      <div className="twitch-date-filter">
        <button
          className={`twitch-date-toggle${showDateFilter ? ' twitch-date-toggle-on' : ''}${dateFilterActive ? ' twitch-date-active' : ''}`}
          onClick={() => setShowDateFilter(v => !v)}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="4" width="18" height="18" rx="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/>
            <line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          <span>{t.twitch_date_filter_label}</span>
          {dateFilterActive && <span className="twitch-date-badge">{entries.length}</span>}
          <svg className={`tr-arrow${showDateFilter ? ' tr-arrow-open' : ''}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        {showDateFilter && (
          <div className="twitch-date-body">
            <div className="twitch-date-mode-row">
              <button className={`twitch-date-mode-btn${dateMode === 'range' ? ' on' : ''}`} onClick={() => setDateMode('range')}>{t.twitch_date_mode_range}</button>
              <button className={`twitch-date-mode-btn${dateMode === 'exact' ? ' on' : ''}`} onClick={() => setDateMode('exact')}>{t.twitch_date_mode_exact}</button>
            </div>
            {dateMode === 'range' ? (
              <div className="twitch-date-range-row">
                <label className="twitch-date-label">{t.twitch_date_from}</label>
                <input type="date" className="twitch-date-input" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
                <label className="twitch-date-label">{t.twitch_date_to}</label>
                <input type="date" className="twitch-date-input" value={dateTo} onChange={e => setDateTo(e.target.value)} />
              </div>
            ) : (
              <div className="twitch-date-range-row">
                <label className="twitch-date-label">{t.twitch_date_exact}</label>
                <input type="date" className="twitch-date-input" value={dateExact} onChange={e => setDateExact(e.target.value)} />
              </div>
            )}
            {!!dateFilterActive && (
              <button className="twitch-date-clear" onClick={() => { setDateFrom(''); setDateTo(''); setDateExact('') }}>
                {t.twitch_date_clear}
              </button>
            )}
          </div>
        )}
      </div>

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
                <div className="twitch-entry-meta">
                  <span className="twitch-entry-title">{entry.title}</span>
                  {entryDate(entry) && (
                    <span className="twitch-entry-date">{fmtDateYMD(entryDate(entry)!)}</span>
                  )}
                </div>
                <svg className="twitch-entry-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
              <button className="twitch-entry-open" onClick={e=>{e.stopPropagation();window.api?.openExternal(videoUrl)}} title="Watch on Twitch">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
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

function DownloadCard({ item, onCancel, onOpen, onCookieHint, onFfmpegHint, t, lang }: {
  item: DownloadItem; onCancel: (id: string) => void; onOpen: (id: string) => void; onCookieHint: () => void; onFfmpegHint: () => void; t: Translations; lang: Lang
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
          {item.speed === 'ssl_retry'
            ? <span className="dl-ssl-retry"><span className="spin" style={{width:9,height:9}}/>{lang==='ru'?'Повтор (SSL)…':'Retrying (SSL)…'}</span>
            : item.speed && <span className="dl-speed">{item.speed}</span>}
          {item.speed !== 'ssl_retry' && item.eta && <span className="dl-eta">{t.eta} {item.eta}</span>}
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
            {isAgeGate(item.error) ? (
              <span className="dl-err">
                {t.lang === 'ru' ? 'Возрастное ограничение — ' : 'Age-restricted — '}
                <button className="dl-cookie-hint" onClick={onCookieHint}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                  {t.err_cookie_hint}
                </button>
              </span>
            ) : isSslError(item.error) ? (
              <span className="dl-err dl-err-ssl">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                {lang==='ru'
                  ? 'Ошибка SSL-соединения с Twitch. Попробуй снова — обычно помогает с 1–2 попытки.'
                  : 'SSL connection error with Twitch. Try again — usually works after 1–2 retries.'}
              </span>
            ) : (
              <span className="dl-err">{item.error}</span>
            )}
            {!isAgeGate(item.error) && !isSslError(item.error) && isCookieError(item.error) && (
              <button className="dl-cookie-hint" onClick={onCookieHint}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                {t.err_cookie_hint}
              </button>
            )}
            {isFfmpegError(item.error) && (
              <button className="dl-cookie-hint dl-ffmpeg-hint" onClick={onFfmpegHint}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                {t.err_ffmpeg_install ?? 'Install ffmpeg'}
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

function SettingsView({ settings, onSave, onPickFolder, t, theme, onThemeChange, highlightCookies, autoCheckUpdates, onAutoCheckChange, onManualCheck, twitchLoggedIn, twitchExtractState, twitchExtractError, onTwitchExtract }: {
  settings: AppSettings; onSave: (s: AppSettings) => void; onPickFolder: () => void
  t: Translations; theme: Theme; onThemeChange: (th: Theme) => void; highlightCookies: boolean
  autoCheckUpdates: boolean; onAutoCheckChange: (v: boolean) => void
  onManualCheck: () => void
  twitchLoggedIn: boolean
  twitchExtractState: 'idle'|'busy'|'ok'|'fail'
  twitchExtractError: string
  onTwitchExtract: () => void
}) {
  const [local, setLocal] = useState(settings)
  const [updateState, setUpdateState] = useState<'idle'|'busy'|'ok'|'fail'>('idle')
  const [checkState, setCheckState] = useState<'idle'|'busy'|'ok'>('idle')
  const [extractState, setExtractState] = useState<'idle'|'busy'|'ok'|'fail'>('idle')
  const [extractError, setExtractError] = useState('')
  const [ytLoggedIn, setYtLoggedIn] = useState(false)
  const [vkExtractState, setVkExtractState] = useState<'idle'|'busy'|'ok'|'fail'>('idle')
  const [vkExtractError, setVkExtractError] = useState('')
  const [vkLoggedIn, setVkLoggedIn] = useState(false)
  const cookiesRef = useRef<HTMLDivElement>(null)

  useEffect(() => { window.api?.checkYtSession().then(r => setYtLoggedIn(r.loggedIn)).catch(()=>{}) }, [])
  useEffect(() => { window.api?.checkVkSession().then(r => setVkLoggedIn(r.loggedIn)).catch(()=>{}) }, [])
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
  const handleVkExtract = async () => {
    setVkExtractState('busy'); setVkExtractError('')
    const r = await window.api?.extractVkCookies()
    if (r?.success) { setVkExtractState('ok'); setVkLoggedIn(true) }
    else { setVkExtractState('fail'); setVkExtractError(r?.error||'') }
    setTimeout(() => setVkExtractState('idle'), 5000)
  }
  console.log('[SettingsView] render', { twitchLoggedIn, twitchExtractState })
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
        <div className="set-label">{t.set_extract_vk_cookies}</div>
        <p className="set-hint">{t.set_extract_vk_cookies_hint}</p>
        <button className={`set-extract-btn ${vkExtractState==='ok'?'set-extract-ok':vkExtractState==='fail'?'set-extract-fail':''}`} onClick={handleVkExtract} disabled={vkExtractState==='busy'}>
          {vkExtractState==='busy' ? <><span className="spin"/>{t.set_extracting}</>
           : vkExtractState==='ok' ? <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>{t.set_extract_vk_ok}</>
           : vkExtractState==='fail' ? <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>{t.set_extract_vk_fail}</>
           : <><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M21.3 0H2.7C1.2 0 0 1.2 0 2.7v18.6C0 22.8 1.2 24 2.7 24h18.6c1.5 0 2.7-1.2 2.7-2.7V2.7C24 1.2 22.8 0 21.3 0zm-1.6 16.9h-2c-.8 0-1-.6-2.3-1.9-1.1-1.2-1.6-1.3-1.9-1.3-.4 0-.5.1-.5.7v1.7c0 .5-.2.8-1.4.8-2 0-4.2-1.2-5.8-3.5C4.3 10.6 3.6 8 3.6 7.5c0-.3.1-.5.7-.5h2c.5 0 .7.2.9.8.9 2.5 2.5 4.7 3.1 4.7.2 0 .3-.1.3-.7V9c-.1-1.5-.9-1.6-.9-2.1 0-.3.2-.5.6-.5h3.1c.4 0 .6.2.6.8v3.5c0 .4.2.6.3.6.2 0 .4-.1.8-.5 1.3-1.5 2.2-3.7 2.2-3.7.1-.3.4-.6.9-.6h2c.6 0 .7.3.6.8-.3 1.2-2.8 4.8-2.8 4.8-.2.3-.3.5 0 .9.2.3.9.9 1.4 1.5.9.9 1.5 1.7 1.7 2.2.2.5-.1.8-.6.8z"/></svg>{t.set_extract_vk_cookies}{vkLoggedIn&&<span className="set-extract-browser">✓ signed in</span>}</>}
        </button>
        {vkExtractState==='fail' && vkExtractError && <p className="set-extract-error">{vkExtractError}</p>}
      </div>
      <div className="set-group">
        <div className="set-label">{t.set_extract_twitch_cookies}</div>
        <p className="set-hint">{t.set_extract_twitch_cookies_hint}</p>
        <button className={`set-extract-btn ${twitchExtractState==='ok'?'set-extract-ok':twitchExtractState==='fail'?'set-extract-fail':''}`} onClick={onTwitchExtract} disabled={twitchExtractState==='busy'}>
          {twitchExtractState==='busy' ? <><span className="spin"/>{t.set_extracting}</>
           : twitchExtractState==='ok' ? <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>{t.set_extract_twitch_ok}</>
           : twitchExtractState==='fail' ? <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>{t.set_extract_twitch_fail}</>
           : <><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M11.6 6H13v4.5h-1.4V6zm3.8 0H17v4.5h-1.4V6zM2.2 0L0 5.4V21h5.4v3h3l3-3h4.5L24 12.6V0H2.2zm20.4 11.7-3.6 3.6h-5.4l-3 3v-3H5.4V1.4h17.2v10.3z"/></svg>{t.set_extract_twitch_cookies}{twitchLoggedIn&&<span className="set-extract-browser">✓ signed in</span>}</>}
        </button>
        {twitchExtractState==='fail' && twitchExtractError && <p className="set-extract-error">{twitchExtractError}</p>}
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

// ═══════════════════════ STREAM VIEW ═══════════════════════

// ═══════════════════════ FOLLOWED LIVE PANEL ═══════════════════════

function formatViewers(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function FollowedLivePanel({ onSelect, t }: { onSelect: (channel: string) => void; t: Translations }) {
  const [streams, setStreams] = useState<LiveStream[]>([])
  const [me, setMe] = useState<{ login: string; displayName: string; avatar: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastFetch, setLastFetch] = useState(0)
  const [favs, setFavs] = useState<string[]>([])

  // Load favorites on mount
  useEffect(() => { loadFavStreamers().then(setFavs) }, [])

  const toggleFav = async (login: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const next = favs.includes(login) ? favs.filter(l => l !== login) : [...favs, login]
    setFavs(next)
    await saveFavStreamers(next)
  }

  const fetch = async () => {
    setLoading(true); setError(null)
    const r = await window.api.fetchTwitchFollowedLive()
    setLoading(false)
    if (r.success) {
      setStreams(r.streams ?? [])
      setMe(r.me ?? null)
      setLastFetch(Date.now())
    } else {
      setError(r.error ?? 'error')
    }
  }

  useEffect(() => { fetch() }, [])

  // Refresh every 90 seconds while mounted
  useEffect(() => {
    const iv = setInterval(() => fetch(), 90_000)
    return () => clearInterval(iv)
  }, [])

  // Sort: favorites first, then by viewers
  const sorted = [...streams].sort((a, b) => {
    const aFav = favs.includes(a.login) ? 1 : 0
    const bFav = favs.includes(b.login) ? 1 : 0
    if (bFav !== aFav) return bFav - aFav
    return b.viewers - a.viewers
  })

  // Also show offline favorites as placeholders
  const offlineFavs = favs.filter(login => !streams.find(s => s.login === login))

  if (error === 'not_logged_in') {
    return (
      <div className="flp-not-logged">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" opacity="0.3"><path d="M11.6 6H13v4.5h-1.4V6zm3.8 0H17v4.5h-1.4V6zM2.2 0L0 5.4V21h5.4v3h3l3-3h4.5L24 12.6V0H2.2zm20.4 11.7-3.6 3.6h-5.4l-3 3v-3H5.4V1.4h17.2v10.3z"/></svg>
        <span>{t.flp_login_hint}</span>
      </div>
    )
  }

  return (
    <div className="flp-wrap">
      <div className="flp-head">
        {me && (
          <div className="flp-me">
            <img src={me.avatar} className="flp-me-avatar" alt=""/>
            <span className="flp-me-name">{me.displayName}</span>
          </div>
        )}
        <span className="flp-title">
          {t.flp_title}
          {streams.length > 0 && <span className="flp-count">{streams.length}</span>}
        </span>
        <button className="flp-refresh" onClick={fetch} disabled={loading} title={t.flp_refresh}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
            style={loading ? { animation: 'spin 0.7s linear infinite' } : undefined}>
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
      </div>

      {loading && streams.length === 0 && (
        <div className="flp-loading"><span className="spin"/></div>
      )}

      {!loading && streams.length === 0 && !error && favs.length === 0 && (
        <div className="flp-empty">{t.flp_empty}</div>
      )}

      {error && error !== 'not_logged_in' && (
        <div className="flp-error">{error}</div>
      )}

      <div className="flp-list">
        {/* Live streams (sorted: favs first) */}
        {sorted.map(s => {
          const isFav = favs.includes(s.login)
          return (
            <button key={s.login} className={`flp-item${isFav ? ' flp-item-fav' : ''}`} onClick={() => onSelect(s.login)}>
              <div className="flp-avatar-wrap">
                <img src={s.avatar} className="flp-avatar" alt=""/>
                <span className="flp-live-dot"/>
              </div>
              <div className="flp-info">
                <div className="flp-name-row">
                  <span className="flp-name">{s.displayName}</span>
                  {isFav && (
                    <svg className="flp-fav-badge" width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                  )}
                </div>
                <span className="flp-game">{s.game}</span>
                <span className="flp-ttl">{s.title}</span>
              </div>
              <div className="flp-right">
                <div className="flp-viewers">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>
                  {formatViewers(s.viewers)}
                </div>
                <button
                  className={`flp-star-btn${isFav ? ' flp-star-on' : ''}`}
                  onClick={e => toggleFav(s.login, e)}
                  title={isFav ? (t.flp_unfav ?? 'Remove from favorites') : (t.flp_fav ?? 'Add to favorites')}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill={isFav ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                  </svg>
                </button>
              </div>
            </button>
          )
        })}

        {/* Offline favorites pinned at bottom */}
        {offlineFavs.map(login => (
          <button key={`offline-${login}`} className="flp-item flp-item-offline" onClick={() => onSelect(login)}>
            <div className="flp-avatar-wrap">
              <div className="flp-avatar-ph">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" opacity="0.4"><path d="M11.6 6H13v4.5h-1.4V6zm3.8 0H17v4.5h-1.4V6zM2.2 0L0 5.4V21h5.4v3h3l3-3h4.5L24 12.6V0H2.2zm20.4 11.7-3.6 3.6h-5.4l-3 3v-3H5.4V1.4h17.2v10.3z"/></svg>
              </div>
              <span className="flp-offline-dot"/>
            </div>
            <div className="flp-info">
              <div className="flp-name-row">
                <span className="flp-name flp-name-dim">{login}</span>
                <svg className="flp-fav-badge" width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
              </div>
              <span className="flp-offline-label">{t.flp_offline ?? 'Offline'}</span>
            </div>
            <div className="flp-right">
              <button
                className="flp-star-btn flp-star-on"
                onClick={e => toggleFav(login, e)}
                title={t.flp_unfav ?? 'Remove from favorites'}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
              </button>
            </div>
          </button>
        ))}
      </div>

      {lastFetch > 0 && (
        <div className="flp-updated">
          {t.flp_updated} {new Date(lastFetch).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}
    </div>
  )
}

function normalizeTwitchChannel(val: string): string {
  const v = val.trim()
  if (!v) return ''
  // full URL — extract channel name
  try {
    const u = new URL(v.startsWith('http') ? v : `https://${v}`)
    if (u.hostname.includes('twitch.tv')) {
      const parts = u.pathname.split('/').filter(Boolean)
      if (parts.length >= 1) return parts[0].toLowerCase()
    }
  } catch { /* ignore */ }
  // plain nickname — no dots, no slashes
  if (!v.includes('.') && !v.includes('/')) return v.toLowerCase()
  return v.toLowerCase()
}

function StreamView({ t, downloadPath, persistedInput, persistedChannelName, persistedMarkers, streamSessions, hidden, onInputChange, onChannelChange, onMarkersChange, onSessionsChange, onStartDownload }: {
  t: Translations
  downloadPath: string
  persistedInput: string
  persistedChannelName: string | null
  persistedMarkers: StreamMarker[]
  streamSessions: StreamSession[]
  hidden: boolean
  onInputChange: (v: string) => void
  onChannelChange: (v: string | null) => void
  onMarkersChange: (v: StreamMarker[]) => void
  onSessionsChange: (v: StreamSession[] | ((prev: StreamSession[]) => StreamSession[])) => void
  onStartDownload: (item: DownloadItem, formatArgs: string[]) => void
}) {
  const [embedUrl, setEmbedUrl] = useState<string | null>(null)
  const [playerReady, setPlayerReady] = useState(false)
  const [streamPos, setStreamPos] = useState(0)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [streamTab, setStreamTab] = useState<'live' | 'sessions'>('live')
  const [streamTitle, setStreamTitle] = useState<string | null>(null)
  const webviewRef = useRef<any>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const currentSessionId = useRef<string | null>(null)

  // Восстанавливаем ID текущей сессии если канал уже был открыт
  useEffect(() => {
    if (persistedChannelName && !currentSessionId.current) {
      const existing = streamSessions.find(s => s.channelName === persistedChannelName)
      currentSessionId.current = existing ? existing.id : `sess_${persistedChannelName}_${Date.now()}`
    }
  }, [])

  const saveCurrentSession = (markers: StreamMarker[], channel: string | null, sessions: StreamSession[]) => {
    if (!channel || !currentSessionId.current) return sessions
    const id = currentSessionId.current
    const idx = sessions.findIndex(s => s.id === id)
    if (idx >= 0) {
      return sessions.map(s => s.id === id ? { ...s, markers, streamTitle: streamTitle ?? s.streamTitle, lastActiveAt: Date.now() } : s)
    }
    const newSess: StreamSession = { id, channelName: channel, streamTitle: streamTitle ?? undefined, startedAt: Date.now(), lastActiveAt: Date.now(), markers }
    return [newSess, ...sessions]
  }

  // При маунте — восстанавливаем плеер если уже был открыт канал
  useEffect(() => {
    if (persistedChannelName && !embedUrl) {
      window.api.getPreviewPort().then(port => {
        setEmbedUrl(`http://localhost:${port}/?channel=${persistedChannelName}`)
      }).catch(() => {
        setEmbedUrl(`https://player.twitch.tv/?channel=${persistedChannelName}&parent=localhost&autoplay=true`)
      })
    }
  }, [])

  // Получаем название трансляции через Twitch GQL API
  useEffect(() => {
    if (!persistedChannelName) return
    const fetchTitle = async () => {
      try {
        const res = await fetch('https://gql.twitch.tv/gql', {
          method: 'POST',
          headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
          body: JSON.stringify([{ query: `query{user(login:"${persistedChannelName}"){stream{title}}}` }])
        })
        const data = await res.json()
        const title = data?.[0]?.data?.user?.stream?.title
        if (typeof title === 'string' && title.trim()) setStreamTitle(title.trim())
      } catch { /* ignore */ }
    }
    fetchTitle()
    // Обновляем каждые 2 минуты (стримеры меняют title)
    const iv = setInterval(fetchTitle, 120_000)
    return () => clearInterval(iv)
  }, [persistedChannelName])

  // При получении streamTitle — сразу сохраняем в сессию
  useEffect(() => {
    if (!streamTitle || !persistedChannelName || !currentSessionId.current) return
    onSessionsChange(prev => {
      const id = currentSessionId.current!
      const idx = prev.findIndex(s => s.id === id)
      if (idx >= 0) {
        return prev.map(s => s.id === id ? { ...s, streamTitle } : s)
      }
      const newSess: StreamSession = {
        id, channelName: persistedChannelName, streamTitle,
        startedAt: Date.now(), lastActiveAt: Date.now(), markers: persistedMarkers
      }
      return [newSess, ...prev]
    })
  }, [streamTitle])

  // Подписка на dom-ready
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv || !embedUrl) return

    const onReady = async () => {
      setPlayerReady(true)
      try {
        await wv.insertCSS(`
          html, body { margin: 0 !important; padding: 0 !important; background: #000 !important; }
          .channel-info-bar, .top-bar, [data-a-target="player-overlay-mature-accept"],
          [data-test-selector="subscribe-button__subscribe-button"] { display: none !important; }
        `)
      } catch { /* ignore */ }
    }

    const fallback = setTimeout(() => setPlayerReady(true), 8000)
    wv.addEventListener('dom-ready', onReady)
    wv.addEventListener('did-finish-load', onReady)
    return () => {
      clearTimeout(fallback)
      wv.removeEventListener('dom-ready', onReady)
      wv.removeEventListener('did-finish-load', onReady)
    }
  }, [embedUrl])

  // Polling реального времени из Twitch-плеера
  // Использует __getStreamPos() — реальное время трансляции (не время сессии просмотра).
  // __getStreamPos() вычисляется от stream.createdAt через Twitch GQL API.
  useEffect(() => {
    if (!playerReady) return
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const ct = await webviewRef.current?.executeJavaScript(
          `(()=>{try{
            if(typeof window.__getStreamPos==='function'){
              var p=window.__getStreamPos();
              if(p>0)return p;
            }
            if(window.__twitchPlayer&&typeof window.__twitchPlayer.getCurrentTime==='function'){
              var c=Math.floor(window.__twitchPlayer.getCurrentTime());
              if(c>0)return c;
            }
            return -1;
          }catch(e){return -1}})()`
        )
        if (typeof ct === 'number' && ct > 0) setStreamPos(ct)
      } catch { /* ignore */ }
    }, 1000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [playerReady])

  const handleWatch = () => {
    const ch = normalizeTwitchChannel(persistedInput)
    if (!ch) return
    // Сохраняем текущую сессию перед переключением
    if (persistedChannelName && persistedChannelName !== ch) {
      const updated = saveCurrentSession(persistedMarkers, persistedChannelName, streamSessions)
      onSessionsChange(updated)
    }
    // Если тот же канал — переиспользуем существующую сессию, не создаём новую
    if (persistedChannelName === ch && currentSessionId.current) {
      // просто перезапускаем плеер
      setPlayerReady(false)
      setStreamPos(0)
      window.api.getPreviewPort().then(port => {
        setEmbedUrl(`http://localhost:${port}/?channel=${ch}`)
      }).catch(() => {
        setEmbedUrl(`https://player.twitch.tv/?channel=${ch}&parent=localhost&autoplay=true`)
      })
      return
    }
    // Новый канал — ищем существующую сессию или создаём id
    const existingSess = streamSessions.find(s => s.channelName === ch)
    currentSessionId.current = existingSess ? existingSess.id : `sess_${ch}_${Date.now()}`
    onChannelChange(ch)
    setPlayerReady(false)
    setStreamPos(0)
    setStreamTitle(null)
    onMarkersChange(existingSess ? existingSess.markers : [])
    window.api.getPreviewPort().then(port => {
      setEmbedUrl(`http://localhost:${port}/?channel=${ch}`)
    }).catch(() => {
      setEmbedUrl(`https://player.twitch.tv/?channel=${ch}&parent=localhost&autoplay=true`)
    })
  }

  const addMarker = () => {
    if (!newName.trim()) return
    const m: StreamMarker = { id: genId(), name: newName.trim(), description: newDesc.trim(), streamPos, createdAt: Date.now() }
    const newMarkers = [...persistedMarkers, m]
    onMarkersChange(newMarkers)
    onSessionsChange(saveCurrentSession(newMarkers, persistedChannelName, streamSessions))
    setNewName(''); setNewDesc(''); setShowAddForm(false)
  }

  const addPresetMarker = (label: string) => {
    const newMarkers = [...persistedMarkers, { id: genId(), name: label, description: '', streamPos, createdAt: Date.now() }]
    onMarkersChange(newMarkers)
    onSessionsChange(saveCurrentSession(newMarkers, persistedChannelName, streamSessions))
  }

  const deleteMarker = (id: string) => {
    const newMarkers = persistedMarkers.filter(m => m.id !== id)
    onMarkersChange(newMarkers)
    onSessionsChange(saveCurrentSession(newMarkers, persistedChannelName, streamSessions))
  }

  const cutLastN = (durSec: number) => {
    if (!persistedChannelName) return
    const url = `https://www.twitch.tv/${persistedChannelName}`
    const id = genId()
    const PADDING = 25
    const argsWithSection = [...getTwitchFormatArgs('video', 'source'), '--download-sections', `*-${durSec + PADDING}`]
    const endSec = streamPos
    const startSec = Math.max(0, endSec - durSec)
    const label = durSec < 60 ? `${durSec}s` : `${durSec / 60}m`
    onStartDownload({
      id, url,
      title: `${persistedChannelName} [${secsToTimestamp(startSec)} → ${secsToTimestamp(endSec)}]`,
      formatLabel: `Source · last ${label}`,
      status: 'pending', progress: 0, createdAt: Date.now()
    }, argsWithSection)
  }

  const cutFromMarker = (m: StreamMarker) => {
    if (!persistedChannelName) return
    const endSec = streamPos
    const startSec = m.streamPos
    if (endSec <= startSec) return
    const durationSec = endSec - startSec
    const url = `https://www.twitch.tv/${persistedChannelName}`
    const id = genId()
    // +25 сек запаса на рекламу в начале
    const argsWithSection = [...getTwitchFormatArgs('video', 'source'), '--download-sections', `*-${durationSec + 25}`]
    onStartDownload({
      id, url,
      title: `${persistedChannelName} — ${m.name} [${secsToTimestamp(startSec)} → ${secsToTimestamp(endSec)}]`,
      formatLabel: `Source [${secsToTimestamp(startSec)} → ${secsToTimestamp(endSec)}]`,
      status: 'pending', progress: 0, createdAt: Date.now()
    }, argsWithSection)
  }

  const PRESETS = ['Highlight', 'Fail', 'Clip this', 'Important']

  const deleteSession = (id: string) => {
    const updated = streamSessions.filter(s => s.id !== id)
    onSessionsChange(updated)
  }

  // Вырезать отрезок из сохранённой сессии вокруг маркера:
  // direction='back'  → [markerPos - durSec ... markerPos]
  // direction='fwd'   → [markerPos ... markerPos + durSec]
  const cutFromSessionMarker = (channelName: string, markerPos: number, markerName: string, durSec: number, direction: 'back' | 'fwd') => {
    const url = `https://www.twitch.tv/${channelName}`
    const id = genId()
    const PADDING = 25 // запас на рекламу
    let startSec: number, endSec: number, sectionArg: string
    if (direction === 'back') {
      startSec = Math.max(0, markerPos - durSec)
      endSec   = markerPos
      sectionArg = `*-${durSec + PADDING}`
    } else {
      startSec = markerPos
      endSec   = markerPos + durSec
      // для fwd нужен реальный offset — используем timestamp-диапазон
      sectionArg = `*${secsToTimestamp(startSec)}-${secsToTimestamp(endSec)}`
    }
    const argsWithSection = [...getTwitchFormatArgs('video', 'source'), '--download-sections', sectionArg]
    onStartDownload({
      id, url,
      title: `${channelName} — ${markerName} [${secsToTimestamp(startSec)} → ${secsToTimestamp(endSec)}]`,
      formatLabel: `Source [${secsToTimestamp(startSec)} → ${secsToTimestamp(endSec)}]`,
      status: 'pending', progress: 0, createdAt: Date.now()
    }, argsWithSection)
  }

  const CUT_DURATIONS = [
    { label: '30s', sec: 30 },
    { label: '1m',  sec: 60 },
    { label: '2m',  sec: 120 },
    { label: '3m',  sec: 180 },
    { label: '5m',  sec: 300 },
  ]

  return (
    <div className="stream-view" style={hidden ? {display:'none'} : undefined}>
      {/* Input row */}
      <div className="stream-input-row">
        <div className="stream-input-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/></svg>
          <input
            className="stream-input"
            type="text"
            placeholder={t.stream_placeholder}
            value={persistedInput}
            onChange={e => onInputChange(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleWatch()}
          />
        </div>
        <button className="stream-watch-btn" onClick={handleWatch} disabled={!persistedInput.trim()}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          {t.stream_watch}
        </button>
      </div>

      {/* Вкладки: Эфир / Просмотренные */}
      <div className="stream-tabs">
        <button className={`stream-tab-btn ${streamTab === 'live' ? 'active' : ''}`} onClick={() => setStreamTab('live')}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>
          {t.stream_tab_live}
        </button>
        <button className={`stream-tab-btn ${streamTab === 'sessions' ? 'active' : ''}`} onClick={() => setStreamTab('sessions')}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg>
          {t.stream_tab_sessions}
          {streamSessions.length > 0 && <span className="stream-tab-count">{streamSessions.length}</span>}
        </button>
      </div>

      {/* Таб: Просмотренные сессии */}
      {streamTab === 'sessions' && (
        <div className="stream-sessions">
          {streamSessions.length === 0 ? (
            <div className="stream-sessions-empty">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg>
              <p>{t.stream_sessions_empty}</p>
            </div>
          ) : (
            streamSessions.map(sess => (
              <div key={sess.id} className="stream-session-card">
                <div className="ssc-header">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="#9146FF"><path d="M11.6 6H13v4.5h-1.4V6zm3.8 0H17v4.5h-1.4V6zM2.2 0L0 5.4V21h5.4v3h3l3-3h4.5L24 12.6V0H2.2zm20.4 11.7-3.6 3.6h-5.4l-3 3v-3H5.4V1.4h17.2v10.3z"/></svg>
                  <div className="ssc-header-info">
                    <div className="ssc-channel-row">
                      <span className="ssc-channel">{sess.channelName}</span>
                      <span className="ssc-date">{new Date(sess.lastActiveAt).toLocaleDateString()}</span>
                    </div>
                    {sess.streamTitle && <span className="ssc-stream-title">{sess.streamTitle}</span>}
                  </div>
                  {sess.markers.length > 0
                    ? <span className="ssc-marker-count">{sess.markers.length} {t.stream_session_markers}</span>
                    : <span className="ssc-no-markers">{t.stream_session_no_markers}</span>}
                  <button className="ssc-delete" onClick={() => deleteSession(sess.id)}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
                    {t.stream_session_delete}
                  </button>
                </div>
                {sess.markers.length > 0 && (
                  <div className="ssc-markers">
                    {sess.markers.map(m => (
                      <div key={m.id} className="ssc-marker">
                        <div className="ssc-marker-dot"/>
                        <div className="ssc-marker-body">
                          <div className="ssc-marker-top">
                            <span className="ssc-marker-name">{m.name}</span>
                            {m.description && <span className="ssc-marker-desc">{m.description}</span>}
                            <span className="ssc-marker-time">{secsToTimestamp(m.streamPos)}</span>
                          </div>
                          <div className="ssc-cut-row">
                            <span className="ssc-cut-label">← back</span>
                            {CUT_DURATIONS.map(d => (
                              <button key={`b-${d.sec}`} className="ssc-cut-btn" onClick={() => cutFromSessionMarker(sess.channelName, m.streamPos, m.name, d.sec, 'back')}>
                                {d.label}
                              </button>
                            ))}
                            <span className="ssc-cut-sep"/>
                            <span className="ssc-cut-label">fwd →</span>
                            {CUT_DURATIONS.map(d => (
                              <button key={`f-${d.sec}`} className="ssc-cut-btn ssc-cut-btn-fwd" onClick={() => cutFromSessionMarker(sess.channelName, m.streamPos, m.name, d.sec, 'fwd')}>
                                {d.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Таб: Эфир */}
      {streamTab === 'live' && !persistedChannelName && (
        <FollowedLivePanel
          t={t}
          onSelect={ch => {
            onInputChange(ch)
            // trigger watch inline
            const existingSess = streamSessions.find(s => s.channelName === ch)
            currentSessionId.current = existingSess ? existingSess.id : `sess_${ch}_${Date.now()}`
            onChannelChange(ch)
            setPlayerReady(false)
            setStreamPos(0)
            setStreamTitle(null)
            onMarkersChange(existingSess ? existingSess.markers : [])
            window.api.getPreviewPort().then(port => {
              setEmbedUrl(`http://localhost:${port}/?channel=${ch}`)
            }).catch(() => {
              setEmbedUrl(`https://player.twitch.tv/?channel=${ch}&parent=localhost&autoplay=true`)
            })
          }}
        />
      )}

      {streamTab === 'live' && persistedChannelName && embedUrl && (
        <div className="stream-body">
          {/* Player */}
          <div className="stream-player-wrap">
            <div className="stream-player-header-leftright">
              <button className="stream-back-btn" onClick={() => { onChannelChange(null); setEmbedUrl(null); setPlayerReady(false); setStreamPos(0) }} title={t.stream_back ?? 'Back'}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="15 18 9 12 15 6"/></svg>
                {t.stream_back ?? 'Back'}
              </button>
                <div className="stream-player-header">
                  <div className="stream-player-main">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="#9146FF"><path d="M11.6 6H13v4.5h-1.4V6zm3.8 0H17v4.5h-1.4V6zM2.2 0L0 5.4V21h5.4v3h3l3-3h4.5L24 12.6V0H2.2zm20.4 11.7-3.6 3.6h-5.4l-3 3v-3H5.4V1.4h17.2v10.3z"/></svg>
                    <div className="stream-channel-info">
                      <span className="stream-channel-label">{persistedChannelName}</span>
                      {streamTitle && <span className="stream-channel-title">{streamTitle}</span>}
                    </div>
                    <span className="stream-live-badge">{t.stream_live_badge}</span>
                    <span className="stream-timer">{secsToTimestamp(streamPos)}</span>
                    <div className="stream-cut-group">
                      <span className="stream-cut-label">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 16l-4-4h2.5V4h3v8H16l-4 4z"/><path d="M20 18H4"/></svg>
                        {t.stream_cut_label}
                      </span>
                      {CUT_DURATIONS.map(d => (
                        <button key={d.sec} className="stream-cut-btn" onClick={() => cutLastN(d.sec)} disabled={streamPos < d.sec}>
                          {d.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button className={`stream-chat-btn`} onClick={() => window.api.openTwitchChat(persistedChannelName!)}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    {t.stream_chat}
                  </button>
                </div>
              </div>
              <div className="stream-webview-wrap">
                {!playerReady && <div className="stream-player-loading"><span className="spin"/></div>}
                <webview
                  ref={webviewRef}
                  src={embedUrl}
                  className="stream-webview"
                  partition="persist:preview"
                  allowpopups={false}
                  useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                  style={{ visibility: playerReady ? 'visible' : 'hidden', width: '100%', height: '100%' }}
                />
              </div>
            </div>

            {/* Markers panel */}
            <div className="stream-markers-panel">
              <div className="stream-markers-head">
                <span className="stream-markers-title">{t.stream_markers_title}</span>
                <span className="stream-markers-count">{persistedMarkers.length}</span>
              </div>
              <div className="stream-presets">
                {PRESETS.map(label => (
                  <button key={label} className="stream-preset-btn" onClick={() => addPresetMarker(label)} disabled={!playerReady}>
                    {label}
                  </button>
                ))}
              </div>
            {!showAddForm ? (
              <button className="stream-add-marker-btn" onClick={() => setShowAddForm(true)} disabled={!playerReady}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                {t.stream_add_marker}
              </button>
            ) : (
              <div className="stream-marker-form">
                <div className="smf-pos">{t.stream_at} {secsToTimestamp(streamPos)}</div>
                <input className="smf-input" placeholder={t.stream_marker_name} value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addMarker()} autoFocus/>
                <input className="smf-input smf-input-desc" placeholder={t.stream_marker_desc} value={newDesc} onChange={e => setNewDesc(e.target.value)} onKeyDown={e => e.key === 'Enter' && addMarker()}/>
                <div className="smf-btns">
                  <button className="smf-save" onClick={addMarker} disabled={!newName.trim()}>{t.stream_marker_save}</button>
                  <button className="smf-cancel" onClick={() => { setShowAddForm(false); setNewName(''); setNewDesc('') }}>{t.stream_marker_cancel}</button>
                </div>
              </div>
            )}
            <div className="stream-markers-list">
              {persistedMarkers.length === 0 && <div className="stream-no-markers">{t.stream_no_markers}</div>}
              {[...persistedMarkers].reverse().map(m => (
                <div key={m.id} className="stream-marker-item">
                  <div className="smi-left">
                    <span className="smi-dot"/>
                    <div className="smi-info">
                      <span className="smi-name">{m.name}</span>
                      {m.description && <span className="smi-desc">{m.description}</span>}
                      <span className="smi-time">{t.stream_at} {secsToTimestamp(m.streamPos)}</span>
                    </div>
                  </div>
                  <div className="smi-actions">
                    <button className="smi-cut" onClick={() => cutFromMarker(m)} disabled={streamPos <= m.streamPos} title={t.stream_cut_from}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 16l-4-4h2.5V4h3v8H16l-4 4z"/><path d="M20 18H4"/></svg>
                      {t.stream_cut_from}
                    </button>
                    <button className="smi-del" onClick={() => deleteMarker(m.id)} title={t.stream_marker_delete}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>{/* stream-markers-panel */}
        </div>
      )}
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
  const [showPlayer, setShowPlayer] = useState(false)
  // Persistent stream state — survives tab switches
  const [streamInput, setStreamInput] = useState('')
  const [streamChannelName, setStreamChannelName] = useState<string | null>(null)
  const [streamMarkers, setStreamMarkers] = useState<StreamMarker[]>([])
  const [streamSessions, setStreamSessions] = useState<StreamSession[]>([])
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(true)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [twitchLoggedIn, setTwitchLoggedIn] = useState(false)
  const [twitchExtractState, setTwitchExtractState] = useState<'idle'|'busy'|'ok'|'fail'>('idle')
  const [twitchExtractError, setTwitchExtractError] = useState('')
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
      setSidebarCollapsed(!!s.sidebarCollapsed)
      const elSettings = await window.api.getSettings()
      setSettings({ ...elSettings, downloadPath:s.downloadPath||elSettings.downloadPath, concurrentDownloads:s.concurrentDownloads||elSettings.concurrentDownloads })
      const hist = await loadHistory()
      setDownloads(hist.map(h => ({ ...h, progress:100, speed:undefined, eta:undefined, error:undefined })))
      const { exists } = await window.api.checkYtDlp()
      if (exists) { setReady(true) } else { setShowSetup(true) }
      console.log('[App] init: checkYtDlp exists=', exists)
      window.api?.checkTwitchSession().then(r => { console.log('[App] init: twitchSession loggedIn=', r.loggedIn); setTwitchLoggedIn(r.loggedIn) }).catch(e => console.warn('[App] init: checkTwitchSession error', e))
      const sessions = await loadStreamSessions()
      setStreamSessions(sessions)
    })()
  }, [])

  useEffect(() => {
    if (!window.api) return
    const u1 = window.api.onDownloadProgress(d => setDownloads(p => p.map(x => x.id===d.id
      ? { ...x, progress: d.progress, speed: d.speed, eta: d.eta, status: 'downloading',
          // ssl_retry hint — show retrying badge instead of speed
          ...(d.hint === 'ssl_retry' ? { speed: 'ssl_retry', eta: '' } : {}) }
      : x)))
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

  const handleTwitchExtract = async () => {
    console.log('[Twitch] extractTwitchCookies start')
    setTwitchExtractState('busy'); setTwitchExtractError('')
    try {
      const r = await window.api?.extractTwitchCookies()
      console.log('[Twitch] extractTwitchCookies result:', r)
      if (r?.success) { setTwitchExtractState('ok'); setTwitchLoggedIn(true) }
      else { setTwitchExtractState('fail'); setTwitchExtractError(r?.error || '') }
    } catch (err) {
      console.error('[Twitch] extractTwitchCookies error:', err)
      setTwitchExtractState('fail'); setTwitchExtractError(String(err))
    }
    setTimeout(() => setTwitchExtractState('idle'), 5000)
  }

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
    setFetching(true); setFetchErr(''); setVideoInfo(null); setPlaylist(null); setTwitchChannel(null); setShowPlayer(false)
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

  const handleDownload = useCallback(async (type: FormatType, quality: string, timeRange?: { start: number; end: number }) => {
    if (!videoInfo || !window.api) return
    const id = genId()
    const isTwitch = platform === 'twitch'
    let formatArgs = isTwitch ? getTwitchFormatArgs(type, quality as TwitchQuality) : getFormatArgs(type, quality as VideoQuality | AudioQuality)
    let sectionDuration: number | undefined
    if (timeRange) {
      const endStr = timeRange.end >= 0 ? secsToTimestamp(timeRange.end) : 'inf'
      formatArgs = [...formatArgs, '--download-sections', `*${secsToTimestamp(timeRange.start)}-${endStr}`]
      sectionDuration = timeRange.end >= 0
        ? timeRange.end - timeRange.start
        : (videoInfo.duration ?? 0) - timeRange.start
    }
    const baseLabel = isTwitch ? getTwitchFormatLabel(type, quality as TwitchQuality) : getFormatLabel(type, quality as VideoQuality | AudioQuality)
    const formatLabel = timeRange
      ? `${baseLabel} [${secsToTimestamp(timeRange.start)}→${timeRange.end >= 0 ? secsToTimestamp(timeRange.end) : 'end'}]`
      : baseLabel
    setDownloads(p => [{ id, url:urlRef.current, title:videoInfo.title, thumbnail:videoInfo.thumbnail, formatLabel, status:'pending', progress:0, createdAt:Date.now() }, ...p])
    let downloadUrl = urlRef.current
    if (!isTwitch && downloadUrl.includes('music.youtube.com') && type==='video') downloadUrl = downloadUrl.replace('music.youtube.com','www.youtube.com')
    const r = await window.api.startDownload({ id, url:downloadUrl, formatArgs, downloadPath:settings.downloadPath, sectionDuration })
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

  const handleFfmpegHint = useCallback(async () => {
    const id = `ffmpeg_install_${Date.now()}`
    setDownloads(p => [{ id, url:'', title:'Installing ffmpeg...', formatLabel:'System', status:'downloading', progress:0, createdAt:Date.now() }, ...p])
    const unsub = window.api?.onFfmpegDownloadProgress?.((d) => {
      setDownloads(p => p.map(x => x.id===id ? {...x, title:`ffmpeg: ${d.step}`} : x))
    })
    const r = await window.api?.downloadFfmpeg()
    unsub?.()
    if (r?.success) {
      setDownloads(p => p.map(x => x.id===id ? {...x, status:'complete', title:'ffmpeg installed ✓', progress:100} : x))
    } else {
      setDownloads(p => p.map(x => x.id===id ? {...x, status:'error', title:'ffmpeg install failed', error:r?.error ?? 'Unknown error'} : x))
    }
  }, [])

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
        <Sidebar view={view} onChange={setView} activeCount={activeCount} lang={lang} onLangToggle={toggleLang}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => { const next = !sidebarCollapsed; setSidebarCollapsed(next); saveState({ sidebarCollapsed: next }) }}
        />
        <main className={`main${view === 'stream' ? ' main-stream' : ''}`}>
          {view==='download' && (
            <div className="dl-view">
              <UrlInput onFetch={handleFetch} loading={fetching} t={t} platform={platform} onPlatformChange={setPlatform}/>

              {fetchErr && !isAgeGate(fetchErr) && <div className="fetch-err"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>{fetchErr}{isCookieError(fetchErr) && <button className="dl-cookie-hint" style={{marginLeft:'10px'}} onClick={handleCookieHint}>{t.err_cookie_hint}</button>}</div>}

              {fetchErr && isAgeGate(fetchErr) && (
                <div className="age-gate-card">
                  <div className="age-gate-icon">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  </div>
                  <div className="age-gate-body">
                    <div className="age-gate-title">{lang === 'ru' ? 'Видео с возрастным ограничением' : 'Age-restricted video'}</div>
                    <div className="age-gate-desc">{lang === 'ru'
                      ? 'YouTube требует авторизацию для этого видео. Войдите в аккаунт прямо здесь — это займёт 10 секунд.'
                      : 'YouTube requires sign-in for this video. Log in right here — it takes 10 seconds.'
                    }</div>
                    <button className="age-gate-btn" onClick={async () => {
                      setFetchErr('')
                      await handleCookieHint()
                      // small delay so settings tab opens, then auto-trigger cookie extraction
                    }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                      {lang === 'ru' ? 'Войти в YouTube' : 'Sign in to YouTube'}
                    </button>
                    <div className="age-gate-hint">{lang === 'ru'
                      ? 'После входа вернись и нажми Fetch снова'
                      : 'After signing in, come back and press Fetch again'
                    }</div>
                  </div>
                </div>
              )}

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
                  <FormatSelector key="fmt-selector" onDownload={handleDownload} onDownloadAll={handleDownloadAll} playlist={playlist} platform={platform} disabled={!videoInfo||fetching} t={t} initType={initFmt.type} initVq={initFmt.vq} initAq={initFmt.aq} onFormatChange={(type,vq,aq)=>saveState({formatType:type,videoQuality:vq,audioQuality:aq})} availableQualities={videoInfo ? getAvailableQualities(videoInfo.formats) : undefined} duration={videoInfo?.duration} onOpenPlayer={() => setShowPlayer(v => !v)}/>
                {showPlayer && videoInfo && (
                  <VideoPlayerPanel
                    url={urlRef.current}
                    platform={platform}
                    duration={videoInfo.duration}
                    onDownload={(type, quality, timeRange) => {
                      setShowPlayer(false)
                      handleDownload(type, quality, timeRange)
                    }}
                    onClose={() => setShowPlayer(false)}
                    t={t}
                  />
                )}
                </>
              )}

              {downloads.length>0 && (
                <div className="queue-section">
                  <div className="queue-head"><span className="section-eyebrow-sm">{t.lbl_downloads}</span>{activeCount>0&&<span className="queue-badge">{activeCount} {t.lbl_active}</span>}</div>
                  <div className="queue-list">{downloads.slice(0,15).map(d=><DownloadCard key={d.id} item={d} onCancel={handleCancel} onOpen={handleOpen} onCookieHint={handleCookieHint} onFfmpegHint={handleFfmpegHint} t={t} lang={lang}/>)}</div>
                </div>
              )}
            </div>
          )}
          {view==='history' && <HistoryView downloads={downloads} t={t} onClear={async()=>{ await clearHistory(); setDownloads(p=>p.filter(d=>d.status==='downloading'||d.status==='pending')) }}/>}
          {view==='settings' && (console.log('[App] rendering SettingsView', { twitchLoggedIn, twitchExtractState, twitchExtractError }), true) && <SettingsView settings={settings} onSave={handleSaveSettings} onPickFolder={handlePickFolder} t={t} theme={theme} onThemeChange={handleThemeChange} highlightCookies={highlightCookies} autoCheckUpdates={autoCheckUpdates} onAutoCheckChange={handleAutoCheckChange} onManualCheck={handleManualCheck} twitchLoggedIn={twitchLoggedIn} twitchExtractState={twitchExtractState} twitchExtractError={twitchExtractError} onTwitchExtract={handleTwitchExtract}/>}
          <div style={{display: view==='stream' ? 'contents' : 'none'}}>
            <StreamView
              hidden={view !== 'stream'}
              t={t}
              downloadPath={settings.downloadPath}
              persistedInput={streamInput}
              persistedChannelName={streamChannelName}
              persistedMarkers={streamMarkers}
              streamSessions={streamSessions}
              onInputChange={setStreamInput}
              onChannelChange={setStreamChannelName}
              onMarkersChange={setStreamMarkers}
              onSessionsChange={v => {
                setStreamSessions(prev => {
                  const next = typeof v === 'function' ? v(prev) : v
                  saveStreamSessions(next)
                  return next
                })
              }}
              onStartDownload={(item, formatArgs) => {
                setDownloads(p => [item, ...p])
                window.api.startDownload({ id: item.id, url: item.url, formatArgs, downloadPath: settings.downloadPath })
              }}
            />
          </div>
        </main>
      </div>
    </div>
  )
}
