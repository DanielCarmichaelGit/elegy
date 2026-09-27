#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { parseArgs } from 'node:util'

const HELP = `elegy: real-time pair vibe coding with any AI tool

Usage:
  elegy serve [--port 4321] [--data ./elegy-data]   Run a relay server
  elegy join --server <ws(s)://relay>                 Start a new session in this folder
  elegy join <invite-code>                            Join a partner's session in this folder
  elegy join                                          Rejoin this folder's last session
  elegy setup                                         Connect Claude Code / Cursor / others via MCP
  elegy status                                        Show collaborators, claims, activity, chat
  elegy say <message>                                 Message your collaborators
  elegy focus <what you're doing>                     Tell collaborators what you're working on
  elegy claim <path|glob> [reason]                    Mark files as yours for now
  elegy release <path|glob|*>                         Release a claim
  elegy invite                                        Print this session's invite code
  elegy mcp                                           Run the MCP server (used by AI tools)

Join options:
  --name <you>        Your display name (default: OS username)
  --tool <tool>       What you're coding with, e.g. claude, cursor (shown to others)
  --dir <folder>      Project folder (default: current folder)
  --room <name> --secret <secret>   Join/create a specific room instead of using an invite
  --prefer local      On first join, keep your local version of files that differ
                      (default: take the session's version and back yours up)
`

const cmd = process.argv[2]
const argv = process.argv.slice(3)

const encodeInvite = (c) => Buffer.from(JSON.stringify({ s: c.server, r: c.room, k: c.secret })).toString('base64url')
const decodeInvite = (code) => {
  const j = JSON.parse(Buffer.from(code.replace(/^elegy:/, ''), 'base64url').toString('utf8'))
  if (!j.s || !j.r) throw new Error('bad invite')
  return { server: j.s, room: j.r, secret: j.k || '' }
}

