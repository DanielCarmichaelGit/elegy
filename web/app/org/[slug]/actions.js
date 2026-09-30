'use server'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { rememberSpace } from '@/lib/space-cookie.js'
import { PERSONAL, isSlug } from '@/lib/space.js'

// Anyone but the owner may leave; afterwards the org is gone from the switcher.
export async function leaveOrg (formData) {
  const slug = String(formData.get('slug') || '')
  if (!isSlug(slug)) redirect('/dashboard')
  const user = await requireUser(`/org/${slug}`)
  const me = await apiCall(user, 'GET', `/v1/orgs/${slug}/me`)
  if (!me.ok) redirect('/dashboard')
  const r = await apiCall(user, 'DELETE', `/v1/orgs/${slug}/members/${me.data.memberId}`)
  if (!r.ok) redirect(`/org/${slug}?error=${encodeURIComponent(r.data?.error || 'Could not leave. Try again.')}`)
  await rememberSpace(PERSONAL)
  redirect('/dashboard?left=1')
}
