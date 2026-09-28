// End-to-end check of the website: Chromium + a CLI user through a real relay.
// Needs Playwright with Chromium installed globally (npm i -g playwright).
// Run: npm run build && node scripts/e2e-web.mjs [screenshot-dir]
// The browser's private file system stands in for a picked folder (?testfolder=).
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), '..')
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'elegy-shots-'))
fs.mkdirSync(OUT, { recursive: true })
const require = createRequire(execSync('npm root -g').toString().trim() + '/')
const { chromium } = require('playwright')
const { startServer } = await import(`${REPO}/src/server.js`)
const { Session } = await import(`${REPO}/src/session.js`)
const { decodeInvite } = await import(`${REPO}/src/runner.js`)

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `e2e-${n}-`))
const read = (d, r) => { try { return fs.readFileSync(path.join(d, r), 'utf8') } catch { return null } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor (fn, label, ms = 10000) {
  const t = Date.now()
  while (Date.now() - t < ms) { if (await fn()) return; await sleep(100) }
  throw new Error(`timed out: ${label}`)
}
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) process.exitCode = 1 }

const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {} })
const base = `http://127.0.0.1:${srv.port}`
const browser = await chromium.launch()
const errors = []

// OPFS helpers run inside the page.
const opfsWrite = (page, dir, rel, text) => page.evaluate(async ([dir, rel, text]) => {
  let d = await (await navigator.storage.getDirectory()).getDirectoryHandle(dir, { create: true })
  const parts = rel.split('/'); const name = parts.pop()
  for (const p of parts) d = await d.getDirectoryHandle(p, { create: true })
  const w = await (await d.getFileHandle(name, { create: true })).createWritable(); await w.write(text); await w.close()
}, [dir, rel, text])
const opfsRead = (page, dir, rel) => page.evaluate(async ([dir, rel]) => {
  try {
    let d = await (await navigator.storage.getDirectory()).getDirectoryHandle(dir)
    const parts = rel.split('/'); const name = parts.pop()
    for (const p of parts) d = await d.getDirectoryHandle(p)
    return await (await (await d.getFileHandle(name)).getFile()).text()
  } catch { return null }
}, [dir, rel])

// ---- 1. Wendy shares a folder from the website (desktop, light) ----
const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme: 'light' })
const page = await ctx.newPage()
page.on('pageerror', (e) => errors.push(`page: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
await page.goto(`${base}/?testfolder=proj1`)
await opfsWrite(page, 'proj1', 'README.md', '# Weather app\n')
await opfsWrite(page, 'proj1', 'src/app.js', 'console.log("hi")\n')
await opfsWrite(page, 'proj1', 'node_modules/big/index.js', 'ignored')
await page.reload()
await page.fill('#name', 'Wendy')
await page.click('[data-tool="Cursor"]')
await page.screenshot({ path: `${OUT}/1-home.png` })
await page.click('#share')
await page.waitForSelector('dialog.modal[open]')
await page.screenshot({ path: `${OUT}/2-invite.png` })
const link = await page.inputValue('dialog.modal input')
check(link.startsWith(`${base}/#`), 'invite link is the site address + #code')

// ---- 2. Carl joins with the link from the CLI ----
const carlDir = tmp('carl')
const conn = decodeInvite(link)
const carl = new Session({ dir: carlDir, ...conn, name: 'Carl', tool: 'Claude Code' })
await carl.start({ waitTimeoutMs: 5000 })
check(read(carlDir, 'README.md') === '# Weather app\n' && read(carlDir, 'src/app.js') === 'console.log("hi")\n', 'CLI received the browser folder')
check(read(carlDir, 'node_modules/big/index.js') === null, 'node_modules not synced')

fs.writeFileSync(path.join(carlDir, 'forecast.js'), 'export const sunny = true\n')
await waitFor(async () => (await opfsRead(page, 'proj1', 'forecast.js')) === 'export const sunny = true\n', 'CLI file reaches browser folder')
check(true, 'CLI -> browser folder')
await opfsWrite(page, 'proj1', 'README.md', '# Weather app\n\nNow with forecasts.\n')
await waitFor(() => read(carlDir, 'README.md') === '# Weather app\n\nNow with forecasts.\n', 'browser edit reaches CLI')
check(true, 'browser folder -> CLI (polling)')

// Carl's AI activity and a chat message
carl.setAgentState({ tool: 'Claude Code', status: 'working' })
carl.pushAgentEntries([
  { id: 'p1', tool: 'Claude Code', conv: 'c', kind: 'prompt', text: 'Add a 5-day forecast view under the current weather.' },
  { id: 'r1', tool: 'Claude Code', conv: 'c', kind: 'reply', text: "I'll add a Forecast component and fetch the 5-day data from the API." },
  { id: 'a1', tool: 'Claude Code', conv: 'c', kind: 'action', text: 'Read src/app.js' },
  { id: 'a2', tool: 'Claude Code', conv: 'c', kind: 'action', text: 'Created src/Forecast.js' },
  { id: 'a3', tool: 'Claude Code', conv: 'c', kind: 'action', text: 'Ran npm test' }
])
carl.say('hey! I\'m adding the forecast, can you take the styling?')
await page.click('dialog.modal #close')
await page.waitForSelector('.fe.action')
await waitFor(async () => (await page.textContent('#people')).includes('Carl'), 'Carl shows as online')
await page.fill('#msg', 'sure, on it')
await page.click('#say button')
await waitFor(() => carl.messages({ markRead: false }).some((m) => m.text === 'sure, on it' && m.by === 'Wendy'), 'browser chat reaches CLI')
check(true, 'chat both ways')
check((await page.textContent('#people')).includes('Claude Code working'), 'partner AI status shown')
await sleep(300)
await page.screenshot({ path: `${OUT}/3-session.png` })

// ---- 3. Jo opens the same link on a phone, dark mode, and joins ----
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true })
const p2 = await phone.newPage()
p2.on('pageerror', (e) => errors.push(`phone page: ${e.message}`))
const hash = link.slice(link.indexOf('#'))
await p2.goto(`${base}/?testfolder=proj2${hash}`)
await p2.waitForSelector('#join')
await p2.fill('#name', 'Jo')
await p2.screenshot({ path: `${OUT}/4-join-phone-dark.png` })
await p2.click('#join')
await p2.waitForSelector('#people')
await waitFor(async () => (await opfsRead(p2, 'proj2', 'forecast.js')) === 'export const sunny = true\n', 'second browser receives files')
check(true, 'a second browser user joins from the link')
await waitFor(async () => (await p2.textContent('#people')).includes('Wendy') && (await p2.textContent('#people')).includes('Carl'), 'everyone visible')
await sleep(300)
await p2.screenshot({ path: `${OUT}/5-session-phone-dark.png`, fullPage: false })
const overflow = await p2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
check(!overflow, 'no horizontal scroll at phone width')

// ---- 4. Reload: the session is remembered and resumes ----
await page.goto(`${base}/?testfolder=proj1`)
await page.waitForSelector('[data-resume]')
await page.screenshot({ path: `${OUT}/6-home-recent.png` })
fs.writeFileSync(path.join(carlDir, 'while-away.txt'), 'hello again\n')
await page.click('[data-resume]')
await page.waitForSelector('#people')
await waitFor(async () => (await opfsRead(page, 'proj1', 'while-away.txt')) === 'hello again\n', 'resume catches up')
check(true, 'resume after reload catches up')

check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
await carl.stop()
await browser.close()
await srv.close()
console.log(`screenshots: ${OUT}`)
