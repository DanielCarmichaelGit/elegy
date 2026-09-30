'use server'
import { orgAction, enc } from '@/lib/org-actions.js'

const team = (formData) => `/teams/${enc(formData.get('id'))}`

export async function createTeam (formData) {
  await orgAction(formData, 'teams', 'POST', '/teams', { name: String(formData.get('name') || '') })
}

export async function renameTeam (formData) {
  await orgAction(formData, 'teams', 'PUT', team(formData), { name: String(formData.get('name') || '') })
}

export async function deleteTeam (formData) {
  await orgAction(formData, 'teams', 'DELETE', team(formData))
}

export async function addToTeam (formData) {
  await orgAction(formData, 'teams', 'POST', `${team(formData)}/members`, { memberId: String(formData.get('memberId') || ''), access: String(formData.get('access') || 'viewer') })
}

export async function setTeamAccess (formData) {
  await orgAction(formData, 'teams', 'PUT', `${team(formData)}/members/${enc(formData.get('memberId'))}`, { access: String(formData.get('access') || '') })
}

export async function removeFromTeam (formData) {
  await orgAction(formData, 'teams', 'DELETE', `${team(formData)}/members/${enc(formData.get('memberId'))}`)
}
