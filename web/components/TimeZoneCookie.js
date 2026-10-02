'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { TZ_COOKIE } from '@/lib/activity-view.js'

// Times on the dashboard are in the visitor's own time zone. Pages render on the server,
// so the browser tells it the zone once, in a cookie, and the page refreshes with it.
// `current` is the cookie as the server read it.
export default function TimeZoneCookie ({ current }) {
  const router = useRouter()
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!tz || tz === current) return
    // IANA names are cookie-safe as they are (letters, digits, / _ + -).
    document.cookie = `${TZ_COOKIE}=${tz}; path=/; max-age=31536000; samesite=lax`
    router.refresh()
  }, [current, router])
  return null
}
