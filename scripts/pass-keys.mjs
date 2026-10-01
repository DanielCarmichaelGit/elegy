// Makes the accounts API's pass signing key. It prints only the line
// `fly secrets import` reads, so the private key goes straight into Fly and
// never onto a screen:
//   node scripts/pass-keys.mjs | fly secrets import --app quilt-api --stage
// The public half is printed to stderr, and once deployed the API serves it at
// /v1/passes/key for the relay's QUILT_PASS_PUBLIC_KEY.
import { newPassKeys } from '../src/passes.js'

const { privateKey, publicKey } = newPassKeys()
process.stdout.write(`PASS_SIGNING_KEY=${privateKey}\n`)
process.stderr.write(`public key (QUILT_PASS_PUBLIC_KEY): ${publicKey}\n`)
