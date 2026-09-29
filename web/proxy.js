// Refreshes the Supabase session on every page request and keeps private pages private.
import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

const PRIVATE = ['/dashboard', '/settings', '/link']

export async function proxy (request) {
  let response = NextResponse.next({ request })
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll (cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options)
        for (const [k, v] of Object.entries(headers || {})) response.headers.set(k, v)
      }
    }
  })
  const { data } = await supabase.auth.getClaims()
  const path = request.nextUrl.pathname
  if (!data?.claims && PRIVATE.some((p) => path === p || path.startsWith(p + '/'))) {
    const to = request.nextUrl.clone()
    to.pathname = '/signin'
    to.search = ''
    to.searchParams.set('next', path + request.nextUrl.search)
    return NextResponse.redirect(to)
  }
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.svg|.*\\.(?:svg|png|jpg|ico|woff2)$).*)']
}
