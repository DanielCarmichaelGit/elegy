#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

const HELP = `cowove: real-time pair vibe coding with any AI tool

Usage:
  cowove ui                                            Open the app in your browser (start, join, chat)
  cowove serve [--port 4321] [--data ./cowove-data]   Run a relay server (see docs/hosting.md)
  cowove relay set <url> [--key <key>]                 Use a hosted relay by default
  cowove relay [check [url] | clear]                   Show, test, or forget the default relay
  cowove join [--server <ws(s)://relay>]               Start a new session in this folder
  cowove join <invite-link>                            Join a partner's session in this folder
  cowove join                                          Rejoin this folder's last session
  cowove setup                                         Connect Claude Code / Cursor / others via MCP
  cowove status                                        Show collaborators, claims, activity, chat
  cowove chat                                          Live chat (messages, DMs, files) in this terminal
  cowove say [@name] <message>                         Message everyone, or one person with @name
  cowove send <file> [@name] [message]                 Send a file (not added to the project)
  cowove messages [--all] [--with name]                Show unread (or all) messages
  cowove get <message-id> [dest]                       Download a shared file again
  cowove focus <what you're doing>                     Tell collaborators what you're working on
  cowove claim <path|glob> [reason]                    Mark files as yours for now
  cowove release <path|glob|*>                         Release a claim
  cowove invite                                        Print this session's invite code
  cowove stop                                          Shut down everything cowove is running (relay, app, syncs)
  cowove doctor [folder] [--watch 30]                  Check what cowove can see of your Claude Code / Cursor chats
  cowove mcp                                           Run the MCP server (used by AI tools)

Join options:
  --name <you>        Your display name (default: OS username)
  --tool <tool>       What you're coding with, e.g. claude, cursor (shown to others)
  --dir <folder>      Project folder (default: current folder)
  --room <name> --secret <secret>   Join/create a specific room instead of using an invite
  --agent            Join as an AI agent (shown with an agent badge)
  --prefer local      On first join, keep your local version of files that differ
                      (default: take the session's version and back yours up)
`

const cmd = process.argv[2]
const argv = process.argv.slice(3)

async function main () {
  switch (cmd) {
    case 'serve': return serve()
    case 'ui': return ui()
    case 'relay': return relayCmd()
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
    case 'stop': return stopAll()
    case 'doctor': {
      const i = argv.indexOf('--watch')
      const secs = i >= 0 ? Number(argv[i + 1]) || 30 : 0
      const dir = argv.find((a, k) => !a.startsWith('--') && !(i >= 0 && k === i + 1))
      return (await import('../src/doctor.js')).doctor({ dir, watchSeconds: secs })
    }
    case undefined: case '-h': case '--help': case 'help':
      process.stdout.write(HELP); return
    default:
      console.error(`unknown command: ${cmd}\n`); process.stdout.write(HELP); process.exit(1)
  }
}

