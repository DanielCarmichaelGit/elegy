// The accounts API's data in Supabase, using the service role (row-level security is
// for the website; the API is trusted and writes the secrets).
import { createClient } from '@supabase/supabase-js'

const toCamel = (row) => row && Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (m, c) => c.toUpperCase()), v]))
const toSnake = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()), v]))
const ts = (v) => (v == null ? v : typeof v === 'number' ? new Date(v).toISOString() : v)
const ms = (v) => (v == null ? v : Date.parse(v))
const SAFE_AGENT = 'id, owner_id, name, key_prefix, public_key, created_at, last_used_at, revoked_at'
// Named columns for the org tables, so a select never picks up a secret by accident.
const ORG = 'id, name, slug, owner_id, domain, domain_requests, created_at'
const ROLE = 'id, org_id, name, builtin, grants, created_at'
const MEMBER = 'id, org_id, user_id, agent_id, role_id, joined_at'

// One mapper for every table: camelCases the columns and turns every `*At` field
// (createdAt, updatedAt, lastSeenAt, lastUsedAt, revokedAt, expiresAt, joinedAt,
// lastActiveAt, ...) from a Postgres timestamp string into epoch milliseconds,
// matching the memory store (the tested reference).
export const rowFrom = (row) => row && Object.fromEntries(Object.entries(toCamel(row)).map(([k, v]) => [k, /At$/.test(k) ? ms(v) : v]))

