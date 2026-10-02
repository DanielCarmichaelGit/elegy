'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { typeFromForm } from '@/lib/access-form.js'

// Access types: each action goes to the accounts API, then back to the page with
// "Saved." or the API's reason.
const PAGE = '/dashboard/access'
const back = (r, fallback) => {
  revalidatePath(PAGE)
  redirect(r.ok ? `${PAGE}?saved=1` : `${PAGE}?error=${encodeURIComponent(r.data?.error || fallback)}`)
}
const idOf = (formData) => encodeURIComponent(String(formData.get('id') || ''))

export async function createAccessType (formData) {
  const user = await requireUser(PAGE)
  back(await apiCall(user, 'POST', '/v1/access-types', typeFromForm(formData)), 'Couldn’t create the access type. Try again.')
}

export async function saveAccessType (formData) {
  const user = await requireUser(PAGE)
  back(await apiCall(user, 'PUT', `/v1/access-types/${idOf(formData)}`, typeFromForm(formData)), 'Couldn’t save the access type. Try again.')
}

// Grants that used it become View only (the API does that).
export async function deleteAccessType (formData) {
  const user = await requireUser(PAGE)
  back(await apiCall(user, 'DELETE', `/v1/access-types/${idOf(formData)}`), 'Couldn’t delete the access type. Try again.')
}
