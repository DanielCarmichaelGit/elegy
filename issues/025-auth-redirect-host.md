# 025: Auth callback and sign-out build their redirects from the request URL, which on Netlify can be the deploy host

**Status:** Needs info · **Reported:** 2026-10-01 (audit) · **Seen on:** heyquilt.com (Netlify)

## What happens
`web/app/auth/callback/route.js:13-15` redirects to `new URL(next, url.origin)`
with `url = new URL(request.url)`, and `web/app/auth/signout/route.js:7` does
`new URL('/', request.url)`. The rest of the site refuses to trust the request
host (`web/lib/origin.js` throws in production without `QUILT_SITE_URL`), but
these two routes do. During the audit one probe of
`https://heyquilt.com/auth/callback?code=bogus&next=%2Fsettings` answered
`307 → https://6abe9eb5cdb667c6bf93a067--heyquilt.netlify.app/signin?…`. If
that happens on a real magic-link, email-confirmation or OAuth return, the
person lands on the deploy host with their session cookies set for that host
and looks signed out on heyquilt.com.

Eleven later probes (GET and HEAD, several header sets, with and without
`next=//evil.com`) all answered with `https://heyquilt.com/…`, so this is
either intermittent on Netlify's edge or was a one-off. The code pattern is
fragile either way.

Related, unverifiable from here: `QUILT_SITE_URL` and
`NEXT_PUBLIC_AUTH_PROVIDERS` on the Netlify site. If `QUILT_SITE_URL` is
unset, the "Email me a sign-in link" and OAuth actions throw at runtime
(`web/app/signin/actions.js:12,22`). The live `/signin` renders no provider
buttons, consistent with `NEXT_PUBLIC_AUTH_PROVIDERS` being unset.

## What should happen
Every redirect out of a route handler lands on `https://heyquilt.com`, taken
from `QUILT_SITE_URL`, or is a relative redirect.

## Next steps
1. Use `await origin()` in both routes: `NextResponse.redirect(new URL(next, await origin()))`.
2. Add a `routes.test.js` case asserting the `Location` host of `/auth/callback?code=bogus` equals the configured site URL.
3. Check the Netlify env vars once and add a build-time assertion for `QUILT_SITE_URL`.
4. Confirm the Supabase Auth redirect allow-list contains `https://heyquilt.com/auth/callback` (see 020).

## Log
- 2026-10-01: found by the audit (one observation); not reproduced afterwards.
