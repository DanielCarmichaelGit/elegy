'use server'
import { orgAction, enc } from '@/lib/org-actions.js'

export async function setRole (formData) {
  await orgAction(formData, 'people', 'PUT', `/members/${enc(formData.get('id'))}`, { roleId: String(formData.get('roleId') || '') })
}

export async function removeMember (formData) {
  await orgAction(formData, 'people', 'DELETE', `/members/${enc(formData.get('id'))}`)
}
