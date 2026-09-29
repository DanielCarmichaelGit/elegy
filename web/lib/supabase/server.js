// A Supabase client bound to this request's cookies (server components, actions, routes).
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient () {
  const store = await cookies()
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll (cookiesToSet) {
        // Server components can't set cookies; proxy.js refreshes the session instead.
        try { for (const { name, value, options } of cookiesToSet) store.set(name, value, options) } catch {}
      }
    }
  })
}
