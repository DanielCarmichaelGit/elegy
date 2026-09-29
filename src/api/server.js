// src/api/server.js
// The Quilt accounts API: links desktop apps to accounts (a device-code flow, like
// signing in to a TV app) and manages agents. Plain node:http, like the relay.
import http from 'node:http'
import { newToken, hashToken, newUserCode, normalizeUserCode } from './tokens.js'
import { parsePublicKey } from '../identity.js'
import { newAgentIdentity } from './agent-keys.js'

const LINK_TTL_MS = 10 * 60 * 1000
const POLL_INTERVAL_S = 3
const MAX_BODY = 16 * 1024

class HttpError extends Error { constructor (status, message) { super(message); this.status = status } }

export function startApi ({ port = 0, host = '127.0.0.1', store, verifyUser, siteUrl, agentKeySecret, now = Date.now, log = () => {}, startLimit = 10, trustProxy = false }) {
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

  // A few link requests per minute per address is plenty for a person.
  const starts = new Map()
  function limitStarts (req) {
    const ip = (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress
    const recent = (starts.get(ip) || []).filter((t) => now() - t < 60_000)
    if (recent.length >= startLimit) throw new HttpError(429, 'too many sign-in attempts; try again in a minute')
    starts.set(ip, [...recent, now()])
  }

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
      if (link.status === 'consumed' || (link.status === 'pending' && link.expiresAt < now())) throw new HttpError(410, 'expired')
      if (link.status === 'denied') throw new HttpError(403, 'denied')
      if (link.status === 'pending') return [202, { status: 'pending' }]
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
      if (!body.approve) { await store.updateLink(link.id, { status: 'denied', userId: u.userId }); return { status: 'denied' } }
      const device = await store.upsertDevice({ userId: u.userId, name: link.deviceName, platform: link.platform, publicKey: link.publicKey })
      await store.updateLink(link.id, { status: 'approved', userId: u.userId, deviceId: device.id })
      return { status: 'approved', device: { id: device.id, name: device.name } }
    }],

    ['GET', /^\/v1\/me$/, async (req) => {
      const d = await device(req)
      return { profile: await store.profile(d.userId), device: { id: d.id, name: d.name } }
    }],

    ['PUT', /^\/v1\/me\/profile$/, async (req, body) => {
      const d = await device(req)
      return { profile: await store.updateProfile(d.userId, cleanProfile(body)) }
    }],

    ['POST', /^\/v1\/me\/signout$/, async (req) => {
      const d = await device(req)
      await store.revokeDevice(d.id)
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
      if (!await store.revokeAgent(u.userId, id)) throw new HttpError(404, 'no such agent')
      return { ok: true }
    }]
  ]

  async function openLink (code) {
    const userCode = normalizeUserCode(code)
    const link = userCode && await store.linkByUserCode(userCode)
    if (!link) throw new HttpError(404, 'no such code')
    if (link.status !== 'pending' || link.expiresAt < now()) throw new HttpError(410, 'this code has expired or was already used')
    return link
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req) })
      res.end(JSON.stringify(data))
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors(req), 'access-control-allow-methods': 'GET,POST,PUT,DELETE', 'access-control-allow-headers': 'authorization,content-type', 'access-control-max-age': '600' }); return res.end() }
    try {
      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname))
      if (!route) throw new HttpError(404, 'not found')
      const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : {}
      const out = await route[2](req, body, url.pathname.match(route[1]).slice(1).map(decodeURIComponent))
      if (Array.isArray(out)) send(out[0], out[1]); else send(200, out)
    } catch (err) {
      if (!(err instanceof HttpError)) log(`api error: ${err.stack || err}`)
      send(err.status || 500, { error: err instanceof HttpError ? err.message : 'internal error' })
    }
  })

  // Only the website may call the API from a browser.
  function cors (req) {
    return site && req.headers.origin === site ? { 'access-control-allow-origin': site, vary: 'origin' } : {}
  }

  return new Promise((resolve) => server.listen(port, host, () => {
    const p = server.address().port
    resolve({ port: p, url: `http://${host}:${p}`, close: () => new Promise((r) => server.close(r)) })
  }))
}

function readJson (req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { req.destroy(); reject(new HttpError(413, 'too large')) } else chunks.push(c) })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new HttpError(400, 'bad json')) }
    })
    req.on('error', reject)
  })
}
