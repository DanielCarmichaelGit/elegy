// Summaries of your AI chat, made on your computer before anything is
// shared: your prompts and your AI's replies become a sentence or two. Uses
// the Claude Code CLI (`claude -p`) when it's installed and signed in, and
// falls back to shortening the text when it isn't.
import { spawn } from 'node:child_process'
import os from 'node:os'

const INSTRUCTIONS = {
  prompt: 'Summarize this request a developer gave their AI coding assistant in one plain sentence of at most 20 words. Output only the sentence.',
  reply: 'Summarize this reply from an AI coding assistant in one or two plain sentences, at most 35 words in total. Mention files or decisions if there are any. Output only the summary.'
}
const SHORT_ENOUGH = 140 // characters: already short, share as is
const TIMEOUT_MS = 45000
const RETRY_AFTER_MS = 10 * 60 * 1000 // after the CLI fails, shorten instead for a while

/** The first sentence (or first `max` characters) of text. */
export function shorten (text, max = 160) {
  const flat = String(text || '').replace(/```[\s\S]*?```/g, ' [code] ').replace(/\s+/g, ' ').trim()
  const sentence = flat.match(/^.*?[.!?](\s|$)/)
  const first = sentence && sentence[0].length >= 20 ? sentence[0].trim() : flat
  if (first.length <= max) return first
  const cut = first.slice(0, max - 1)
  return `${cut.slice(0, cut.lastIndexOf(' ') > max / 2 ? cut.lastIndexOf(' ') : cut.length).replace(/[\s,;:]+$/, '')}…`
}

/** Runs a command with text on stdin (in a temp folder, so it never shows up as a chat in the project). */
function runCli (cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: os.tmpdir(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timed out')) }, TIMEOUT_MS)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error(`${cmd} is not installed`) : e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && out.trim()) resolve(out.trim())
      else reject(new Error((err || out).trim().split('\n').pop() || `${cmd} exited with ${code}`))
    })
    child.stdin.end(input)
  })
}

/** The summarizing command: COWOVE_SUMMARY_CMD (for tests or other tools) or Claude Code's CLI. */
function command (kind) {
  const custom = process.env.COWOVE_SUMMARY_CMD
  if (custom) {
    const [cmd, ...args] = custom.split(' ').filter(Boolean)
    return [cmd, [...args, INSTRUCTIONS[kind]]]
  }
  return ['claude', ['-p', '--model', 'haiku', '--no-session-persistence', INSTRUCTIONS[kind]]]
}

/**
 * Returns summarize(kind, text) -> Promise<{ text, how: 'ai'|'shortened'|'as-is' }>.
 * `onWarn` hears (once per failure spell) why summaries fell back to shortening.
 */
export function createSummarizer ({ onWarn = () => {}, run = runCli } = {}) {
  let brokenUntil = 0
  return async function summarize (kind, text) {
    text = String(text || '')
    if (!INSTRUCTIONS[kind]) return { text, how: 'as-is' }
    if (text.length <= SHORT_ENOUGH) return { text, how: 'as-is' }
    if (Date.now() >= brokenUntil) {
      try {
        const [cmd, args] = command(kind)
        const out = await run(cmd, args, text.slice(0, 20000))
        return { text: out.replace(/\s+/g, ' ').trim().slice(0, 400), how: 'ai' }
      } catch (err) {
        brokenUntil = Date.now() + RETRY_AFTER_MS
        onWarn(/auth|log ?in|sign ?in|OAuth/i.test(err.message)
          ? 'Summaries are shortened for now: your claude CLI isn\'t signed in (run `claude` once in a terminal to sign in).'
          : `Summaries are shortened for now: ${err.message}`)
      }
    }
    return { text: shorten(text), how: 'shortened' }
  }
}
