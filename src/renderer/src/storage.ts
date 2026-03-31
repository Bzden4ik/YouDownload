/**
 * Все постоянные данные хранятся через electron-store (main process) via IPC.
 * localStorage не используется — он не персистентен в Electron dev-режиме.
 */

export interface PersistedState {
  lang: 'en' | 'ru'
  theme: 'fleet' | 'apathy'
  formatType: 'video' | 'audio'
  videoQuality: '2160' | '1440' | '1080' | '720' | '480' | '360' | '240' | '144'
  audioQuality: 'mp3_best' | 'mp3_192' | 'mp3_128' | 'm4a'
  downloadPath: string
  concurrentDownloads: number
  autoCheckUpdates: boolean
  sidebarCollapsed?: boolean
  playerPanelWidth?: number
  playerPanelHeight?: number
  twitchSortOrder?: Record<'vods'|'clips', string>
}

export interface PersistedDownload {
  id: string
  url: string
  title: string
  thumbnail?: string
  formatLabel: string
  status: 'complete' | 'error' | 'cancelled'
  createdAt: number
}

export interface StreamSessionMarker {
  id: string
  name: string
  description: string
  streamPos: number
  createdAt: number
}

export interface StreamSession {
  id: string
  channelName: string
  streamTitle?: string
  startedAt: number
  lastActiveAt: number
  markers: StreamSessionMarker[]
}

export async function loadStreamSessions(): Promise<StreamSession[]> {
  try {
    const s = await window.api.getAppState()
    return (s as any).streamSessions ?? []
  } catch { return [] }
}

export async function saveStreamSessions(sessions: StreamSession[]): Promise<void> {
  try {
    await window.api.saveAppState({ streamSessions: sessions } as any)
  } catch {}
}

/** Загрузить список избранных стримеров (логины, lowercase) */
export async function loadFavStreamers(): Promise<string[]> {
  try {
    const s = await window.api.getAppState()
    return (s as any).favStreamers ?? []
  } catch { return [] }
}

/** Сохранить список избранных стримеров */
export async function saveFavStreamers(logins: string[]): Promise<void> {
  try {
    await window.api.saveAppState({ favStreamers: logins } as any)
  } catch {}
}

export const DEFAULTS: PersistedState = {
  lang: 'en',
  theme: 'fleet',
  formatType: 'video',
  videoQuality: '1080',
  audioQuality: 'mp3_best',
  downloadPath: '',
  concurrentDownloads: 3,
  autoCheckUpdates: true,
}

/** Загрузить состояние из electron-store */
export async function loadState(): Promise<PersistedState> {
  try {
    const s = await window.api.getAppState()
    return { ...DEFAULTS, ...s }
  } catch {
    return { ...DEFAULTS }
  }
}

/** Сохранить часть состояния */
export async function saveState(patch: Partial<PersistedState>): Promise<void> {
  try {
    await window.api.saveAppState(patch)
  } catch {}
}

/** Загрузить историю */
export async function loadHistory(): Promise<PersistedDownload[]> {
  try {
    return (await window.api.getHistory()) ?? []
  } catch {
    return []
  }
}

/** Добавить запись в историю */
export async function appendHistory(item: PersistedDownload): Promise<void> {
  try {
    await window.api.appendHistory(item)
  } catch {}
}

/** Очистить историю */
export async function clearHistory(): Promise<void> {
  try {
    await window.api.clearHistory()
  } catch {}
}
