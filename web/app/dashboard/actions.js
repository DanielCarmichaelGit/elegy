'use server'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/session.js'
import { createClient } from '@/lib/supabase/server.js'
import { apiCall } from '@/lib/api.js'
import { rememberSpace } from '@/lib/space-cookie.js'

// Unlinking goes straight through row-level security: people may set revoked_at on their own computers.
export async function unlinkComputer (formData) {
  await requireUser('/dashboard')
  const supabase = await createClient()
  await supabase.from('devices').update({ revoked_at: new Date().toISOString() }).eq('id', String(formData.get('id'))).is('revoked_at', null)
  revalidatePath('/dashboard')
}

// Creating an agent mints a key and an identity, so it goes through the API. The key comes back once.
export async function createAgent (prev, formData) {
  const user = await requireUser('/dashboard')
  const name = String(formData.get('name') || '').trim()
  if (!name) return { error: 'Give the agent a name.' }
  const r = await apiCall(user, 'POST', '/v1/agents', { name })
  if (!r.ok) return { error: r.data?.error || 'Couldn’t create the agent. Try again.' }
  revalidatePath('/dashboard')
  return { agent: r.data.agent, key: r.data.key }
}

export async function revokeAgent (formData) {
  const user = await requireUser('/dashboard')
  await apiCall(user, 'DELETE', `/v1/agents/${encodeURIComponent(String(formData.get('id')))}`)
  revalidatePath('/dashboard')
}

// "A team" sign-ups carry their org's name in the account until the org exists.
// Only for people in no org yet (not, say, someone who accepted an invite first).
export async function createFirstOrg () {
  const user = await requireUser('/dashboard')
  if (!user.orgName) return { error: 'There’s no org waiting to be created.' }
  const mine = await apiCall(user, 'GET', '/v1/orgs')
  if (!mine.ok) return { error: 'Couldn’t reach Quilt. Try again.' }
  let slug = mine.data.orgs[0]?.slug
  if (!slug) {
    const made = await apiCall(user, 'POST', '/v1/orgs', { name: user.orgName })
    if (!made.ok) return { error: made.data?.error || 'Couldn’t create your org. Try again.' }
    slug = made.data.org.slug
  }
  await clearOrgName()
  await rememberSpace(slug)
  return { slug }
}

export async function dismissFirstOrg () {
  await requireUser('/dashboard')
  await clearOrgName()
  revalidatePath('/dashboard')
}

async function clearOrgName () {
  const supabase = await createClient()
  await supabase.auth.updateUser({ data: { org_name: null } })
}
