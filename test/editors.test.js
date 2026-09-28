import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installedEditors, openCommand, claudeCli, claudeSessionCommand } from '../src/editors.js'

const mac = (apps) => ({ platform: 'darwin', home: '/Users/me', exists: (p) => apps.includes(p) })

test('only installed apps are offered, from /Applications or ~/Applications', () => {
  const opts = mac(['/Applications/Claude.app', '/Users/me/Applications/Cursor.app'])
  assert.deepEqual(installedEditors(opts).map((e) => e.id), ['claude', 'cursor'])
})

test('Claude opens a new Claude Code session on the folder', () => {
  const [file, args] = openCommand('claude', '/Users/me/My Project', mac(['/Applications/Claude.app']))
  assert.equal(file, 'open')
  assert.deepEqual(args, ['claude://code/new?folder=%2FUsers%2Fme%2FMy%20Project'])
})

test('Cursor opens a classic window on the folder, not its Agents window', () => {
  const [file, args] = openCommand('cursor', '/Users/me/p', mac(['/Applications/Cursor.app']))
  assert.equal(file, '/Applications/Cursor.app/Contents/Resources/app/bin/cursor')
  assert.deepEqual(args, ['--classic', '--new-window', '/Users/me/p'])
})

test('other apps get the folder handed to them', () => {
  const [file, args] = openCommand('zed', '/Users/me/p', mac(['/Applications/Zed.app']))
  assert.equal(file, 'open')
  assert.deepEqual(args, ['-a', '/Applications/Zed.app', '/Users/me/p'])
})

test('unknown or missing apps are refused', () => {
  assert.throws(() => openCommand('rm -rf', '/x', mac([])), /Unknown app/)
  assert.throws(() => openCommand('zed', '/x', mac([])), /isn't installed/)
})

test('the Claude CLI is found on its own, or inside the Claude app', () => {
  const home = '/Users/me'
  const base = { platform: 'darwin', home, readdir: () => ['2.1.9', '2.1.281'] }
  assert.equal(claudeCli({ ...base, exists: (p) => p === '/Users/me/.local/bin/claude' }), '/Users/me/.local/bin/claude')
  const bundled = '/Users/me/Library/Application Support/Claude/claude-code/2.1.281/claude.app/Contents/MacOS/claude'
  assert.equal(claudeCli({ ...base, exists: (p) => p === bundled || p.includes('2.1.9/') }), bundled)
  assert.equal(claudeCli({ ...base, exists: () => false }), null)
})

test('a Claude session is made in the folder with a free local command', () => {
  const [file, args, opts] = claudeSessionCommand('/bin/claude', '/Users/me/Panorama', 'abc')
  assert.equal(file, '/bin/claude')
  assert.deepEqual(args, ['-p', '/rename Panorama (cowove)', '--session-id', 'abc'])
  assert.deepEqual(opts, { cwd: '/Users/me/Panorama' })
})
