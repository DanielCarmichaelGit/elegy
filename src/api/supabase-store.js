// The accounts API's data in Supabase, using the service role (row-level security is
// for the website; the API is trusted and writes the secrets).
import { createClient } from '@supabase/supabase-js'

const toCamel = (row) => row && Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (m, c) => c.toUpperCase()), v]))
const toSnake = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()), v]))
const ts = (v) => (v == null ? v : typeof v === 'number' ? new Date(v).toISOString() : v)
const ms = (v) => (v == null ? v : Date.parse(v))
const SAFE_AGENT = 'id, owner_id, name, key_prefix, public_key, created_at, last_used_at, revoked_at'

export function createSupabaseStore ({ url, serviceKey }) {
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const one = async (q) => { const { data, error } = await q; if (error) throw error; return data }
  const link = (r) => r && { ...toCamel(r), expiresAt: ms(r.expires_at), createdAt: ms(r.created_at) }

  return {
    async createLink (l) {
      return link(await one(db.from('device_links').insert(toSnake({ ...l, expiresAt: ts(l.expiresAt) })).select().single()))
    },
    async linkByDeviceCode (h) { return link(await one(db.from('device_links').select().eq('device_code_hash', h).maybeSingle())) },
    async linkByUserCode (c) { return link(await one(db.from('device_links').select().eq('user_code', c).maybeSingle())) },
    async updateLink (id, patch) {
      return link(await one(db.from('device_links').update(toSnake({ ...patch, expiresAt: ts(patch.expiresAt) })).eq('id', id).select().single()))
    },
    // Check-and-set: only flips status if it's still fromStatus, so two concurrent
    // callers can't both win the same link (e.g. handing out a device token twice).
    async claimLink (id, fromStatus, toStatus) {
      const rows = await one(db.from('device_links').update({ status: toStatus }).eq('id', id).eq('status', fromStatus).select('id'))
      return rows.length > 0
    },
    async upsertDevice ({ userId, name, platform, publicKey }) {
      return toCamel(await one(db.from('devices')
        .upsert({ user_id: userId, name, platform, public_key: publicKey, revoked_at: null }, { onConflict: 'public_key' })
        .select().single()))
    },
    async setDeviceToken (id, tokenHash) { await one(db.from('devices').update({ token_hash: tokenHash }).eq('id', id)) },
    async deviceByToken (h) { return toCamel(await one(db.from('devices').select().eq('token_hash', h).is('revoked_at', null).maybeSingle())) },
    async touchDevice (id) { await one(db.from('devices').update({ last_seen_at: new Date().toISOString() }).eq('id', id)) },
    async revokeDevice (id) { await one(db.from('devices').update({ revoked_at: new Date().toISOString(), token_hash: null }).eq('id', id)) },
    async profile (userId) { return toCamel(await one(db.from('profiles').select('id, name, color, tool').eq('id', userId).maybeSingle())) },
    async updateProfile (userId, patch) {
      return toCamel(await one(db.from('profiles').update({ ...toSnake(patch), updated_at: new Date().toISOString() }).eq('id', userId).select('id, name, color, tool').single()))
    },
    async createAgent (a) { return toCamel(await one(db.from('agents').insert(toSnake(a)).select(SAFE_AGENT).single())) },
    async agentByKey (h) { return toCamel(await one(db.from('agents').select().eq('key_hash', h).is('revoked_at', null).maybeSingle())) },
    async listAgents (ownerId) { return (await one(db.from('agents').select(SAFE_AGENT).eq('owner_id', ownerId).order('created_at'))).map(toCamel) },
    async revokeAgent (ownerId, id) {
      const rows = await one(db.from('agents').update({ revoked_at: new Date().toISOString() }).eq('id', id).eq('owner_id', ownerId).select('id'))
      return rows.length > 0
    }
  }
}
