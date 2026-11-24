/**
 * Off-main-thread Fuse index for city search (#771 / ISP-101).
 * Keeps cold-start index builds off the UI thread on low-RAM phones.
 */

import Fuse from 'fuse.js'

function normalizeSearchQuery(input) {
  if (!input) return ''
  const hasArabic = /[\u0600-\u06FF]/.test(input)
  const hasCjk = /[\u3040-\u9FFF]/.test(input)
  if (hasArabic) {
    return input
      .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
      .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')
      .replace(/\u0649/g, '\u064A')
      .trim()
  }
  if (hasCjk) return input.normalize('NFC').replace(/\s+/g, '').trim()
  return input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .trim()
}

let index = null

self.onmessage = (event) => {
  const msg = event.data || {}
  try {
    if (msg.type === 'build') {
      const cities = Array.isArray(msg.cities) ? msg.cities : []
      index = new Fuse(cities, {
        keys: ['name', 'country', 'cc', 'alt'],
        threshold: 0.35,
        shouldSort: true,
        ignoreLocation: true,
        getFn: (obj, path) => {
          const key = Array.isArray(path) ? path.join('.') : path
          const raw = obj[key]
          if (typeof raw === 'string') return normalizeSearchQuery(raw)
          if (Array.isArray(raw)) {
            return raw.map((v) => (typeof v === 'string' ? normalizeSearchQuery(v) : v))
          }
          return raw
        },
      })
      self.postMessage({ type: 'ready', count: cities.length })
      return
    }
    if (msg.type === 'search') {
      if (!index) {
        self.postMessage({ type: 'error', id: msg.id, message: 'index not ready' })
        return
      }
      const q = normalizeSearchQuery(msg.query || '')
      const hits = index.search(q, { limit: msg.limit || 6 })
      self.postMessage({
        type: 'results',
        id: msg.id,
        hits: hits.map((h) => h.item),
        scores: hits.map((h) => h.score),
      })
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
