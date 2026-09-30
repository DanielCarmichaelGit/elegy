import 'server-only'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from './session.js'
import { apiCall } from './api.js'
import { isSlug } from './space.js'

export const enc = (v) => encodeURIComponent(String(v ?? ''))

/** One org API call from a form, then back to the page with "Saved." or the API's reason. */
export async function orgAction (formData, page, method, path, body) {
  const slug = String(formData.get('slug') || '')
  if (!isSlug(slug)) redirect('/dashboard')
  const back = page ? `/org/${slug}/${page}` : `/org/${slug}`
  const user = await requireUser(back)
  const r = await apiCall(user, method, `/v1/orgs/${slug}${path}`, body)
  revalidatePath(back)
  redirect(`${back}?${r.ok ? 'saved=1' : `error=${encodeURIComponent(r.data?.error || 'Something went wrong. Try again.')}`}`)
}
