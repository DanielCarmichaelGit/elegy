// Where the relay keeps large files. The files are already encrypted by the
// apps; the relay only hands out short-lived links and deletes what's unused.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const LINK_MS = 10 * 60 * 1000

/** Files on the relay's own disk, reached through signed links to the relay. */
export class DiskStore {
  constructor (dir) {
    this.dir = dir
    this.signing = crypto.randomBytes(32)
  }

  file (room, id) { return path.join(this.dir, room, id) }

  sign (room, id, method, exp) {
    return crypto.createHmac('sha256', this.signing).update(`${method} ${room}/${id} ${exp}`).digest('hex')
  }

  link (room, id, method) {
    const exp = Date.now() + LINK_MS
    return `/blobs/${room}/${id}/data?m=${method}&exp=${exp}&sig=${this.sign(room, id, method, exp)}`
  }

  verify (room, id, method, exp, sig) {
    if (!(Number(exp) > Date.now())) return false
    const want = Buffer.from(this.sign(room, id, method, exp), 'hex')
    const got = Buffer.from(String(sig || ''), 'hex')
    return got.length === want.length && crypto.timingSafeEqual(got, want)
  }

  async uploadTarget (room, id) { return { method: 'PUT', url: this.link(room, id, 'PUT') } }
  async downloadTarget (room, id) { return { url: this.link(room, id, 'GET') } }
  async remove (room, ids) { for (const id of ids) fs.rmSync(this.file(room, id), { force: true }) }
  async removeRoom (room) { fs.rmSync(path.join(this.dir, room), { recursive: true, force: true }) }
}

/** Files in a private Supabase Storage bucket; apps upload and download directly. */
export class SupabaseStore {
  constructor ({ url, key, bucket }) {
    this.bucket = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).storage.from(bucket)
  }

  static path (room, id) { return `${room}/${id}` }

  async uploadTarget (room, id) {
    const { data, error } = await this.bucket.createSignedUploadUrl(SupabaseStore.path(room, id), { upsert: true })
    if (error) throw new Error(`storage: ${error.message}`)
    return { method: 'PUT', url: data.signedUrl }
  }

  async downloadTarget (room, id) {
    const { data, error } = await this.bucket.createSignedUrl(SupabaseStore.path(room, id), LINK_MS / 1000)
    if (error) throw new Error(`storage: ${error.message}`)
    return { url: data.signedUrl }
  }

  async remove (room, ids) {
    if (!ids.length) return
    const { error } = await this.bucket.remove(ids.map((id) => SupabaseStore.path(room, id)))
    if (error) throw new Error(`storage: ${error.message}`)
  }

  async removeRoom (room) {
    for (;;) {
      const { data, error } = await this.bucket.list(room, { limit: 1000 })
      if (error) throw new Error(`storage: ${error.message}`)
      if (!data.length) return
      await this.remove(room, data.map((f) => f.name))
    }
  }
}

export function makeStore (cfg, dir) {
  if (cfg.storageUrl && cfg.storageKey) return new SupabaseStore({ url: cfg.storageUrl, key: cfg.storageKey, bucket: cfg.storageBucket })
  return new DiskStore(dir)
}
