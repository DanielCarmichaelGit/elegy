'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/session.js'
import { createClient } from '@/lib/supabase/server.js'
import { apiCall } from '@/lib/api.js'
import { TOOLS } from '@/lib/tools.js'

// The same profile the desktop app shows; row-level security lets people edit name, colour and tool.
export async function saveProfile (formData) {
  const user = await requireUser('/settings')
  const name = String(formData.get('name') || '').trim().slice(0, 60)
  const color = String(formData.get('color') || '')
  const tool = String(formData.get('tool') || '')
  if (!name || !/^#[0-9a-fA-F]{6}$/.test(color) || !TOOLS.includes(tool)) redirect('/settings?error=profile')
  const supabase = await createClient()
  const { error } = await supabase.from('profiles').update({ name, color, tool }).eq('id', user.id)
  revalidatePath('/settings')
  redirect(`/settings?${error ? 'error=profile' : 'saved=1'}`)
}

// Signs out every browser, and unlinks every computer (their tokens stop working).
export async function signOutEverywhere () {
  const user = await requireUser('/settings')
  const supabase = await createClient()
  const { error: devicesError } = await supabase.from('devices').update({ revoked_at: new Date().toISOString() }).eq('user_id', user.id).is('revoked_at', null)
  if (devicesError) redirect('/settings?error=signout')
  const { error: signOutError } = await supabase.auth.signOut({ scope: 'global' })
  if (signOutError) redirect('/settings?error=signout')
  redirect('/')
}

export async function deleteAccount (formData) {
  const user = await requireUser('/settings')
  if (String(formData.get('confirm') || '').trim().toLowerCase() !== 'delete') redirect('/settings?error=confirm')
  const r = await apiCall(user, 'DELETE', '/v1/me/account')
  if (!r.ok) redirect('/settings?error=delete')
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/?deleted=1')
}
