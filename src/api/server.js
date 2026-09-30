// src/api/server.js
// The Quilt accounts API: links desktop apps to accounts (a device-code flow, like
// signing in to a TV app) and manages agents. Plain node:http, like the relay.
import http from 'node:http'
import { newToken, hashToken, newUserCode, normalizeUserCode } from './tokens.js'
import { parsePublicKey, verifyChallenge } from '../identity.js'
import { newAgentIdentity } from './agent-keys.js'
import { HttpError, UUID } from './http.js'
import { orgRoutes } from './routes/orgs.js'
import { memberRoutes } from './routes/members.js'
import { teamRoutes } from './routes/teams.js'
import { inviteRoutes } from './routes/invites.js'

const LINK_TTL_MS = 10 * 60 * 1000
// An approved link the app never collects stops working this long after its code expires.
const COLLECT_GRACE_MS = 5 * 60 * 1000
const POLL_INTERVAL_S = 3
const MAX_BODY = 16 * 1024

export function startApi ({ port = 0, host = '127.0.0.1', store, verifyUser, siteUrl, agentKeySecret, mailer = { send: async () => { throw new Error('no mailer configured') } }, now = Date.now, log = () => {}, startLimit = 10, inviteLimit = 10, trustProxy = false, maxStartKeys = 10_000 }) {
  const site = String(siteUrl || '').replace(/\/+$/, '')

  const bearer = (req) => (String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i) || [])[1] || ''
  async function user (req) {
    const u = await verifyUser(bearer(req))
    if (!u) throw new HttpError(401, 'sign in first')
    return u
  }

  async function device (req) {
    const d = await store.deviceByToken(hashToken(bearer(req)))
    if (!d) throw new HttpError(401, 'this computer is signed out')
    await store.touchDevice(d.id)
    return d
  }

  // A few tries per minute per address is plenty for a person. Behind Fly,
  // Fly-Client-IP is the real peer; X-Forwarded-For isn't used because Fly appends
  // to whatever the client sent, so its first entry is client-controlled.
  function makeLimiter (limit, message) {
    const hits = new Map()
    const check = (req) => {
      const ip = (trustProxy && String(req.headers['fly-client-ip'] || '').trim()) || req.socket.remoteAddress
      const recent = (hits.get(ip) || []).filter((t) => now() - t < 60_000)
      if (recent.length >= limit) throw new HttpError(429, message)
      hits.set(ip, [...recent, now()])
      // Keep the map bounded: forget addresses with nothing in the last minute.
      if (hits.size > maxStartKeys) for (const [k, ts] of hits) if (ts.every((t) => now() - t >= 60_000)) hits.delete(k)
    }
    check.size = () => hits.size
    return check
  }
  const limitStarts = makeLimiter(startLimit, 'too many sign-in attempts; try again in a minute')
  const limitInvites = makeLimiter(inviteLimit, 'too many tries; wait a minute and try again')

  const COLOR = /^#[0-9a-fA-F]{6}$/
  function cleanProfile (b) {
    const out = {}
    if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 60); if (!n) throw new HttpError(400, 'name is empty'); out.name = n }
    if (b.color !== undefined) { if (b.color !== null && !COLOR.test(b.color)) throw new HttpError(400, 'color must be #RRGGBB'); out.color = b.color }
    if (b.tool !== undefined) out.tool = b.tool === null ? null : String(b.tool).slice(0, 40)
    return out
  }

  const routes = [
    ['GET', /^\/healthz$/, async () => ({ ok: true })],

    ['POST', /^\/v1\/device\/start$/, async (req, body) => {
      limitStarts(req)
      const { publicKey, deviceName, platform } = body
      if (!parsePublicKey(publicKey)) throw new HttpError(400, 'publicKey must be an Ed25519 key (spki, base64url)')
      const deviceCode = newToken('dc_')
      let userCode
      do userCode = newUserCode(); while (await store.linkByUserCode(userCode))
      await store.createLink({
        deviceCodeHash: hashToken(deviceCode), userCode, publicKey,
        deviceName: String(deviceName || 'A computer').slice(0, 80), platform: String(platform || '').slice(0, 20),
        expiresAt: now() + LINK_TTL_MS
      })
      return { deviceCode, userCode, verificationUrl: `${site}/link?code=${userCode}`, interval: POLL_INTERVAL_S, expiresIn: LINK_TTL_MS / 1000 }
    }],

    ['POST', /^\/v1\/device\/poll$/, async (req, body) => {
      const link = await store.linkByDeviceCode(hashToken(body.deviceCode))
      if (!link) throw new HttpError(404, 'unknown device code')
      const waiting = link.status === 'pending' || link.status === 'approving'
      if (link.status === 'consumed' || (waiting && link.expiresAt < now())) throw new HttpError(410, 'expired')
      if (link.status === 'approved' && link.expiresAt + COLLECT_GRACE_MS < now()) throw new HttpError(410, 'expired')
      if (link.status === 'denied') throw new HttpError(403, 'denied')
      // Pending polls skip the signature check so the app can poll cheaply; they
      // reveal nothing. Only collecting the token needs proof of the key.
      if (waiting) return [202, { status: 'pending' }]
      // Proof of possession: anyone can start a link with a computer's public key
      // (it's shared with session members), but only the computer can sign for it.
      const sig = typeof body.signature === 'string' ? Buffer.from(body.signature, 'base64url') : null
      if (!sig || !verifyChallenge(parsePublicKey(link.publicKey), 'device-link', Buffer.from(String(body.deviceCode)), sig)) throw new HttpError(401, "this computer's signature doesn't match")
      // Approved: claim the link before minting, so two polls racing on the same
      // link can't both win a token — only the caller that flips it gets one.
      if (!await store.claimLink(link.id, 'approved', 'consumed')) throw new HttpError(410, 'expired')
      const token = newToken('qd_')
      await store.setDeviceToken(link.deviceId, hashToken(token))
      return { status: 'approved', token, profile: await store.profile(link.userId) }
    }],

    ['GET', /^\/v1\/device\/link\/([^/]+)$/, async (req, body, [code]) => {
      await user(req)
      const link = await openLink(code)
      return { userCode: link.userCode, deviceName: link.deviceName, platform: link.platform, expiresAt: link.expiresAt }
    }],

    ['POST', /^\/v1\/device\/approve$/, async (req, body) => {
      const u = await user(req)
      const link = await openLink(body.userCode)
      // Claim the link first, so two approvals racing on one code can't both make a device.
      if (!await store.claimLink(link.id, 'pending', 'approving')) throw new HttpError(410, 'this code has expired or was already used')
      if (!body.approve) { await store.updateLink(link.id, { status: 'denied', userId: u.userId }); return { status: 'denied' } }
      let device
      try {
        device = await store.upsertDevice({ userId: u.userId, name: link.deviceName, platform: link.platform, publicKey: link.publicKey })
      } catch (err) {
        // Put the link back so the person can retry rather than being stuck mid-approval.
        await store.updateLink(link.id, { status: 'pending' }).catch(() => {})
        throw err
      }
      await store.updateLink(link.id, { status: 'approved', userId: u.userId, deviceId: device.id })
      return { status: 'approved', device: { id: device.id, name: device.name } }
    }],

    ['GET', /^\/v1\/me$/, async (req) => {
      const d = await device(req)
      return { profile: await store.profile(d.userId), device: { id: d.id, name: d.name } }
    }],

    ['PUT', /^\/v1\/me\/profile$/, async (req, body) => {
      const d = await device(req)
      const patch = cleanProfile(body)
      if (!Object.keys(patch).length) return { profile: await store.profile(d.userId) }
      return { profile: await store.updateProfile(d.userId, patch) }
    }],

    ['POST', /^\/v1\/me\/signout$/, async (req) => {
      const d = await device(req)
      await store.revokeDevice(d.id)
      return { ok: true }
    }],

    ['DELETE', /^\/v1\/me\/account$/, async (req) => {
      const u = await user(req)
      // Every org keeps exactly one owner, so an owner hands it on (or deletes it) first.
      if ((await store.orgsForUser(u.userId)).some((o) => o.ownerId === u.userId)) throw new HttpError(409, 'you own an org; transfer it or delete it first')
      await store.deleteUser(u.userId)
      return { ok: true }
    }],

    ['POST', /^\/v1\/agents$/, async (req, body) => {
      const u = await user(req)
      const name = String(body.name || '').trim().slice(0, 40)
      if (!name) throw new HttpError(400, 'give the agent a name')
      const key = newToken('qa_')
      const agent = await store.createAgent({ ownerId: u.userId, name, keyPrefix: key.slice(0, 8), keyHash: hashToken(key), ...newAgentIdentity(agentKeySecret) })
      return { agent, key }
    }],

    ['GET', /^\/v1\/agents$/, async (req) => {
      const u = await user(req)
      return { agents: await store.listAgents(u.userId) }
    }],

    ['DELETE', /^\/v1\/agents\/([^/]+)$/, async (req, body, [id]) => {
      const u = await user(req)
      // Agent ids are uuids; anything else can't exist (and Postgres would reject it).
      if (!UUID.test(id) || !await store.revokeAgent(u.userId, id)) throw new HttpError(404, 'no such agent')
      return { ok: true }
    }]
  ]

  // Org routes live in their own modules and share the caller check and the limiter.
  const ctx = { store, user, now, site, mailer, log, limit: limitInvites }
  routes.push(...orgRoutes(ctx), ...memberRoutes(ctx), ...teamRoutes(ctx), ...inviteRoutes(ctx))

  async function openLink (code) {
    const userCode = normalizeUserCode(code)
    const link = userCode && await store.linkByUserCode(userCode)
    if (!link) throw new HttpError(404, 'no such code')
    if (link.status !== 'pending' || link.expiresAt < now()) throw new HttpError(410, 'this code has expired or was already used')
    return link
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req) })
      res.end(JSON.stringify(data))
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors(req), 'access-control-allow-methods': 'GET,POST,PUT,DELETE', 'access-control-allow-headers': 'authorization,content-type', 'access-control-max-age': '600' }); return res.end() }
    try {
      const url = new URL(req.url, 'http://x')
      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname))
      if (!route) throw new HttpError(404, 'not found')
      const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : {}
      const out = await route[2](req, body, url.pathname.match(route[1]).slice(1).map(decodePart))
      if (Array.isArray(out)) send(out[0], out[1]); else send(200, out)
    } catch (err) {
      // A unique index said no (a taken team or role name): the caller can fix that.
      if (err?.code === '23505') return send(409, { error: 'that name is already taken' })
      // A foreign-key check said no (something from another org, or still referenced): a conflict, not a crash.
      if (err?.code === '23503') return send(409, { error: 'that is still in use' })
      // Supabase errors are plain objects, so fall back to their JSON.
      if (!(err instanceof HttpError)) log(`api error: ${err?.stack || err?.message || JSON.stringify(err)}`)
      send(err.status || 500, { error: err instanceof HttpError ? err.message : 'internal error' })
    }
  })

  // Only the website may call the API from a browser.
  function cors (req) {
    return site && req.headers.origin === site ? { 'access-control-allow-origin': site, vary: 'origin' } : {}
  }

  return new Promise((resolve) => server.listen(port, host, () => {
    const p = server.address().port
    resolve({ port: p, url: `http://${host}:${p}`, close: () => new Promise((r) => server.close(r)), startKeys: () => limitStarts.size() })
  }))
}

function decodePart (s) {
  try { return decodeURIComponent(s) } catch { throw new HttpError(400, 'bad path') }
}

function readJson (req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { req.destroy(); reject(new HttpError(413, 'too large')) } else chunks.push(c) })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reject(new HttpError(400, 'bad json')) }
      // Handlers read fields off the body; null, arrays and scalars carry none.
      resolve(body && typeof body === 'object' && !Array.isArray(body) ? body : {})
    })
    req.on('error', reject)
  })
}
