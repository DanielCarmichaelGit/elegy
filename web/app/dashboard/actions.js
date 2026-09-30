'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/session.js'
import { createClient } from '@/lib/supabase/server.js'
import { apiCall } from '@/lib/api.js'
import { rememberSpace } from '@/lib/space-cookie.js'
import { isSlug } from '@/lib/space.js'

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

// An org sign-up carries its org's name in the account until the org exists.
// Only for people in no org yet (not, say, someone who accepted an invite first).
// first: true tells the API to guard this server-side: two tabs (or a double
// click) that both call this at once still end up with exactly one org.
// There's no way to dismiss this: org_name only clears once the org is made,
// so a failed attempt can only be retried, not skipped.
export async function createFirstOrg () {
  const user = await requireUser('/dashboard')
  if (!user.orgName) return { error: 'There’s no org waiting to be created.' }
  const made = await apiCall(user, 'POST', '/v1/orgs', { name: user.orgName, first: true })
  if (!made.ok) return { error: made.data?.error || 'Couldn’t create your org. Try again.' }
  const supabase = await createClient()
  await supabase.auth.updateUser({ data: { org_name: null } })
  await rememberSpace(made.data.org.slug)
  return { slug: made.data.org.slug }
}

// Domain join requests: the API checks the person's confirmed email matches the org's domain.
export async function askToJoin (formData) {
  const user = await requireUser('/dashboard')
  const slug = String(formData.get('slug') || '')
  if (!isSlug(slug)) redirect('/dashboard')
  const r = await apiCall(user, 'POST', `/v1/orgs/${slug}/requests`, {})
  redirect(r.ok ? '/dashboard?asked=1' : `/dashboard?error=${encodeURIComponent(r.data?.error || 'Could not send your request. Try again.')}`)
}
