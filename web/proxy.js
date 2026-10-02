// Refreshes the Supabase session on every page request and keeps private pages private.
// join.heyquilt.com/<room> redirects to the invite page here (/join/<room>); browsers keep
// the #secret across the redirect, and the page can then see whether you're signed in.
import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { JOIN_HOST, SITE_URL, joinRedirect } from './lib/join.js'

const PRIVATE = ['/dashboard', '/settings', '/link', '/reset', '/org', '/orgs', '/invite']

// Invite links carry a secret in the fragment: never pass the page on as a referrer, and keep it out of search.
function invitePage (response) {
  response.headers.set('Referrer-Policy', 'no-referrer')
  response.headers.set('X-Robots-Tag', 'noindex')
  return response
}

export async function proxy (request) {
  const host = (request.headers.get('host') || '').split(':')[0].toLowerCase()
  const path = request.nextUrl.pathname
  if (host === JOIN_HOST) {
    const to = joinRedirect(path)
    return to ? invitePage(NextResponse.redirect(to)) : NextResponse.redirect(`${SITE_URL}/`)
  }
  // The invite page is public but needs to know whether you're signed in, so it goes
  // through the session refresh below like any other page.
  const invite = path.startsWith('/join/')

  // skipTrailingSlashRedirect (next.config.mjs, needed so the join host's rewrite can accept a
  // trailing slash itself) turns off Next's own trailing-slash redirect everywhere, so bring it
  // back here for every other host. Build the target from request.url, not nextUrl.clone():
  // nextUrl normalizes the pathname back to the trailing slash, which loops.
  if (!invite && path !== '/' && path.endsWith('/')) {
    const url = new URL(request.url)
    url.pathname = path.replace(/\/+$/, '')
    return NextResponse.redirect(url, 308)
  }

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
  if (!data?.claims && PRIVATE.some((p) => path === p || path.startsWith(p + '/'))) {
    const to = request.nextUrl.clone()
    to.pathname = '/signin'
    to.search = ''
    to.searchParams.set('next', path + request.nextUrl.search)
    const redirectResponse = NextResponse.redirect(to)
    for (const cookie of response.cookies.getAll()) redirectResponse.cookies.set(cookie)
    return redirectResponse
  }
  return invite ? invitePage(response) : response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.svg|.*\\.(?:svg|png|jpg|webp|avif|gif|ico|woff2)$).*)']
}
