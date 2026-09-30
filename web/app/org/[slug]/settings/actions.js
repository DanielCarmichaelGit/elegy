'use server'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { orgAction } from '@/lib/org-actions.js'
import { rememberSpace } from '@/lib/space-cookie.js'
import { PERSONAL, isSlug } from '@/lib/space.js'

export async function saveSettings (formData) {
  await orgAction(formData, 'settings', 'PUT', '', {
    name: String(formData.get('name') || ''),
    domain: String(formData.get('domain') || '').trim() || null,
    domainRequests: formData.get('domainRequests') === 'on'
  })
}

export async function transferOwnership (formData) {
  await orgAction(formData, 'settings', 'POST', '/transfer', { memberId: String(formData.get('memberId') || '') })
}

// Typing the org's address guards against deleting the wrong one.
export async function deleteOrg (formData) {
  const slug = String(formData.get('slug') || '')
  if (!isSlug(slug)) redirect('/dashboard')
  const back = `/org/${slug}/settings`
  const user = await requireUser(back)
  if (String(formData.get('confirm') || '').trim() !== slug) redirect(`${back}?error=${encodeURIComponent(`Type ${slug} to confirm.`)}`)
  const r = await apiCall(user, 'DELETE', `/v1/orgs/${slug}`)
  if (!r.ok) redirect(`${back}?error=${encodeURIComponent(r.data?.error || 'Could not delete the org. Try again.')}`)
  await rememberSpace(PERSONAL)
  redirect('/dashboard?orgDeleted=1')
}