async function serve () {
  const { values } = parseArgs({ args: argv, options: { port: { type: 'string' }, host: { type: 'string' }, data: { type: 'string' }, key: { type: 'string' } } })
  const { startServer } = await import('../src/server.js')
  const port = Number(values.port || process.env.PORT || 4321)
  const dataDir = path.resolve(values.data || process.env.COWOVE_DATA || './cowove-data')
  const srv = await startServer({ port, host: values.host || '0.0.0.0', dataDir, ...(values.key ? { relayKey: values.key } : {}) })
  const c = srv.config
  console.log(`cowove relay listening on :${srv.port} (data: ${dataDir})`)
  console.log(`  new sessions: ${c.relayKey ? 'need the relay key' : 'open to anyone who can reach this relay (set COWOVE_RELAY_KEY to restrict)'}`)
  console.log(`  limits: ${Math.round(c.maxRoomBytes / 1048576)} MB per session, ${Math.round(c.maxRoomFileBytes / 1048576)} MB of shared files, ${c.maxConnsPerIp} connections per address, idle sessions removed after ${c.roomTtlDays} days`)
  console.log(`start a session with:  cowove join --server ws://<this-host>:${srv.port}`)
  const { registerProcess } = await import('../src/procs.js')
  registerProcess('relay', { port: srv.port, dataDir })
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
      prefer: { type: 'string' }, agent: { type: 'boolean' }
    }
  })
  const { runSession, decodeInvite, newConn, readConfig } = await import('../src/runner.js')
  const dir = path.resolve(values.dir || '.')
  const saved = readConfig(dir) || {}

  let conn
  if (positionals[0]) {
    try { conn = decodeInvite(positionals[0]) } catch (err) { fail(err.message) }
  } else if (values.server || process.env.COWOVE_SERVER) {
    conn = newConn(values.server || process.env.COWOVE_SERVER)
    if (values.room) conn.room = values.room
    if (values.secret || process.env.COWOVE_SECRET) conn.secret = values.secret || process.env.COWOVE_SECRET
  } else if (saved.server) {
    conn = { server: saved.server, room: saved.room, secret: saved.secret, ...(saved.key ? { key: saved.key } : {}) }
  } else {
    const { defaultRelay } = await import('../src/settings.js')
    const d = defaultRelay()
    if (!d) fail('Give a relay to start a session (cowove join --server wss://…), set a default with `cowove relay set <url>`,\nor pass an invite link to join one. Or run `cowove ui` to do it in your browser.')
    conn = newConn(d.relay, d.key)
    console.log(`starting a new session on your default relay ${d.relay}`)
  }

  const stamp = () => new Date().toLocaleTimeString()
  const name = values.name || saved.name || os.userInfo().username
  console.log(`cowove: syncing ${dir}`)
  console.log(`  room ${conn.room} on ${conn.server} as "${name}"`)
  let run
  try {
    run = await runSession({
      dir,
      conn,
      name,
      tool: values.tool || saved.tool,
      prefer: values.prefer === 'local' ? 'local' : 'remote',
      kind: values.agent ? 'agent' : 'human',
      inviteServer: saved.room === conn.room ? saved.inviteServer : undefined,
      onLog: (m) => console.log(`[${stamp()}] ${m}`),
      onDebug: process.env.COWOVE_DEBUG ? (m) => console.log(`[${stamp()}] debug: ${m}`) : undefined,
      onFatal: (err) => fail(err.message)
    })
  } catch (err) {
    fail(err.message)
  }

  const { registerProcess } = await import('../src/procs.js')
  registerProcess('sync', { dir })
  console.log(`\nInvite your partner by sending them this link:\n\n  ${run.invite}\n\nThey paste it into cowove (Join a session), or run \`cowove join <link>\` in an empty (or matching) folder.\n`)
  console.log('Tip: run `cowove setup` once so your AI tools can see each other. Ctrl+C to stop.\n')

  const stop = async () => {
    console.log('\nstopping…')
    await run.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

async function relayCmd () {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { key: { type: 'string' } } })
  const { getSettings, saveSettings, normalizeRelay, checkRelay } = await import('../src/settings.js')
  const [sub, arg] = positionals
  const show = (h) => `ok · ${h.latencyMs} ms · ${h.connections} connection(s) · ${h.requiresKey ? 'starting sessions needs a relay key' : 'open to anyone'}`
  if (sub === 'set') {
    if (!arg) fail('usage: cowove relay set <url> [--key <key>]')
    let url
    try { url = normalizeRelay(arg) } catch (err) { fail(err.message) }
    try {
      const h = await checkRelay(url)
      console.log(`${url}: ${show(h)}`)
      if (h.requiresKey && !values.key && getSettings().relay !== url) console.log('note: this relay needs a key to start sessions; add --key <key> (joining others\' sessions works without it)')
    } catch (err) {
      console.log(`warning: ${err.message}. Saving it anyway.`)
    }
    const prev = getSettings()
    saveSettings({ relay: url, relayKey: values.key ?? (prev.relay === url ? prev.relayKey : undefined) })
    return console.log(`default relay set. \`cowove join\` and the app now start sessions on ${url}.`)
  }
  if (sub === 'clear') {
    saveSettings({ relay: undefined, relayKey: undefined })
    return console.log('default relay cleared')
  }
  const s = getSettings()
  const url = sub === 'check' ? (arg || s.relay) : s.relay
  if (!sub && !url) return console.log('no default relay. Set one with `cowove relay set wss://your-relay.example.com` (see docs/hosting.md).')
  if (!url) fail('usage: cowove relay check <url>')
  try {
    const h = await checkRelay(url)
    console.log(`${normalizeRelay(url)}${url === s.relay ? ' (default)' : ''}: ${show(h)}${url === s.relay && s.relayKey ? ' · key saved' : ''}`)
  } catch (err) {
    fail(`${url}: ${err.message}`)
  }
}

