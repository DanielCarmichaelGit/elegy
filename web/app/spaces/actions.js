'use server'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/session.js'
import { rememberSpace } from '@/lib/space-cookie.js'
import { PERSONAL, isSlug } from '@/lib/space.js'

export async function switchSpace (formData) {
  await requireUser('/dashboard')
  const space = String(formData.get('space') || '')
  if (space !== PERSONAL && isSlug(space)) {
    await rememberSpace(space)
    redirect(`/org/${space}`)
  }
  await rememberSpace(PERSONAL)
  redirect('/dashboard')
}
