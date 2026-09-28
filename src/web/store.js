// Sessions this browser has been in, with the folder each one syncs, kept in
// IndexedDB (folder handles can be stored there, not in localStorage). Every
// call fails soft: private windows may have no storage.
const DB = 'cowove'
const STORE = 'sessions'

function db () {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'room' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx (mode, fn) {
  const d = await db()
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode)
    const r = fn(t.objectStore(STORE))
    t.oncomplete = () => resolve(r && r.result)
    t.onerror = () => reject(t.error)
  })
}

export async function saveSession (s) {
  try { await tx('readwrite', (st) => st.put({ ...s, lastUsed: Date.now() })) } catch {}
}

export async function listSessions () {
  try { return ((await tx('readonly', (st) => st.getAll())) || []).sort((a, b) => b.lastUsed - a.lastUsed) } catch { return [] }
}

export async function getSession (room) {
  try { return await tx('readonly', (st) => st.get(room)) } catch { return null }
}

export async function forgetSession (room) {
  try { await tx('readwrite', (st) => st.delete(room)) } catch {}
}

export const prefs = {
  get (k, d = '') { try { return localStorage.getItem(`cowove.${k}`) ?? d } catch { return d } },
  set (k, v) { try { localStorage.setItem(`cowove.${k}`, v) } catch {} }
}
