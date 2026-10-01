// Reads the accounts API's published pass key and prints only the line
// `fly secrets import` reads, for the relay:
//   node scripts/relay-pass-key.mjs | fly secrets import --app cowove-relay
// A relay with a bad QUILT_PASS_PUBLIC_KEY refuses to start, so on any problem
// (API down, an error reply, no key, not an Ed25519 key) this prints nothing on
// stdout, says why on stderr and exits non-zero, and the import never runs.
// QUILT_API_URL points it at another API, for development and tests.
import { parsePublicKey } from '../src/identity.js'

const api = String(process.env.QUILT_API_URL || 'https://api.heyquilt.com').replace(/\/+$/, '')
const url = `${api}/v1/passes/key`

function fail (msg) {
  process.stderr.write(`${msg}\nQUILT_PASS_PUBLIC_KEY was not changed.\n`)
  process.exit(1)
}

let res
try {
  res = await fetch(url, { signal: AbortSignal.timeout(15000) })
} catch (err) {
  fail(`Could not reach ${url}: ${err.cause?.message || err.message}`)
}
if (!res.ok) fail(`${url} answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
let body
try { body = await res.json() } catch { fail(`${url} did not answer with JSON.`) }
const key = body && typeof body.publicKey === 'string' ? body.publicKey : ''
if (!key) fail(`${url} returned no public key.`)
// The same check the relay makes at startup (src/server.js), plus plain base64url only,
// so nothing else can ride along into the secrets import.
if (!/^[A-Za-z0-9_-]+$/.test(key) || !parsePublicKey(key)) fail(`${url} returned something that is not an Ed25519 public key (spki, base64url).`)
process.stdout.write(`QUILT_PASS_PUBLIC_KEY=${key}\n`)
