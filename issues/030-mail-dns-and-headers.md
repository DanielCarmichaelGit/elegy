# 030: Mail DNS is incomplete and the Fly apps send no hardening headers

**Status:** Open · **Reported:** 2026-10-01 (audit) · **Seen on:** heyquilt.com DNS (Cloudflare), api.heyquilt.com, relay.heyquilt.com

## What happens
- **Mail**: Resend's DKIM (`resend._domainkey.hq.heyquilt.com`) and the SPF +
  MX on the `send.hq.heyquilt.com` return path exist, but `_dmarc.hq.heyquilt.com`
  does not, the org policy `_dmarc.heyquilt.com` is `p=none`, neither
  `heyquilt.com` nor `hq.heyquilt.com` has an SPF TXT (anyone can spoof
  `@heyquilt.com`), and `hq.heyquilt.com` has no MX, so replies to invite
  emails bounce.
- **Headers**: api.heyquilt.com and relay.heyquilt.com redirect HTTP→HTTPS but
  send no `Strict-Transport-Security`, `X-Content-Type-Options` or
  `Referrer-Policy` (the relay's join redirect does send referrer-policy).
  Netlify's HSTS lacks `includeSubDomains`.
- **HEAD**: `HEAD /healthz` on the API is 404 (routes match on method), so
  HEAD-based uptime monitors report it down. (Also in 019.)

## Next steps
1. Cloudflare TXT: `heyquilt.com` and `hq.heyquilt.com` → `v=spf1 -all` (apex) / Resend's include on hq; `_dmarc.hq.heyquilt.com` → `v=DMARC1; p=quarantine; rua=mailto:…`; raise the apex policy; add an MX or a reply-to for `SMTP_FROM` that someone reads.
2. Add HSTS, nosniff and referrer-policy in `src/api/server.js` and `src/server.js`; enable `includeSubDomains` on Netlify.
3. Match HEAD as GET in the API router.

## What is fine (checked)
TLS valid on heyquilt.com, www, api, relay, join and cowove-relay.fly.dev;
DNS points where the docs say; both Fly apps have one machine in `iad` with
passing checks; the 3 GB relay volume is attached; join.heyquilt.com and the
relay's `/join/<room>` redirect as documented.

## Log
- 2026-10-01: found by the audit.
