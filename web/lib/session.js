import { redirect } from 'next/navigation'
import { createClient } from './supabase/server.js'

/** The signed-in person, with the access token the accounts API accepts; null if signed out. */
export async function currentUser () {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: { session } } = await supabase.auth.getSession()
  return { id: user.id, email: user.email, identities: user.identities || [], accessToken: session?.access_token }
}

export async function requireUser (nextPath) {
  const u = await currentUser()
  if (!u) redirect(`/signin?next=${encodeURIComponent(nextPath)}`)
  return u
}
