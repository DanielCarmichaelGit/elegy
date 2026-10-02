# 027: Website: layout, CSS and small flow defects

**Status:** Open · **Reported:** 2026-10-01 (audit) · **Seen on:** heyquilt.com

Measured live unless noted.

1. **Window-bar titles overflow on phones** (`globals.css:160-162`,
   `page.js:84,112`): at 375 px "quilt · landing-page (shared with Sam)" wraps
   to 37 px inside the 34 px bar and overlaps the screenshot. Add
   `white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0`.
2. **Five hard-coded colours outside the token set** (`globals.css:26,197,269,271,281`)
   and the settings default colour `#C4472F` (`settings/page.js:28`) is not
   brand Rust `#C24F33`. The `.no` dash `#c3c0cf` on white is 1.9:1.
3. **No `:focus-visible` rule for `.btn`, `.qh-link`, `.qh-menu-btn`,
   `.pr-toggle-opt` and plain links**; inputs and avatar have the rust ring, buttons get the UA default.
4. **Hero image preload leaks into every page's RSC prefetch**: console on
   `/signup/org` and `/forgot` warns that `session-1920.webp` was preloaded and
   unused (65 KB wasted). `prefetch={false}` on the home links or drop `fetchPriority='high'`.
5. **Static assets are `max-age=0, must-revalidate`** (`/shots/*`, favicon);
   HSTS lacks `includeSubDomains`. Add a `[[headers]]` block in netlify.toml.
6. **`/robots.txt` and `/sitemap.xml` are 404**; `/signin`, `/signup`,
   `/forgot`, `/reset` are indexable with the generic description.
7. **Narrow pages use two widths**: join 560 px, invite and link 520 px, set
   inline; `.pr { max-width: 1080px }` duplicates `.wrap`. Add `.wrap.narrow`.
8. **Dead CSS copied from the app** (`.tabs`, `.choice`, `.wordmark`, `.side`,
   `.booting`, `.qm-inline`, `.skeleton-tabs`, `.qm-loop`) and the header mark
   height is set twice (36 px at line 44, 26 px at line 132 wins).
9. **Brand says code is IBM Plex Mono; the site uses the system mono stack**
   (`globals.css:8`). Load it with `next/font` or change the brand guide.
10. **Footer has no mark and only a GitHub link**; no privacy/terms/contact.
11. **On phones the auth pages put the 421 px brand panel above the form**
    (`globals.css:314-320`, `order: -1`): the Sign in heading starts at y=511.
12. **`/join/<room>/` with a trailing slash is a second 200 URL** on heyquilt.com
    (`proxy.js:21` runs before the trailing-slash 308). Pages are noindex, so cosmetic.
13. **Invite page "Sign out" goes to `/`** instead of back to `/signin?next=/invite/<token>`.
14. **The no-em-dash test skips `web/lib`** (`no-em-dash.test.js:9`), where
    pricing, agent and org copy live. No violation today.

## What is fine (checked)
Every section container measures the same width at every breakpoint (343 at
375, 736 at 768, 992 at 1024, 1080 at 1280 and 1920); no horizontal overflow
anywhere; all five images load, srcset picks the right WebP per width and
DPR, below-fold shots lazy; brand tokens in the rendered page match
brand/README.md exactly (bg #fff8f3, ink #2b2a38, rust #c24f33, the four patch
colours in brand order); the header mark and hero symbol have the same
geometry as assets/logo.svg; Poppins 400/500/600 self-hosted; contrast AA
everywhere except the decorative dash; no console errors, no 404s, no mixed
content; X-Frame-Options DENY, CSP frame-ancestors, nosniff, HSTS present;
`safeNext` blocks every off-site `next`; join/invite pages noindex with
no-referrer and the secret stays in the fragment; signed-out private pages
redirect with the right `next`; download links resolve to the v0.3.1 assets.

## Log
- 2026-10-01: found by the audit.
