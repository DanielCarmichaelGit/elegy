// Session passes from the accounts API. A pass proves who you are to the relay
// for 10 minutes. Clients keep one until 2 minutes before it runs out, and while
// connected they fetch a fresh one every 5 minutes (see connection.js).
import { readPass } from './passes.js'
import { apiUrl, readAccount, NOT_SIGNED_IN, SIGNED_OUT } from './account.js'
import { agentAccess, readAgent } from './agent-join.js'

export const PASS_EARLY_MS = 2 * 60 * 1000
export const PASS_REFRESH_MS = 5 * 60 * 1000
const AGENT_SIGNED_OUT = "This agent's keys stopped working. Invite it again."

/** The API turned the token away: this computer (or agent) is signed out for good. */
export class SignedOutError extends Error {
  constructor (message) {
    super(message)
    this.signedOut = true
  }
}

export class PassSource {
  /** `fetchPass` resolves to { pass, expiresAt }. */
  constructor ({ fetchPass, now = Date.now, earlyMs = PASS_EARLY_MS }) {
    this.fetchPass = fetchPass
    this.now = now
    this.earlyMs = earlyMs
    this.current = null // { pass, expiresAt, payload }
    this.pending = null
  }

  /** A pass with at least `earlyMs` left, fetching one when needed. */
  get () {
    if (this.current && this.now() < this.current.expiresAt - this.earlyMs) return Promise.resolve(this.current.pass)
    return this.fresh()
  }

  /** Always asks for a new pass. Calls made while one is on its way share it. */
  fresh () {
    if (!this.pending) {
      this.pending = Promise.resolve()
        .then(() => this.fetchPass())
        .then(({ pass, expiresAt }) => {
          this.current = { pass, expiresAt, payload: readPass(pass) }
          return pass
        })
        .finally(() => { this.pending = null })
    }
    return this.pending
  }

  /** Who the passes are for ({ sub, kind, name, key, … }), once one has been fetched. */
  get payload () {
    return this.current ? this.current.payload : null
  }
}

async function requestPass (fetchImpl, api, bearer, signedOutMessage) {
  let res
  try {
    res = await fetchImpl(`${String(api).replace(/\/+$/, '')}/v1/passes`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` } })
  } catch (err) {
    throw new Error(`Couldn't reach Quilt (${err.cause?.code || err.message}).`)
  }
  const body = await res.json().catch(() => null)
  if (res.status === 401) throw new SignedOutError(signedOutMessage)
  if (!res.ok || !body || typeof body.pass !== 'string') throw Object.assign(new Error(body?.error || `Quilt answered ${res.status}.`), { status: res.status })
  return body
}

/** Passes for this computer's account, from its qd_ token. */
export function personPasses ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch, now } = {}) {
  return new PassSource({ now, fetchPass: () => requestPass(fetchImpl, api, token, SIGNED_OUT) })
}

/** Passes for a saved agent, from its access key (refreshed with its refresh key when it runs out). */
export function agentPasses ({ name, dir, fetch: fetchImpl = globalThis.fetch, now } = {}) {
  return new PassSource({
    now,
    fetchPass: async () => {
      let saved
      try {
        saved = await agentAccess({ name, dir, fetch: fetchImpl, now })
      } catch (err) {
        if (err.status === 401) throw new SignedOutError(err.message)
        throw err
      }
      return requestPass(fetchImpl, saved.api, saved.accessKey, AGENT_SIGNED_OUT)
    }
  })
}

/**
 * What a session started here signs in with: a saved agent's passes and key, or
 * this computer's account. `name` is the name saved on this computer, so a
 * session can start before (or without, when offline) its first pass.
 */
export function sessionPasses ({ agent = null, dir } = {}) {
  if (agent) {
    const saved = readAgent({ name: agent, dir })
    return { passes: agentPasses({ name: agent, dir }), identity: saved.identity, kind: 'agent', name: saved.name || agent }
  }
  const account = readAccount()
  if (!account) throw new Error(NOT_SIGNED_IN)
  return { passes: personPasses({ token: account.token }), identity: null, kind: 'human', name: account.account.name || null }
}
