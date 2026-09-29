'use server'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/session.js'
import { createClient } from '@/lib/supabase/server.js'
import { apiCall } from '@/lib/api.js'

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
