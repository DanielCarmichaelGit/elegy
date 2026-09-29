// Pure — no Next imports — so it can be unit-tested directly.
// Only same-site paths are allowed as a place to return to after sign-in.
// The base is an arbitrary placeholder origin used purely to make the WHATWG
// URL parser resolve `n` the way a browser would; it must not collide with
// any host an attacker could get `n` to resolve to (e.g. plain "x").
const BASE = 'http://safe-next.invalid'

export function safeNext (n) {
  if (typeof n !== 'string') return '/dashboard'
  try {
    const u = new URL(n, BASE)
    return u.origin === BASE ? u.pathname + u.search : '/dashboard'
  } catch {
    return '/dashboard'
  }
}
