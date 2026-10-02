// Starting a session in a folder another quilt process is syncing: the error says which.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { describeOtherSync, runSession } from '../src/runner.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-busy-home-'))
process.env.HOME = home

/** A stand-in for another process's control API: alive, answering GET /info as `info`. */
function otherProcess (info) {
  const script = `
    const http = require('node:http')
    const s = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(${JSON.stringify(info)})) })
    s.listen(0, '127.0.0.1', () => console.log(s.address().port))
    setInterval(() => {}, 1000)`
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  const port = new Promise((resolve) => child.stdout.once('data', (d) => resolve(Number(String(d).trim()))))
  return { child, port, stop: () => child.kill('SIGKILL') }
}

test('an AI agent syncing the folder from its MCP server is named, and a dead process is not', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-busy-'))
  fs.mkdirSync(path.join(dir, '.quilt'))
  const other = otherProcess({ name: 'Claude', kind: 'agent', dir })
  t.after(() => other.stop())
  fs.writeFileSync(path.join(dir, '.quilt', 'daemon.json'), JSON.stringify({ port: await other.port, token: 't', pid: other.child.pid }))

  const msg = await describeOtherSync(dir)
  assert.match(msg, /^This folder is already being synced by another quilt process: your AI agent "Claude" joined it from its tool's quilt MCP server \(process \d+\)\. Ask the agent to leave with quilt_leave_session, or close that tool, then rejoin here\.$/)
  await assert.rejects(
    runSession({ dir, conn: { server: 'ws://127.0.0.1:1', room: 'r', secret: 's' }, name: 'me', tool: 'Cursor' }),
    { message: msg })

  other.stop()
  await new Promise((r) => other.child.once('exit', r))
  assert.equal(await describeOtherSync(dir), null, 'a stale daemon.json from a process that is gone does not count')
})

test('a `quilt join` in a terminal, and any other quilt process', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-busy-'))
  fs.mkdirSync(path.join(dir, '.quilt'))
  const other = otherProcess({ name: 'Mo', kind: 'human', dir })
  t.after(() => other.stop())
  fs.writeFileSync(path.join(dir, '.quilt', 'daemon.json'), JSON.stringify({ port: await other.port, token: 't', pid: other.child.pid }))
  assert.match(await describeOtherSync(dir), /another quilt process \(\d+\) is syncing it as "Mo"\. Stop that one first, then rejoin here\.$/)

  const procs = path.join(home, '.quilt', 'procs')
  fs.mkdirSync(procs, { recursive: true })
  fs.writeFileSync(path.join(procs, `${other.child.pid}.json`), JSON.stringify({ pid: other.child.pid, kind: 'sync', dir, startedAt: Date.now() }))
  assert.match(await describeOtherSync(dir), /a `quilt join` in a terminal \(process \d+\) is syncing it as "Mo"\. Stop that one \(Ctrl-C there, or `quilt stop`\), then rejoin here\.$/)

  fs.writeFileSync(path.join(procs, `${other.child.pid}.json`), JSON.stringify({ pid: other.child.pid, kind: 'app', startedAt: Date.now() }))
  assert.match(await describeOtherSync(dir), /another copy of the Quilt app \(process \d+\) has it open\. Leave it there, or quit that app, then rejoin here\.$/)
})
