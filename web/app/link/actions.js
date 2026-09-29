'use server'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'

export async function decide (formData) {
  const code = String(formData.get('code') || '')
  const approve = formData.get('decision') === 'approve'
  const user = await requireUser(`/link?code=${encodeURIComponent(code)}`)
  const r = await apiCall(user, 'POST', '/v1/device/approve', { userCode: code, approve })
  redirect(`/link?code=${encodeURIComponent(code)}&done=${r.ok ? (approve ? 'approved' : 'denied') : 'failed'}`)
}
