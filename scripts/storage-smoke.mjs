// Checks the relay's Supabase storage end to end: sign an upload, PUT, sign a
// download, GET, compare, delete.
// Usage: QUILT_STORAGE_URL=https://<ref>.supabase.co QUILT_STORAGE_KEY=sb_secret_… node scripts/storage-smoke.mjs
import crypto from 'node:crypto'
import { SupabaseStore } from '../src/blobstore.js'

const store = new SupabaseStore({ url: process.env.QUILT_STORAGE_URL, key: process.env.QUILT_STORAGE_KEY, bucket: process.env.QUILT_STORAGE_BUCKET || 'session-files' })
const room = `smoke-${Date.now()}`
const id = crypto.randomBytes(16).toString('hex')
const body = crypto.randomBytes(300 * 1024)

const up = await store.uploadTarget(room, id, body.length)
const put = await fetch(up.url, { method: up.method, headers: { 'content-type': 'application/octet-stream' }, body })
if (!put.ok) throw new Error(`upload failed: ${put.status} ${await put.text()}`)
console.log('ok uploaded')
const down = await store.downloadTarget(room, id)
const got = Buffer.from(await (await fetch(down.url)).arrayBuffer())
if (!got.equals(body)) throw new Error('downloaded bytes differ')
console.log('ok downloaded the same bytes')
await store.removeRoom(room)
const { data: left, error } = await store.bucket.list(room)
if (error) throw new Error(`list failed: ${error.message}`)
if (left.length) throw new Error('files still there after removeRoom')
console.log('ok deleted')