async function main () {
  switch (cmd) {
    case 'serve': return serve()
    case 'join': return join()
    case 'setup': return doSetup()
    case 'mcp': return (await import('../src/mcp.js')).runMcp()
    case 'status': return status()
    case 'say': return simple('/say', { text: argv.join(' ') }, () => 'sent')
    case 'focus': return simple('/focus', { text: argv.join(' ') }, () => 'focus updated')
    case 'claim': return simple('/claim', { pattern: argv[0], note: argv.slice(1).join(' ') }, (r) =>
      `claimed ${argv[0]}` + (r.overlapping?.length ? `\nwarning: overlaps ${r.overlapping.map((c) => `${c.by}'s ${c.pattern}`).join(', ')}` : ''))
    case 'release': return simple('/release', { pattern: argv[0] || '*' }, (r) => `released ${r.released} claim(s)`)
    case 'invite': return invite()
    case undefined: case '-h': case '--help': case 'help':
      process.stdout.write(HELP); return
    default:
      console.error(`unknown command: ${cmd}\n`); process.stdout.write(HELP); process.exit(1)
  }
}

async function serve () {
  const { values } = parseArgs({ args: argv, options: { port: { type: 'string' }, host: { type: 'string' }, data: { type: 'string' } } })
  const { startServer } = await import('../src/server.js')
  const port = Number(values.port || process.env.PORT || 4321)
  const dataDir = path.resolve(values.data || process.env.ELEGY_DATA || './elegy-data')
  const srv = await startServer({ port, host: values.host || '0.0.0.0', dataDir })
  console.log(`elegy relay listening on :${srv.port} (data: ${dataDir})`)
  console.log(`start a session with:  elegy join --server ws://<this-host>:${srv.port}`)
  const shutdown = async () => { await srv.close(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function join () {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: 'string' }, room: { type: 'string' }, secret: { type: 'string' },
      name: { type: 'string' }, tool: { type: 'string' }, dir: { type: 'string' },
      prefer: { type: 'string' }, quiet: { type: 'boolean' }
    }
  })
  const dir = path.resolve(values.dir || '.')
  const cfgFile = path.join(dir, '.elegy', 'config.json')
  let saved = {}
  try { saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) } catch {}

  let conn
  if (positionals[0]) {
    try { conn = decodeInvite(positionals[0]) } catch { fail('That invite code is not valid.') }
  } else if (values.server || process.env.ELEGY_SERVER) {
    conn = {
      server: values.server || process.env.ELEGY_SERVER,
      room: values.room || `room-${crypto.randomBytes(4).toString('hex')}`,
      secret: values.secret || process.env.ELEGY_SECRET || crypto.randomBytes(18).toString('base64url')
    }
  } else if (saved.server) {
    conn = { server: saved.server, room: saved.room, secret: saved.secret }
  } else {
    fail('Give a relay to start a session (elegy join --server wss://…) or an invite code to join one.')
  }
  if (!/^wss?:\/\//.test(conn.server)) fail('--server must start with ws:// or wss://')

  const name = values.name || saved.name || os.userInfo().username
  const tool = values.tool || saved.tool || 'unknown'
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true })
  fs.writeFileSync(cfgFile, JSON.stringify({ ...conn, name, tool }, null, 2), { mode: 0o600 })
  ensureGitExclude(dir)

  const { Session } = await import('../src/session.js')
  const { startControl } = await import('../src/control.js')
  const { renderStatus } = await import('../src/status.js')

  const session = new Session({ dir, ...conn, name, tool, prefer: values.prefer === 'local' ? 'local' : 'remote' })
  const stamp = () => new Date().toLocaleTimeString()
  session.on('log', (m) => console.log(`[${stamp()}] ${m}`))
  session.on('fatal', (err) => { console.error(err.message); process.exit(1) })
  const statusFile = path.join(dir, '.elegy', 'STATUS.md')
  session.on('status-changed', () => {
    try { fs.writeFileSync(statusFile, renderStatus(session.status())) } catch {}
  })

  console.log(`elegy: syncing ${dir}`)
  console.log(`  room ${conn.room} on ${conn.server} as "${name}"`)
  await session.start()
  const control = await startControl(session)

  console.log(`\nInvite your partner. They run this in an empty (or matching) project folder:\n\n  elegy join ${encodeInvite(conn)}\n`)
  console.log('Tip: run `elegy setup` once so your AI tools can see each other. Ctrl+C to stop.\n')

  const stop = async () => {
    console.log('\nstopping…')
    await control.close()
    await session.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

/** Keep .elegy/ out of git without editing the (synced) .gitignore. */
function ensureGitExclude (dir) {
  const exclude = path.join(dir, '.git', 'info', 'exclude')
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) return
    const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
    if (!text.split('\n').includes('.elegy/')) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true })
      fs.appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}.elegy/\n`)
    }
  } catch {}
}

async function doSetup () {
  const { setup } = await import('../src/setup.js')
  const changed = setup(process.cwd())
  if (!changed.length) return console.log('already set up')
  console.log('updated:\n' + changed.map((c) => `  - ${c}`).join('\n'))
  console.log('\nRestart your AI tool (or reload MCP servers) to pick up the "elegy" MCP server.')
  console.log('Other tools: point them at AGENTS.md, or have them run `elegy status`.')
}

async function daemonOrFail () {
  const { findDaemon, call } = await import('../src/control.js')
  const d = findDaemon()
  if (!d) fail('elegy is not running here. Start it with `elegy join` in the project folder.')
  return { d, call }
}

async function status () {
  const { d, call } = await daemonOrFail()
  console.log((await call(d, 'GET', '/status')).markdown)
}

async function simple (route, body, format) {
  const { d, call } = await daemonOrFail()
  try { console.log(format(await call(d, 'POST', route, body))) } catch (err) { fail(err.message) }
}

function invite () {
  let dir = process.cwd()
  while (true) {
    const f = path.join(dir, '.elegy', 'config.json')
    if (fs.existsSync(f)) {
      const c = JSON.parse(fs.readFileSync(f, 'utf8'))
      return console.log(`elegy join ${encodeInvite(c)}`)
    }
    if (path.dirname(dir) === dir) fail('no session configured in this folder')
    dir = path.dirname(dir)
  }
}

function fail (msg) {
  console.error(msg)
  process.exit(1)
}

main().catch((err) => fail(err.stack || err.message))
