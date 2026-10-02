// src/api/routes/issues.js
// Issue reports from the desktop app and the website: errors, 404s, crashes and how long
// actions took. Who is reporting decides the surface and who the events belong to; the
// body never does.
import crypto from 'node:crypto'
import { HttpError, UUID } from '../http.js'
import { cleanEvent, MAX_BATCH } from '../issues.js'

// Compares by byte length, not by UTF-16 string length: a header with the right character
// count but non-ASCII (or otherwise multi-byte) bytes would otherwise reach
// timingSafeEqual with mismatched buffer lengths, which throws rather than answering false.
const sameKey = (a, b) => {
  const bufA = Buffer.from(a); const bufB = Buffer.from(b)
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)
}

export function issueRoutes ({ store, device, bearer, now, reportKey = '', limitReports }) {
  /** Who is reporting: { surface, userId, deviceId }. */
  async function reporter (req, body) {
    const surface = String(body.surface || '')
    if (bearer(req).startsWith('qd_')) {
      const d = await device(req)
      if (surface !== 'app') throw new HttpError(400, 'a computer reports for the app')
      return { surface, userId: d.userId, deviceId: d.id }
    }
    const key = String(req.headers['x-quilt-report-key'] || '')
    if (key) {
      if (!reportKey || !sameKey(key, reportKey)) throw new HttpError(401, 'bad report key')
      if (surface !== 'web') throw new HttpError(400, 'the website reports for the web')
      return { surface, userId: UUID.test(String(body.userId || '')) ? String(body.userId) : null, deviceId: null }
    }
    // Nobody signed in: the app before sign-in (a failed sign-in is worth knowing about).
    if (surface !== 'app') throw new HttpError(401, 'sign in first')
    limitReports(req)
    return { surface, userId: null, deviceId: null }
  }

  return [
    ['POST', /^\/v1\/issues$/, async (req, body) => {
      const who = await reporter(req, body)
      if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > MAX_BATCH) throw new HttpError(400, `events must hold 1 to ${MAX_BATCH} items`)
      const events = body.events.map((raw) => cleanEvent(raw, { ...who, appVersion: body.appVersion, platform: body.platform, now }))
      const recorded = await store.recordEvents(events)
      return { ok: true, recorded }
    }]
  ]
}
