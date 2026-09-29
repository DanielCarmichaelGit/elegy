// A Supabase client for the browser: calls go out from the visitor's own IP,
// which is what gives Supabase's per-IP rate limiting on sign-in/sign-up any teeth.
'use client'
import { createBrowserClient } from '@supabase/ssr'

export function createClient () {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
}
