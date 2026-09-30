import 'server-only'
import { cookies } from 'next/headers'
import { SPACE_COOKIE } from './space.js'

// Only server actions and route handlers may set cookies, so only they call this.
export async function rememberSpace (value) {
  const store = await cookies()
  store.set(SPACE_COOKIE, value, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax', httpOnly: true, secure: process.env.NODE_ENV === 'production' })
}
