'use server'
import { orgAction, enc } from '@/lib/org-actions.js'

// An empty role means "Member" to the API.
const roleOf = (formData) => String(formData.get('roleId') || '') || undefined

export async function sendInvite (formData) {
  await orgAction(formData, 'invites', 'POST', '/invites', { email: String(formData.get('email') || ''), roleId: roleOf(formData) })
}

export async function resendInvite (formData) {
  await orgAction(formData, 'invites', 'POST', `/invites/${enc(formData.get('id'))}/resend`, {})
}

export async function cancelInvite (formData) {
  await orgAction(formData, 'invites', 'DELETE', `/invites/${enc(formData.get('id'))}`)
}

export async function approveRequest (formData) {
  await orgAction(formData, 'invites', 'POST', `/requests/${enc(formData.get('id'))}`, { approve: true, roleId: roleOf(formData) })
}

export async function denyRequest (formData) {
  await orgAction(formData, 'invites', 'POST', `/requests/${enc(formData.get('id'))}`, { approve: false })
}
