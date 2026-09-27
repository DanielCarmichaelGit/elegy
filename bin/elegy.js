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
  elegy chat                                          Live chat (messages, DMs, files) in this terminal
  elegy say [@name] <message>                         Message everyone, or one person with @name
  elegy send <file> [@name] [message]                 Send a file (not added to the project)
  elegy messages [--all] [--with name]                Show unread (or all) messages
  elegy get <message-id> [dest]                       Download a shared file again
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
    case 'say': return say()
    case 'send': return sendFile()
    case 'messages': case 'inbox': return messages()
    case 'get': return getFile()
    case 'chat': return chat()
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
  if (process.env.ELEGY_DEBUG) session.on('debug', (m) => console.log(`[${stamp()}] debug: ${m}`))
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

/** Splits "@bob rest of message" into { to: 'bob', rest: [...] }. */
function splitRecipient (args) {
  const i = args.indexOf('--to')
  if (i !== -1) return { to: args[i + 1], rest: [...args.slice(0, i), ...args.slice(i + 2)] }
  if (args[0] && args[0].startsWith('@') && args[0].length > 1) return { to: args[0].slice(1), rest: args.slice(1) }
  return { to: undefined, rest: args }
}

async function say () {
  const { to, rest } = splitRecipient(argv)
  if (!rest.length) fail('usage: elegy say [@name] <message>')
  await simple('/say', { text: rest.join(' '), to }, (r) =>
    to ? `sent to ${to}${r.recipientOnline ? '' : ' (offline, they will see it when they reconnect)'}` : 'sent')
}

async function sendFile () {
  const [file, ...more] = argv
  if (!file) fail('usage: elegy send <file> [@name] [message]')
  if (!fs.existsSync(file)) fail(`no such file: ${file}`)
  const { to, rest } = splitRecipient(more)
  await simple('/send', { path: path.resolve(file), to, text: rest.join(' ') }, (r) =>
    `sent ${r.file.name}${to ? ` to ${to}` : ''}`)
}

async function messages () {
  const { values } = parseArgs({ args: argv, options: { all: { type: 'boolean' }, with: { type: 'string' }, n: { type: 'string', short: 'n' } } })
  const { d, call } = await daemonOrFail()
  const { renderMessage } = await import('../src/status.js')
  const all = values.all || !!values.with
  const { messages } = await call(d, 'POST', '/messages', { unreadOnly: !all, with: values.with, limit: Number(values.n || 50) })
  const me = (await call(d, 'GET', '/status')).me.name
  if (!messages.length) return console.log(all ? 'no messages yet' : 'no unread messages (use --all to see history)')
  for (const m of messages) console.log(plain(renderMessage(m, me)))
}

async function getFile () {
  if (!argv[0]) fail('usage: elegy get <message-id> [dest]')
  await simple('/get', { id: argv[0], dest: argv[1] ? path.resolve(argv[1]) : undefined }, (r) => `saved to ${r.path}`)
}

const plain = (md) => md.replace(/\*\*/g, '').replace(/`/g, '')

async function chat () {
  const { d, call } = await daemonOrFail()
  const { renderMessage } = await import('../src/status.js')
  const readline = await import('node:readline')
  const st = await call(d, 'GET', '/status')
  const me = st.me.name
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })
  const print = (line) => {
    readline.clearLine(process.stdout, 0)
    readline.cursorTo(process.stdout, 0)
    console.log(line)
    rl.prompt(true)
  }

  console.log(`chatting in room ${st.room} as ${me}. Online: ${st.peers.map((p) => p.name).join(', ') || 'nobody else yet'}`)
  console.log('type a message, "@name msg" for a direct message, "/send <file> [@name] [msg]", "/get <id> [dest]", "/who", "/quit"\n')
  const { messages: backlog } = await call(d, 'POST', '/messages', { limit: 20 })
  for (const m of backlog) console.log(plain(renderMessage(m, me)))

  // Live messages over server-sent events.
  const ctrl = new AbortController()
  ;(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${d.port}/events`, { headers: { authorization: `Bearer ${d.token}` }, signal: ctrl.signal })
      const decoder = new TextDecoder()
      let buf = ''
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const event = (block.match(/^event: (.*)$/m) || [])[1]
          const data = (block.match(/^data: (.*)$/m) || [])[1]
          if (!event || !data) continue
          const payload = JSON.parse(data)
          if (event === 'message' && payload.by !== me) print(plain(renderMessage({ ...payload, unread: false }, me)))
          else if (event === 'log' && !payload.startsWith('💬')) print(`  · ${payload}`)
        }
      }
      if (!ctrl.signal.aborted) { print('lost connection to elegy'); process.exit(1) }
    } catch (err) {
      if (!ctrl.signal.aborted) { print(`lost connection to elegy: ${err.message}`); process.exit(1) }
    }
  })()

  rl.prompt()
  rl.on('line', async (line) => {
    line = line.trim()
    try {
      if (!line) {
        // nothing
      } else if (line === '/quit' || line === '/exit') {
        return rl.close()
      } else if (line === '/who') {
        const s = await call(d, 'GET', '/status')
        print(s.peers.length ? s.peers.map((p) => `  ${p.name} (${p.tool})${p.focus ? `: ${p.focus}` : ''}`).join('\n') : '  nobody else is online')
      } else if (line.startsWith('/send ')) {
        const [file, ...more] = line.slice(6).trim().split(/\s+/)
        const { to, rest } = splitRecipient(more)
        const r = await call(d, 'POST', '/send', { path: path.resolve(file), to, text: rest.join(' ') })
        print(`  sent ${r.file.name}${to ? ` to ${to}` : ''}`)
      } else if (line.startsWith('/get ')) {
        const [id, dest] = line.slice(5).trim().split(/\s+/)
        const r = await call(d, 'POST', '/get', { id, dest: dest ? path.resolve(dest) : undefined })
        print(`  saved to ${r.path}`)
      } else if (line.startsWith('/')) {
        print('  unknown command')
      } else {
        const { to, rest } = splitRecipient(line.split(' '))
        const r = await call(d, 'POST', '/say', { text: rest.join(' '), to })
        if (to && !r.recipientOnline) print(`  (${to} is offline; they'll see it when they reconnect)`)
      }
    } catch (err) {
      print(`  error: ${err.message}`)
    }
    rl.prompt()
  })
  rl.on('close', () => { ctrl.abort(); process.exit(0) })
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
