'use server'
import { orgAction, enc } from '@/lib/org-actions.js'
import { grantsFromForm } from '@/lib/role-form.js'

export async function createRole (formData) {
  await orgAction(formData, 'roles', 'POST', '/roles', { name: String(formData.get('name') || ''), grants: grantsFromForm(formData) })
}

export async function saveRole (formData) {
  const body = { grants: grantsFromForm(formData) }
  // Built-in roles have no name field; the API keeps their names.
  if (formData.has('name')) body.name = String(formData.get('name'))
  await orgAction(formData, 'roles', 'PUT', `/roles/${enc(formData.get('id'))}`, body)
}

export async function deleteRole (formData) {
  await orgAction(formData, 'roles', 'DELETE', `/roles/${enc(formData.get('id'))}`)
}
