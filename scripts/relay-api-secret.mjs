// Makes RELAY_API_SECRET, the secret the relay signs its presence reports with, and
// hands the same value to both Fly apps without it ever reaching a screen or a file:
//   node scripts/relay-api-secret.mjs
// Each app gets it staged (`fly secrets import --stage`), so it applies on that app's
// next deploy. If either import fails, run it again: it makes a new secret for both.
// FLY_BIN points it at another fly command (tests use a stand-in).
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const APPS = ['quilt-api', 'cowove-relay']
const fly = process.env.FLY_BIN || 'fly'
const secret = crypto.randomBytes(32).toString('base64url')

for (const app of APPS) {
  const r = spawnSync(fly, ['secrets', 'import', '--app', app, '--stage'], { input: `RELAY_API_SECRET=${secret}\n`, stdio: ['pipe', 'inherit', 'inherit'] })
  if (r.status !== 0) {
    process.stderr.write(`fly secrets import failed for ${app}. Run this again: it makes a new secret for both apps.\n`)
    process.exit(1)
  }
}
process.stdout.write(`RELAY_API_SECRET is staged on ${APPS.join(' and ')}; it applies when each is next deployed.\n`)
