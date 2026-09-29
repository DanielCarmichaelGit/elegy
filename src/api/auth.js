// Website users sign in with Supabase; the API trusts a request from them when its
// bearer token is a JWT signed by the project's keys (fetched from its JWKS).
import { createRemoteJWKSet, jwtVerify } from 'jose'

export function createUserVerifier ({ supabaseUrl, jwks }) {
  const base = String(supabaseUrl).replace(/\/+$/, '')
  const keys = jwks || createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`))
  return async (token) => {
    if (!token) return null
    try {
      const { payload } = await jwtVerify(token, keys, { issuer: `${base}/auth/v1`, audience: 'authenticated' })
      return payload.sub ? { userId: payload.sub, email: payload.email || '' } : null
    } catch {
      return null
    }
  }
}
