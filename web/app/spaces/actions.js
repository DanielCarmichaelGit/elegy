'use server'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { rememberSpace } from '@/lib/space-cookie.js'
import { PERSONAL, isSlug } from '@/lib/space.js'
import { isValidOrgName } from '@/lib/validate.js'

export async function switchSpace (formData) {
  await requireUser('/dashboard')
  const space = String(formData.get('space') || '')
  if (space === '+new') redirect('/orgs/new')
  if (space !== PERSONAL && isSlug(space)) {
    await rememberSpace(space)
    redirect(`/org/${space}`)
  }
  await rememberSpace(PERSONAL)
  redirect('/dashboard')
}

// Used with useActionState: returns an error to show, or redirects into the new org.
export async function createOrg (prev, formData) {
  const user = await requireUser('/orgs/new')
  const name = String(formData.get('name') || '').trim()
  if (!isValidOrgName(name)) return { error: 'Give the org a name (up to 80 characters).' }
  const r = await apiCall(user, 'POST', '/v1/orgs', { name })
  if (!r.ok) return { error: r.data?.error || 'Could not create the org. Try again.' }
  await rememberSpace(r.data.org.slug)
  redirect(`/org/${r.data.org.slug}`)
}