async function ui () {
  const { values } = parseArgs({ args: argv, options: { port: { type: 'string' }, 'no-open': { type: 'boolean' } } })
  const { startUi } = await import('../src/ui-server.js')
  const { registerProcess, stopProcesses } = await import('../src/procs.js')
  const app = await startUi({
    port: Number(values.port || 7420),
    // The app's "Shut down" button: stop every other cowove process, then this one.
    onShutdown: async () => {
      console.log('\nshutting down everything…')
      await stopProcesses()
      await app.close()
      process.exit(0)
    }
  })
  registerProcess('app', { port: app.port })
  console.log(`cowove is running at:\n\n  ${app.url}\n`)
  console.log('Keep this terminal open while you work. Ctrl+C to stop, or `cowove stop` to shut everything down.')
  if (!values['no-open']) openBrowser(app.url)
  const stop = async () => { console.log('\nstopping…'); await app.close(); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

async function openBrowser (url) {
  const { spawn } = await import('node:child_process')
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref() } catch {}
}

async function doSetup () {
  const { setup } = await import('../src/setup.js')
  const changed = setup(process.cwd())
  if (!changed.length) return console.log('already set up')
  console.log('updated:\n' + changed.map((c) => `  - ${c}`).join('\n'))
  console.log('\nRestart your AI tool (or reload MCP servers) to pick up the "cowove" MCP server.')
  console.log('Other tools: point them at AGENTS.md, or have them run `cowove status`.')
}

async function daemonOrFail () {
  const { findDaemon, call } = await import('../src/control.js')
  const d = findDaemon()
  if (!d) fail('cowove is not running here. Start it with `cowove join` in the project folder.')
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
  if (!rest.length) fail('usage: cowove say [@name] <message>')
  await simple('/say', { text: rest.join(' '), to }, (r) =>
    to ? `sent to ${to}${r.recipientOnline ? '' : ' (offline, they will see it when they reconnect)'}` : 'sent')
}

async function sendFile () {
  const [file, ...more] = argv
  if (!file) fail('usage: cowove send <file> [@name] [message]')
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
  if (!argv[0]) fail('usage: cowove get <message-id> [dest]')
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
      if (!ctrl.signal.aborted) { print('lost connection to cowove'); process.exit(1) }
    } catch (err) {
      if (!ctrl.signal.aborted) { print(`lost connection to cowove: ${err.message}`); process.exit(1) }
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

async function invite () {
  const { encodeInvite } = await import('../src/runner.js')
  let dir = process.cwd()
  while (true) {
    const f = path.join(dir, '.cowove', 'config.json')
    if (fs.existsSync(f)) {
      const c = JSON.parse(fs.readFileSync(f, 'utf8'))
      return console.log(encodeInvite({ ...c, server: c.inviteServer || c.server }))
    }
    if (path.dirname(dir) === dir) fail('no session configured in this folder')
    dir = path.dirname(dir)
  }
}

async function stopAll () {
  const { stopProcesses, describeProcess } = await import('../src/procs.js')
  const stopped = await stopProcesses()
  if (!stopped.length) return console.log('nothing to stop: cowove is not running')
  console.log('stopped:\n' + stopped.map((p) => `  - ${describeProcess(p)}`).join('\n'))
}

function fail (msg) {
  console.error(msg)
  process.exit(1)
}

main().catch((err) => fail(err.stack || err.message))
