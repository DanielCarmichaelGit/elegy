'use server'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { rememberSpace } from '@/lib/space-cookie.js'
import { isInviteToken } from '@/lib/org-view.js'

export async function acceptInvite (formData) {
  const token = String(formData.get('token') || '')
  if (!isInviteToken(token)) redirect('/dashboard')
  const back = `/invite/${encodeURIComponent(token)}`
  const user = await requireUser(back)
  const r = await apiCall(user, 'POST', '/v1/invites/accept', { token })
  if (!r.ok) redirect(`${back}?error=${encodeURIComponent(r.data?.error || 'Could not join. Try again.')}`)
  await rememberSpace(r.data.org.slug)
  redirect(`/org/${r.data.org.slug}`)
}