// `client` lets tests pass a stand-in for the supabase client.
export function createSupabaseStore ({ url, serviceKey, client }) {
  const db = client || createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const one = async (q) => { const { data, error } = await q; if (error) throw error; return data }
  const memberOf = async (orgId, userId) => rowFrom(await one(db.from('org_members').select(MEMBER).eq('org_id', orgId).eq('user_id', userId).maybeSingle()))

  return {
    async createLink (l) {
      return rowFrom(await one(db.from('device_links').insert(toSnake({ ...l, expiresAt: ts(l.expiresAt) })).select().single()))
    },
    async linkByDeviceCode (h) { return rowFrom(await one(db.from('device_links').select().eq('device_code_hash', h).maybeSingle())) },
    async linkByUserCode (c) { return rowFrom(await one(db.from('device_links').select().eq('user_code', c).maybeSingle())) },
    async updateLink (id, patch) {
      return rowFrom(await one(db.from('device_links').update(toSnake({ ...patch, expiresAt: ts(patch.expiresAt) })).eq('id', id).select().single()))
    },
    // Check-and-set: only flips status if it's still fromStatus, so two concurrent
    // callers can't both win the same link (e.g. handing out a device token twice).
    async claimLink (id, fromStatus, toStatus) {
      const rows = await one(db.from('device_links').update({ status: toStatus }).eq('id', id).eq('status', fromStatus).select('id'))
      return rows.length > 0
    },
    // One row per (account, key), so approving a link for someone else's key makes
    // your own row instead of taking theirs. A relink retires the old token.
    async upsertDevice ({ userId, name, platform, publicKey }) {
      return rowFrom(await one(db.from('devices')
        .upsert({ user_id: userId, name, platform, public_key: publicKey, token_hash: null, revoked_at: null }, { onConflict: 'user_id,public_key' })
        .select().single()))
    },
    async setDeviceToken (id, tokenHash) { await one(db.from('devices').update({ token_hash: tokenHash }).eq('id', id)) },
    async deviceByToken (h) { return rowFrom(await one(db.from('devices').select().eq('token_hash', h).is('revoked_at', null).maybeSingle())) },
    async touchDevice (id) { await one(db.from('devices').update({ last_seen_at: new Date().toISOString() }).eq('id', id)) },
    async revokeDevice (id) { await one(db.from('devices').update({ revoked_at: new Date().toISOString(), token_hash: null }).eq('id', id)) },
    async profile (userId) { return rowFrom(await one(db.from('profiles').select('id, name, color, tool').eq('id', userId).maybeSingle())) },
    async updateProfile (userId, { name, color, tool }) {
      return rowFrom(await one(db.from('profiles').update(toSnake({ name, color, tool })).eq('id', userId).select('id, name, color, tool').single()))
    },
    async createAgent (a) { return rowFrom(await one(db.from('agents').insert(toSnake(a)).select(SAFE_AGENT).single())) },
    async agentByKey (h) { return rowFrom(await one(db.from('agents').select().eq('key_hash', h).is('revoked_at', null).maybeSingle())) },
    async listAgents (ownerId) { return (await one(db.from('agents').select(SAFE_AGENT).eq('owner_id', ownerId).order('created_at'))).map(rowFrom) },
    async revokeAgent (ownerId, id) {
      const rows = await one(db.from('agents').update({ revoked_at: new Date().toISOString() }).eq('id', id).eq('owner_id', ownerId).select('id'))
      return rows.length > 0
    },
    // Deleting the auth user cascades through profiles, devices, links and agents.
    async deleteUser (userId) {
      const { error } = await db.auth.admin.deleteUser(userId)
      if (error) throw error
    },

    // The address a person signs in with, and whether they've confirmed it.
    async userEmail (userId) {
      const { data, error } = await db.auth.admin.getUserById(userId)
      if (error) { if (error.status === 404) return null; throw error }
      const u = data?.user
      return u ? { email: u.email || '', confirmed: !!u.email_confirmed_at } : null
    },

    // Orgs. create_org makes the org, its three built-in roles and its owner in one transaction.
    async createOrg ({ name, slug, ownerId, grants }) {
      return rowFrom(await one(db.rpc('create_org', {
        p_name: name, p_slug: slug, p_owner: ownerId, p_owner_grants: grants.owner, p_admin_grants: grants.admin, p_member_grants: grants.member
      })))
    },
    async orgBySlug (slug) { return rowFrom(await one(db.from('orgs').select(ORG).eq('slug', slug).maybeSingle())) },
    async orgById (id) { return rowFrom(await one(db.from('orgs').select(ORG).eq('id', id).maybeSingle())) },
    async orgsForUser (userId) {
      const rows = await one(db.from('org_members').select(`role_id, orgs (${ORG})`).eq('user_id', userId))
      return rows.map((r) => ({ ...rowFrom(r.orgs), roleId: r.role_id })).sort((a, b) => a.name.localeCompare(b.name))
    },
    async orgsByDomain (domain) { return (await one(db.from('orgs').select(ORG).eq('domain', domain).eq('domain_requests', true))).map(rowFrom) },
    async updateOrg (id, { name, domain, domainRequests }) {
      return rowFrom(await one(db.from('orgs').update(toSnake({ name, domain, domainRequests })).eq('id', id).select(ORG).single()))
    },
    // Cascades to roles, members, teams, invites and requests.
    async deleteOrg (id) { await one(db.from('orgs').delete().eq('id', id)) },
    async transferOrg (orgId, toUserId) { await one(db.rpc('transfer_org', { p_org: orgId, p_to: toUserId })) },

    // Roles.
    async listRoles (orgId) { return (await one(db.from('roles').select(ROLE).eq('org_id', orgId))).map(rowFrom) },
    async roleById (orgId, id) { return rowFrom(await one(db.from('roles').select(ROLE).eq('org_id', orgId).eq('id', id).maybeSingle())) },
    async createRole ({ orgId, name, grants }) {
      return rowFrom(await one(db.from('roles').insert({ org_id: orgId, name, grants }).select(ROLE).single()))
    },
    async updateRole (id, { name, grants }) {
      return rowFrom(await one(db.from('roles').update(toSnake({ name, grants })).eq('id', id).select(ROLE).single()))
    },
    // Closed invites (accepted, cancelled or expired) are cleared first, since
    // org_invites.role_id is NO ACTION, not cascade; an open invite still makes
    // the role delete fail with Postgres's 23503, which `one` rethrows as-is.
    async deleteRole (id) {
      await one(db.from('org_invites').delete().eq('role_id', id)
        .or(`accepted_at.not.is.null,cancelled_at.not.is.null,expires_at.lte.${new Date().toISOString()}`))
      await one(db.from('roles').delete().eq('id', id))
    },
    // In use: someone holds it, or an open invite would hand it out.
    async roleInUse (id) {
      if ((await one(db.from('org_members').select('id').eq('role_id', id).limit(1))).length) return true
      return (await one(db.from('org_invites').select('id').eq('role_id', id).is('accepted_at', null).is('cancelled_at', null).limit(1))).length > 0
    },

    // Members.
    memberOf,
    async memberById (orgId, id) { return rowFrom(await one(db.from('org_members').select(MEMBER).eq('org_id', orgId).eq('id', id).maybeSingle())) },
    async listMembers (orgId) {
      const rows = await one(db.from('org_members').select(`${MEMBER}, profiles (name)`).eq('org_id', orgId).order('joined_at'))
      return rows.map(({ profiles, ...r }) => ({ ...rowFrom(r), name: profiles?.name || '' }))
    },
    // Already a member: the upsert does nothing and we return the existing row.
    async addMember ({ orgId, userId, roleId }) {
      const row = await one(db.from('org_members')
        .upsert({ org_id: orgId, user_id: userId, role_id: roleId }, { onConflict: 'org_id,user_id', ignoreDuplicates: true })
        .select(MEMBER).maybeSingle())
      return row ? rowFrom(row) : memberOf(orgId, userId)
    },
    async setMemberRole (id, roleId) { return rowFrom(await one(db.from('org_members').update({ role_id: roleId }).eq('id', id).select(MEMBER).single())) },
    // Cascades to the member's team memberships.
    async removeMember (id) { await one(db.from('org_members').delete().eq('id', id)) }
  }
}
