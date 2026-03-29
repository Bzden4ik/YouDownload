// Preload script for Twitch chat webview — injects 7TV with prepended localStorage patch
const { ipcRenderer } = require('electron')

window.addEventListener('DOMContentLoaded', () => {
  if (window.__seventv_injected) return
  window.__seventv_injected = true

  ipcRenderer.invoke('fetch-7tv-url').then(result => {
    if (!result.success) {
      console.warn('[YouDownload] 7TV URL fetch failed:', result.error)
      return
    }

    // Create a blob URL for the worker so SharedWorker gets a blob: URL
    // that belongs to the same origin as the page (avoids cross-origin SecurityError).
    let workerBlobUrl = null
    if (result.workerScript) {
      const workerBlob = new Blob([result.workerScript], { type: 'text/javascript' })
      workerBlobUrl = URL.createObjectURL(workerBlob)
      console.log('[YouDownload] 7TV worker blob created:', workerBlobUrl)
    }

    const ADDR_KEY = 'seventv_worker_addr'
    const wurl = workerBlobUrl || 'seventv://worker.js'

    // Patch localStorage so 7TV stores/retrieves our blob URL as the worker address
    const origSetItem = localStorage.setItem.bind(localStorage)
    const origGetItem = localStorage.getItem.bind(localStorage)
    const origWorker = window.Worker

    localStorage.setItem = function(k, v) {
      if (k === ADDR_KEY) {
        try {
          const o = JSON.parse(v)
          for (const p in o) {
            if (typeof o[p] === 'string' && (o[p].startsWith('blob:') || o[p].startsWith('seventv://'))) {
              o[p] = wurl
            }
          }
          return origSetItem(k, JSON.stringify(o))
        } catch(e) {}
      }
      return origSetItem(k, v)
    }

    localStorage.getItem = function(k) {
      const v = origGetItem(k)
      if (k === ADDR_KEY && v) {
        try {
          const o = JSON.parse(v)
          let changed = false
          for (const p in o) {
            if (typeof o[p] === 'string' && (o[p].startsWith('blob:') || o[p].startsWith('seventv://'))) {
              o[p] = wurl
              changed = true
            }
          }
          if (changed) return JSON.stringify(o)
        } catch(e) {}
      }
      return v
    }

    window.Worker = function(u, opts) {
      const s = String(u && u.toString ? u.toString() : u)
      if (s.startsWith('seventv://')) {
        console.log('[YouDownload] Worker(seventv://) -> blob')
        return new origWorker(wurl, opts)
      }
      return new origWorker(u, opts)
    }
    window.Worker.prototype = origWorker.prototype
    Object.setPrototypeOf(window.Worker, origWorker)

    // Patch any existing stored addr
    try {
      const st = origGetItem(ADDR_KEY)
      if (st) {
        const so = JSON.parse(st)
        for (const p in so) {
          if (typeof so[p] === 'string' && (so[p].startsWith('blob:') || so[p].startsWith('seventv://'))) {
            so[p] = wurl
          }
        }
        origSetItem(ADDR_KEY, JSON.stringify(so))
      }
    } catch(e) {}

    console.log('[YouDownload] 7TV prepatch active (worker:', wurl, ')')

    // Build blob URLs for all chunks
    const chunks = result.chunks || {}
    const chunkBlobUrls = {}
    for (const [filename, content] of Object.entries(chunks)) {
      const blob = new Blob([content], { type: 'text/javascript' })
      chunkBlobUrls[filename] = URL.createObjectURL(blob)
    }

    // Inject an Import Map so the browser resolves relative specifiers like
    // './seventv.twitchsite.X.js' to our blob URLs — no string replacement needed.
    // This works for ALL dynamic imports across index AND all chunk files.
    const importMap = { imports: {} }
    for (const [filename, blobUrl] of Object.entries(chunkBlobUrls)) {
      importMap.imports[`./${filename}`] = blobUrl
      console.log('[YouDownload] 7TV importmap:', filename, '->', blobUrl)
    }
    const mapScript = document.createElement('script')
    mapScript.type = 'importmap'
    mapScript.textContent = JSON.stringify(importMap)
    document.head.appendChild(mapScript)

    // Inject 7TV index script as a blob module — relative imports now resolve via importmap
    const blob = new Blob([result.script], { type: 'text/javascript' })
    const blobUrl = URL.createObjectURL(blob)
    import(blobUrl)
      .then(() => {
        console.log('[YouDownload] 7TV module loaded, version:', result.version)
        URL.revokeObjectURL(blobUrl)
      })
      .catch(e => console.warn('[YouDownload] 7TV module error:', e))
  }).catch(e => console.warn('[YouDownload] 7TV IPC error:', e))
})
