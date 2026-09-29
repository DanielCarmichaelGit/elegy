'use server'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server.js'
import { isValidPassword } from '@/lib/validate.js'

export async function updatePassword (formData) {
  const password = String(formData.get('password') || '')
  const confirm = String(formData.get('confirm') || '')
  if (!isValidPassword(password)) redirect('/reset?error=password')
  if (password !== confirm) redirect('/reset?error=match')
  const supabase = await createClient()
  const { error } = await supabase.auth.updateUser({ password })
  if (error) redirect('/reset?error=generic')
  redirect('/dashboard?password=1')
}
