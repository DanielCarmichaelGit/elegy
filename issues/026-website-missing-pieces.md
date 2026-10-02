# 026: Website: no share metadata, no icons for Safari/iOS, unstyled 404, and copy that contradicts the product

**Status:** Open · **Reported:** 2026-10-01 (audit) · **Seen on:** heyquilt.com at 375/768/1024/1280/1920 px

All verified live.

1. **No Open Graph / Twitter metadata, no `metadataBase`, no canonical**
   (`web/app/layout.js:6-10`). The head has only viewport, one description
   shared by every page, and `favicon.svg`. Sharing a heyquilt.com link shows no
   card. Add `metadataBase`, `openGraph`, `twitter`, per-page descriptions and an OG image.
2. **`/favicon.ico`, `/apple-touch-icon.png`, `/site.webmanifest` are 404**
   and there is no `theme-color`. Safari and iOS do not use the SVG icon. The
   brand kit (`brand/web/`) already ships all of these plus `head-snippet.html`.
   Copy them into `web/public`, set `metadata.icons`/`manifest` and
   `viewport.themeColor`, and exclude them from the proxy matcher.
3. **The 404 page is Next's default**: black background, "404 | This page
   could not be found.", no header, no link home. A visitor with a mistyped
   invite or download link is stranded. Add `web/app/not-found.js` with the
   site header/footer and a link home; a `join/[room]/not-found.js` for bad room ids.
   Styled 404 (and an error page) added with issue tracking, 2026-10-01.
4. **Pricing copy contradicts the product** (`web/lib/pricing.js`): Free is
   "Sessions on your own network", hosted sessions are Pro-only, while README
   says the app only ever connects through Quilt's hosted relay and the landing
   page says "Free while we build it". Reword the free tier to match what ships.
5. **Landing page says agents are "Coming soon"** (`web/app/page.js:126`)
   while `/dashboard/agents`, pricing and README treat them as shipped. Pick one.
6. **No `color-scheme`** (`globals.css`): the site is always light by design,
   but UA widgets (`<select>`, `<input type="color">` on /settings,
   scrollbars) follow the OS and render dark on the light page. Add `:root { color-scheme: light }`.
7. **Auth pages do not redirect a signed-in visitor**, and `safeNext('/signin')`
   is allowed, so `/signin?next=/signin` loops back to the form. Redirect when
   `currentUser()` exists; deny `/signin|/signup|/forgot|/auth/*` as targets.

## Next steps
Items 1-3 first (they affect every visitor); 4-5 are copy decisions.

## Log
- 2026-10-01: found by the audit.
