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

  sign (room, id, method, exp, size) {
    return crypto.createHmac('sha256', this.signing).update(`${method} ${room}/${id} ${exp} ${size ?? ''}`).digest('hex')
  }

  link (room, id, method, size) {
    const exp = Date.now() + LINK_MS
    const n = size === undefined ? '' : `&n=${size}`
    return `/blobs/${room}/${id}/data?m=${method}&exp=${exp}&sig=${this.sign(room, id, method, exp, size)}${n}`
  }

  verify (room, id, method, exp, sig, size) {
    if (!(Number(exp) > Date.now())) return false
    const want = Buffer.from(this.sign(room, id, method, exp, size), 'hex')
    const got = Buffer.from(String(sig || ''), 'hex')
    return got.length === want.length && crypto.timingSafeEqual(got, want)
  }

  // The declared size is signed into the PUT link, so a client can't upload
  // more than it told the relay it would; GET links carry no size.
  async uploadTarget (room, id, size) { return { method: 'PUT', url: this.link(room, id, 'PUT', size) } }
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

  // `size` is accepted but ignored: Supabase signed uploads can't bound size; the bucket's file_size_limit caps each object.
  // Write-once: ids come from the content, so an upload never replaces what's stored.
  async uploadTarget (room, id, size) {
    const { data, error } = await this.bucket.createSignedUploadUrl(SupabaseStore.path(room, id), { upsert: false })
    // Storage may refuse to sign at all when the file is already there.
    if (error && alreadyExists(error)) return { exists: true }
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

const alreadyExists = (error) => String(error.statusCode) === '409' || /exists|duplicate/i.test(String(error.message))

export function makeStore (cfg, dir) {
  if (cfg.storageUrl && cfg.storageKey) return new SupabaseStore({ url: cfg.storageUrl, key: cfg.storageKey, bucket: cfg.storageBucket })
  return new DiskStore(dir)
}
